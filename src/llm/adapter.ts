/**
 * The VibeDev gateway behind the Harness LLM seam.
 *
 * Shaped after `@deepseek-ai/dsh-llm-pi-ai`'s adapter (src/adapter.ts,
 * dsh-v0.2.0-rc.2): one immutable snapshot per catalog, captured before an
 * operation's first await, so a catalog refresh mid-reply only affects the next
 * step. What differs is what a gateway needs:
 *
 * - one route serves every protocol, each model naming its own (see models.ts);
 * - the credential is the account's access token (or a development key), sent
 *   as `Authorization: Bearer` on every protocol;
 * - Anthropic requests carry `metadata.user_id = {device_id, session_id}` and
 *   OpenAI requests `session_id` and `prompt_cache_key`, which is how the gateway
 *   keeps one session on one upstream account so its prompt cache keeps hitting;
 * - "off" is spelled out where the catalog offers `none`, and Responses drops
 *   `temperature` while reasoning;
 * - a 401 hands the credential back to its owner and, when the owner renewed it,
 *   sends the request once more; failures carry this plugin's own codes
 *   (`VIBEDEV_SIGN_IN_REQUIRED`, `VIBEDEV_INSUFFICIENT_BALANCE`) because the
 *   Harness's account codes raise the DeepSeek account's prompts.
 *
 * Ported from the VibeDev app's `@vibedev/dsh-llm-gateway` (vibedev-app
 * f08333ee7f), where the same models sit on the app's own account channel.
 *
 * @module dsh-vibedev/llm/adapter
 */

import type { Api, Model, Models, ModelThinkingLevel, MutableModels, ProviderResponse, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ProviderRequestId,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { startingReasoning } from './catalog.js'
import type { GatewayModel, GatewayReasoningLevel } from './catalog.js'
import { toPiContext } from './context.js'
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './limits.js'
import { createModels, gatewayProvider, getSupportedThinkingLevels, toPiModel } from './models.js'
import { toStreamChunks } from './stream.js'

/** The credential for one request. */
export interface GatewayCredential {
  readonly token: string
  /**
   * `account`: the host app's VibeDev account (the VibeDev app); `plugin`: this
   * plugin's own sign-in; `key`: a development key. Account and plugin tokens
   * go back to their owner on a 401; a development key does not.
   */
  readonly kind: 'account' | 'plugin' | 'key'
}

/**
 * Failure code for "no VibeDev sign-in": deliberately not the Harness's
 * `ACCOUNT_SIGN_IN_REQUIRED`, which belongs to the DeepSeek account and would
 * raise its sign-in prompt; the chat shows this failure's own message.
 */
export const SIGN_IN_REQUIRED_CODE = 'VIBEDEV_SIGN_IN_REQUIRED'
/** Failure code for a used-up balance; not the Harness's `ACCOUNT_QUOTA`, which opens the DeepSeek top-up. */
export const INSUFFICIENT_BALANCE_CODE = 'VIBEDEV_INSUFFICIENT_BALANCE'

/** What a person reads when a VibeDev model is used before signing in. */
export const SIGN_IN_MESSAGE = '请先登录 VibeDev：在侧边栏底部「登录 VibeDev」或「设置 → VibeDev 账号」中登录后即可使用这些模型。'
  + ' Sign in to VibeDev (sidebar, or Settings → VibeDev account) to use these models.'
/** What a person reads when the gateway ended the sign-in and a refresh could not renew it. */
export const SESSION_ENDED_MESSAGE = 'VibeDev 登录已失效，请重新登录（侧边栏底部或「设置 → VibeDev 账号」）。'
  + ' Your VibeDev sign-in has ended; sign in again.'

/**
 * What a person reads on a used-up balance.
 * @param origin - the gateway origin, whose `/purchase` page tops up.
 * @returns the message.
 */
export function balanceMessage(origin: string): string {
  return `VibeDev 余额不足，充值后即可继续：${origin}/purchase · Your VibeDev balance is used up; top up at ${origin}/purchase`
}

/** Constructor options for {@link GatewayAdapter}. */
export interface GatewayAdapterOptions {
  /** The route key the adapter registers under. */
  readonly provider: string
  /** The name selectors show for the route. */
  readonly displayName: string
  /** The gateway origin, read per snapshot. */
  readonly origin: () => string
  /** The current catalog; a new array identity means a new catalog. */
  readonly catalog: () => readonly GatewayModel[]
  /**
   * Read the catalog again because it is empty when models are listed, so a catalog read that missed a
   * fresh sign-in, or failed on a flaky network, recovers on the next list instead of the next timer.
   */
  readonly refreshCatalog?: () => Promise<void>
  /** The credential for one request, or undefined when nobody is signed in and no key is configured. */
  readonly resolveCredential: () => Promise<GatewayCredential | undefined>
  /** Hand a credential the gateway rejected back to its owner, which refreshes it or signs out. */
  readonly rejectCredential?: (credential: GatewayCredential) => Promise<void>
  /** A stable device id for Anthropic session affinity. */
  readonly deviceId?: () => Promise<string | undefined>
  readonly retryPolicy?: () => ResolvedRetryPolicy | undefined
  readonly streamIdleTimeoutMs?: number
  readonly cacheRetention?: 'none' | 'short' | 'long'
  readonly resolveAttachments?: () => AttachmentStore | undefined
  readonly resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  readonly onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** One catalog's frozen view: the catalog, its index, and the collection built from it. */
interface GatewaySnapshot {
  readonly catalog: readonly GatewayModel[]
  readonly origin: string
  readonly byId: ReadonlyMap<string, GatewayModel>
  readonly models: Models
}

/** The Harness effort id for a catalog level: the catalog's `none` is the Harness's `off`. */
function effortOf(level: GatewayReasoningLevel): ModelThinkingLevel {
  return level === 'none' ? 'off' : level
}

/**
 * Validate an explicit effort against the model, without pi-ai's clamp.
 * @param model - the pi-ai descriptor.
 * @param effort - the requested effort, if any.
 * @returns the effort, or undefined when none was requested.
 */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined || !model.reasoning) return undefined
  if (getSupportedThinkingLevels(model).some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(`VibeDev model "${model.id}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

/** The Harness reasoning description for one model, or nothing when it offers no levels. */
function reasoningInfo(model: Model<Api>, catalog: GatewayModel): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  const starting = startingReasoning(catalog)
  return {
    reasoning: {
      efforts: levels.map(level => ({ id: ReasoningEffortId(level), name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` })),
      ...starting === undefined ? {} : { defaultEffort: ReasoningEffortId(effortOf(starting)) },
    },
  }
}

/** A JSON object payload pi-ai is about to send, or undefined for anything else. */
function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
}

/**
 * The gateway as an LLM adapter. Each operation reads the current catalog, so a refresh reaches
 * the next request without a restart, while a request in flight finishes on the catalog it began with.
 */
export class GatewayAdapter extends LlmAdapter {
  private snapshot: GatewaySnapshot | undefined

  constructor(private readonly config: GatewayAdapterOptions) {
    super()
  }

  private current(): GatewaySnapshot {
    const catalog = this.config.catalog()
    const origin = this.config.origin()
    if (this.snapshot?.catalog === catalog && this.snapshot.origin === origin) return this.snapshot
    const models: MutableModels = createModels()
    const piModels = catalog.map(model => toPiModel(model, this.config.provider, origin))
    models.setProvider(gatewayProvider({ id: this.config.provider, name: this.config.displayName, models: piModels }))
    this.snapshot = { catalog, origin, byId: new Map(catalog.map(model => [model.id, model])), models }
    return this.snapshot
  }

  private assertOwned(provider: string): void {
    if (provider !== this.config.provider) throw new LlmError(`VibeDev gateway adapter does not own provider "${provider}"`, 'NO_ADAPTER')
  }

  private modelOf(snapshot: GatewaySnapshot, provider: string, id: string): { model: Model<Api>; catalog: GatewayModel } {
    this.assertOwned(provider)
    // No catalog yet means no credential yet: the model the session names is fine, the sign-in is missing.
    if (snapshot.catalog.length === 0) throw new LlmError(SIGN_IN_MESSAGE, SIGN_IN_REQUIRED_CODE)
    const catalog = snapshot.byId.get(id)
    const model = snapshot.models.getModel(provider, id)
    if (catalog === undefined || model === undefined) throw new LlmError(`VibeDev has no model "${id}"`, 'UNKNOWN_MODEL')
    return { model, catalog }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.displayName }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return provider === this.config.provider ? this.config.retryPolicy?.() : undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertOwned(provider)
    if (this.current().catalog.length === 0) await this.config.refreshCatalog?.()
    return this.current().models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => this.modelInfo(this.current(), provider, model))
  }

  private modelInfo(snapshot: GatewaySnapshot, provider: string, id: string): LlmResolvedModelInfo {
    const { model, catalog } = this.modelOf(snapshot, provider, id)
    return {
      provider,
      id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...reasoningInfo(model, catalog),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(options: GenerateOptions, snapshot: GatewaySnapshot): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) throw new LlmError('the VibeDev gateway adapter does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    const { model, catalog } = this.modelOf(snapshot, options.provider, options.model)
    const starting = startingReasoning(catalog)
    const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? (starting === undefined ? undefined : effortOf(starting)))
    let credential = await this.config.resolveCredential()
    if (credential === undefined) throw new LlmError(SIGN_IN_MESSAGE, SIGN_IN_REQUIRED_CODE)
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const deviceId = model.api === 'anthropic-messages' && sessionId !== undefined ? await this.config.deviceId?.() : undefined

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`VibeDev model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
          requestImagePolicy: { maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET, maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES },
        }, onReplayDegrade)
      const enabledReasoning: ThinkingLevel | undefined = reasoning === undefined || reasoning === 'off' ? undefined : reasoning
      const offersNone = catalog.reasoningLevels?.includes('none') === true
      // A 401 that arrives before anything reached the caller is sent once more with the token the
      // credential's owner renewed: an access token can expire or rotate between being read and
      // reaching the gateway. Anything already yielded is never repeated.
      for (let attempt = 0; ; attempt++) {
        const token = credential.token
        let response: ProviderResponse | undefined
        // pi-ai reports a failed request only as text, and calls `onResponse` for successful ones alone;
        // wrapping fetch sees every response, so a failure keeps its status and request id.
        const observingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
          const received = await fetch(input, init)
          response = { status: received.status, headers: Object.fromEntries(received.headers.entries()) }
          return received
        }
        const attemptStop = new AbortController()
        const requestOptions: SimpleStreamOptions = {
          apiKey: token,
          ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
          cacheRetention: this.config.cacheRetention ?? 'short',
          // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
          maxRetries: 0,
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          ...sessionId === undefined ? {} : { sessionId },
          ...deviceId !== undefined && sessionId !== undefined
            ? { metadata: { user_id: JSON.stringify({ device_id: deviceId, session_id: sessionId }) } }
            : {},
          signal: AbortSignal.any([watchdog.signal, attemptStop.signal]),
          headers: {
            ...model.api === 'anthropic-messages' ? { 'x-api-key': null } : {},
            ...model.api !== 'anthropic-messages' && sessionId !== undefined ? { session_id: sessionId } : {},
            authorization: `Bearer ${token}`,
            ...attributionHeaders(),
          },
          onPayload: payload => this.shapePayload(payload, model, {
            ...sessionId === undefined ? {} : { sessionId },
            off: reasoning === 'off' && offersNone,
            reasoning: enabledReasoning !== undefined,
          }),
          fetch: observingFetch,
          onResponse: (received) => { response ??= received },
        }
        const events = snapshot.models.streamSimple(model, context, requestOptions)
        const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
        let exhausted = false
        let yielded = false
        let renewed: GatewayCredential | undefined
        // Usage reported ahead of any content (a failed request reports its zero usage first) waits
        // here, so a request sent again does not leave the refused attempt's usage behind.
        const held: StreamChunk[] = []
        try {
          while (true) {
            const result = await watchdog.next(iterator)
            const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
            if (timeout !== undefined) throw timeout
            if (result.done) {
              for (const early of held.splice(0)) yield early
              exhausted = true
              return
            }
            const chunk = result.value
            if (!yielded) {
              if (chunk.type === 'usage') {
                held.push(chunk)
                continue
              }
              if (isUnauthorized(chunk, response)) {
                if (attempt === 0) {
                  renewed = await this.renew(credential)
                  if (renewed !== undefined) break
                } else {
                  // The renewed token was refused too: let the owner sort the session out (it signs out when the gateway ended it).
                  void this.config.rejectCredential?.(credential).catch(() => undefined)
                }
              }
              for (const early of held.splice(0)) yield early
              yielded = true
            }
            yield this.accountFailure(chunk, response, snapshot.origin)
          }
        } finally {
          if (!exhausted) {
            attemptStop.abort('gateway attempt stopped')
            try {
              await iterator.return(undefined)
            } catch (_abortedSdkTeardown) {
              // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
            }
          }
        }
        if (renewed === undefined) return
        credential = renewed
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`VibeDev stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('VibeDev request aborted by caller', 'ABORTED', { cause: error })
      throw error
    } finally {
      consumer.abort('gateway stream consumer stopped')
    }
  }

  /**
   * Fit pi-ai's payload to the gateway: Chat Completions gets the session's cache key (pi-ai sends it
   * only to api.openai.com), "off" is spelled out where the catalog offers `none`, and Responses
   * drops `temperature` while reasoning, which reasoning models refuse.
   */
  private shapePayload(
    payload: unknown,
    model: Model<Api>,
    request: { sessionId?: string; off: boolean; reasoning: boolean },
  ): unknown {
    const body = objectPayload(payload)
    if (body === undefined) return undefined
    const shaped: Record<string, unknown> = { ...body }
    switch (model.api) {
      case 'openai-completions':
        if (request.sessionId !== undefined && shaped.prompt_cache_key === undefined) shaped.prompt_cache_key = request.sessionId
        if (request.off && model.id.toLowerCase().startsWith('deepseek')) {
          shaped.thinking = { type: 'disabled' }
          delete shaped.reasoning_effort
        } else if (request.off) {
          shaped.reasoning_effort = 'none'
        }
        break
      case 'openai-responses':
        if (request.off) shaped.reasoning = { ...objectPayload(shaped.reasoning), effort: 'none' }
        if (request.reasoning || request.off) delete shaped.temperature
        break
      case 'anthropic-messages':
        break
      default:
        // The catalog only ever names the three protocols above.
        break
    }
    return shaped
  }

  /**
   * Hand a refused credential back to its owner (which refreshes it, or signs out when the gateway
   * ended the session) and return the credential that replaced it, if one did.
   * @param credential - the credential the gateway answered 401 to.
   * @returns a credential with a different token, or undefined when there is none to try.
   */
  private async renew(credential: GatewayCredential): Promise<GatewayCredential | undefined> {
    if (credential.kind === 'key') return undefined
    try {
      await this.config.rejectCredential?.(credential)
    } catch (_refreshFailed) {
      return undefined
    }
    const next = await this.config.resolveCredential().catch(() => undefined)
    return next !== undefined && next.token !== credential.token ? next : undefined
  }

  /**
   * Turn a failed finish into the VibeDev failure the gateway status names: 402 is the balance
   * (with the top-up page), 401 a sign-in that has ended. Both carry this plugin's own codes and
   * messages, so the chat shows them instead of the DeepSeek account's prompts.
   */
  private accountFailure(chunk: StreamChunk, response: ProviderResponse | undefined, origin: string): StreamChunk {
    if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
    const status = response?.status
    const requestId = response?.headers['x-request-id'] ?? response?.headers['request-id']
    const failure: LlmFailure = chunk.reason.failure
    const located: LlmFailure = {
      ...failure,
      ...status === undefined || status < 400 ? {} : { status },
      ...requestId === undefined ? {} : { requestId: requestId as ProviderRequestId },
    }
    if (status === 402 || failure.code === QUOTA_EXCEEDED_CODE) {
      return { ...chunk, reason: { kind: 'error', failure: { ...located, code: INSUFFICIENT_BALANCE_CODE, message: balanceMessage(origin) } } }
    }
    if (status === 401) {
      return { ...chunk, reason: { kind: 'error', failure: { ...located, code: SIGN_IN_REQUIRED_CODE, message: SESSION_ENDED_MESSAGE } } }
    }
    return { ...chunk, reason: { kind: 'error', failure: located } }
  }
}

/** Whether a chunk is the gateway refusing the credential (an error finish on an HTTP 401). */
function isUnauthorized(chunk: StreamChunk, response: ProviderResponse | undefined): boolean {
  return chunk.type === 'finish' && chunk.reason.kind === 'error' && response?.status === 401
}
