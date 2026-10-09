/**
 * HTTP client for the VibeDev gateway. Every gateway call goes through here so
 * authentication, refresh after a 401, balance refusals, busy back-off and
 * idempotency are handled once.
 *
 * The credential is attached only to requests on the gateway origin: upload
 * URLs and third-party links never see it.
 * @module dsh-vibedev/gateway/http
 */

import { MediaError, gatewayWords, parseGatewayFailure, retryAfterMs } from './errors.js'
import type { GatewayFailure } from './errors.js'

/** The credential one request carries. */
export interface GatewayCredential {
  readonly token: string
  /**
   * Where it came from: the host's VibeDev account (`account`), the plugin's own
   * sign-in (`plugin`), or a development key from the environment (`key`). Only
   * account and plugin tokens can be refreshed after a 401.
   */
  readonly kind: 'account' | 'plugin' | 'key'
}

/** Construction options; `fetch` and `sleep` are test seams. */
export interface GatewayHttpOptions {
  /** Gateway origin, such as `https://vibedev.jzsaas.com`. */
  readonly origin: string
  /** The credential for the next request; undefined while nobody is signed in. */
  readonly resolveCredential: () => Promise<GatewayCredential | undefined>
  /** Report a token the gateway rejected, so its owner refreshes it. */
  readonly rejectToken?: (credential: GatewayCredential) => Promise<void>
  /** `User-Agent` for every request. */
  readonly userAgent: string
  readonly fetch?: typeof globalThis.fetch
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** One request. */
export interface GatewayRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** JSON body; serialized with `content-type: application/json`. */
  readonly json?: unknown
  /** Raw body (multipart form, bytes) when `json` is not used. */
  readonly body?: FormData | Uint8Array | string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Deadline for each attempt. */
  readonly timeoutMs?: number
  /** Sent as `Idempotency-Key`; makes a retried submission return the original task. */
  readonly idempotencyKey?: string
  /** Send without the credential (pre-signed upload URLs, public content links). */
  readonly anonymous?: boolean
  /** Retries after a busy answer (429, or 503 with a busy code or `Retry-After`). Defaults to 2. */
  readonly busyRetries?: number
  /** Longest single wait for a busy answer; a longer `Retry-After` fails at once. Defaults to 15 s. */
  readonly maxBusyWaitMs?: number
}

/** Error codes the gateway uses for "full right now, nothing was charged". */
const BUSY_CODES = new Set([
  'APP_TOKEN_UNAVAILABLE', 'PROVIDER_CAPACITY_BUSY', 'upstream_capacity_busy', 'AUDIO_CAPACITY_BUSY',
  'AUDIO_NO_AVAILABLE_ACCOUNT', 'WEB_SEARCH_BUSY', 'WEB_SEARCH_RATE_LIMITED',
])

/**
 * The account already runs as many video or audio tasks as it may (HTTP 429).
 * Not retried here: a slot frees only when one of the user's tasks finishes.
 */
const TASK_LIMIT_CODES = new Set(['VIDEO_TASK_LIMIT_REACHED', 'AUDIO_TASK_LIMIT_REACHED'])

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_BUSY_WAIT_MS = 2_000

/** The message for a call made while nobody is signed in. */
export const SIGN_IN_MESSAGE = 'VibeDev media generation needs a signed-in VibeDev account. '
  + 'Call media_account with action "sign_in": it opens the VibeDev sign-in page in the user\'s browser, where new users can also register. '
  + 'In the VibeDev app, the account signed in to the app is used automatically.'

/** Read through a call so a check made before an `await` is not taken as still true after it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAborted(signal)) { reject(abortError(signal)); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(abortError(signal)) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal?: AbortSignal): MediaError {
  return new MediaError('The media request was cancelled.', 'ABORTED', { retryable: true }, { cause: signal?.reason })
}

/** Gateway HTTP client. */
export class GatewayHttp {
  readonly origin: string

  /**
   * @param options - origin, credential plane, user agent and test seams.
   */
  constructor(private readonly options: GatewayHttpOptions) {
    this.origin = options.origin.trim().replace(/\/+$/, '')
  }

  /** Absolute URL for a gateway path, or the URL itself when already absolute. */
  url(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${this.origin}${path.startsWith('/') ? '' : '/'}${path}`
  }

  /** Whether a URL is on the gateway origin, and so may carry the credential. */
  isGatewayUrl(url: string): boolean {
    try { return new URL(url).origin === new URL(this.origin).origin } catch { return false }
  }

  /**
   * Send one request and return the successful response.
   * @param path - gateway path, or an absolute URL.
   * @param request - method, body, headers and retry policy.
   * @returns the 2xx response, body unread.
   * @throws {@link MediaError} for every refusal, with the gateway's code.
   */
  async send(path: string, request: GatewayRequest = {}): Promise<Response> {
    const url = this.url(path)
    const authenticate = request.anonymous !== true && this.isGatewayUrl(url)
    let credential = authenticate ? await this.credential() : undefined
    let refreshed = false
    let busyRetries = request.busyRetries ?? 2
    for (;;) {
      const response = await this.attempt(url, request, credential)
      if (response.ok) return response
      const failure = parseGatewayFailure(await response.clone().json().catch(() => undefined))
      if (response.status === 401 && credential !== undefined && credential.kind !== 'key' && !refreshed) {
        refreshed = true
        await this.options.rejectToken?.(credential)
        credential = await this.credential()
        continue
      }
      const wait = retryAfterMs(response.headers.get('retry-after'))
      if (isBusy(response.status, failure, wait) && busyRetries > 0 && (wait ?? DEFAULT_BUSY_WAIT_MS) <= (request.maxBusyWaitMs ?? 15_000)) {
        busyRetries--
        await (this.options.sleep ?? delay)(wait ?? DEFAULT_BUSY_WAIT_MS, request.signal)
        continue
      }
      throw failureError(response.status, failure, wait)
    }
  }

  /**
   * Send one request and parse its JSON body.
   * @param path - gateway path, or an absolute URL.
   * @param request - method, body, headers and retry policy.
   * @returns the parsed body.
   */
  async json<T = unknown>(path: string, request: GatewayRequest = {}): Promise<T> {
    const response = await this.send(path, request)
    try {
      return await response.json() as T
    } catch (error) {
      throw new MediaError(`The VibeDev gateway returned an unreadable answer for ${path}.`, 'GATEWAY_BAD_RESPONSE',
        { status: response.status }, { cause: error })
    }
  }

  private async credential(): Promise<GatewayCredential> {
    const credential = await this.options.resolveCredential()
    if (credential === undefined) throw new MediaError(SIGN_IN_MESSAGE, 'NOT_SIGNED_IN')
    return credential
  }

  private async attempt(url: string, request: GatewayRequest, credential: GatewayCredential | undefined): Promise<Response> {
    if (isAborted(request.signal)) throw abortError(request.signal)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.options.userAgent,
      ...request.headers,
    }
    if (credential !== undefined) headers.authorization = `Bearer ${credential.token}`
    if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey
    let body: FormData | Uint8Array | string | undefined = request.body
    if (request.json !== undefined) {
      body = JSON.stringify(request.json)
      headers['content-type'] = 'application/json'
    }
    const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    try {
      return await (this.options.fetch ?? globalThis.fetch)(url, {
        method: request.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        ...body === undefined ? {} : { body: body as NonNullable<RequestInit['body']> },
        redirect: 'error',
        signal,
      })
    } catch (error) {
      if (isAborted(request.signal)) throw abortError(request.signal)
      if (timeout.aborted) {
        throw new MediaError(`The VibeDev gateway did not answer within ${Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s.`,
          'GATEWAY_TIMEOUT', { retryable: true })
      }
      throw new MediaError(`Could not reach the VibeDev gateway (${error instanceof Error ? error.message : String(error)}). `
        + 'Ask the user to check the network connection.', 'GATEWAY_UNREACHABLE', { retryable: true })
    }
  }
}

/**
 * Whether an answer means "full right now, nothing was charged": any 429 but a
 * task limit, or a 503 with a busy code or `Retry-After`. A bare 503 is an outage.
 */
function isBusy(status: number, failure: GatewayFailure, wait: number | undefined): boolean {
  if (failure.code !== undefined && TASK_LIMIT_CODES.has(failure.code)) return false
  return status === 429 || status === 503 && (failure.code !== undefined && BUSY_CODES.has(failure.code) || wait !== undefined)
}

/**
 * The error for an answer the client does not retry, worded for the model.
 * @param status - HTTP status.
 * @param failure - the parsed error body.
 * @param wait - Retry-After in milliseconds, when given.
 * @returns the error to throw.
 */
export function failureError(status: number, failure: GatewayFailure, wait?: number): MediaError {
  const words = gatewayWords(failure)
  const { code: _code, message: _message, ...facts } = failure
  const details = {
    status,
    ...facts,
    ...wait === undefined ? {} : { retryAfterMs: wait },
  }
  if (failure.code !== undefined && TASK_LIMIT_CODES.has(failure.code)) {
    const kind = failure.code.startsWith('VIDEO') ? 'video' : 'audio'
    const counts = failure.active === undefined || failure.limit === undefined ? '' : ` (${failure.active} of ${failure.limit})`
    return new MediaError(`The VibeDev account already runs as many ${kind} tasks at once as it may${counts}. `
      + `Wait for one of them to finish (media_tasks lists them), then submit again; nothing was charged.`,
    failure.code, { ...details, retryable: true })
  }
  if (status === 402) {
    const estimate = failure.estimatedCny === undefined
      ? ''
      : `: this task is estimated at ¥${failure.estimatedCny}${failure.availableCny === undefined ? '' : `, and ¥${failure.availableCny} is available`}`
        + `${failure.pendingCny === undefined || Number(failure.pendingCny) === 0 ? '' : ` (tasks in progress hold ¥${failure.pendingCny})`}`
    return new MediaError(`The VibeDev account balance is not enough for this request${estimate || words}. `
      + `Nothing was charged. Ask the user to top up their VibeDev balance${failure.rechargeUrl === undefined ? '' : ` at ${failure.rechargeUrl}`}.`,
    'INSUFFICIENT_BALANCE', { ...details, retryable: false })
  }
  if (status === 401) {
    return new MediaError(`The VibeDev gateway rejected the sign-in${words}. Ask the user to sign in to VibeDev again.`,
      'SIGN_IN_REJECTED', { ...details, retryable: false })
  }
  if (isBusy(status, failure, wait)) {
    const seconds = wait === undefined ? undefined : Math.ceil(wait / 1000)
    return new MediaError(`The VibeDev gateway is busy${words}. ${seconds === undefined ? 'Try again shortly' : `Try again in about ${seconds} s`}; `
      + 'nothing was charged.', failure.code ?? (status === 429 ? 'RATE_LIMITED' : 'GATEWAY_BUSY'), { ...details, retryable: true, busy: true })
  }
  return new MediaError(`The VibeDev gateway refused the request with HTTP ${status}${words}.`, failure.code ?? `HTTP_${status}`, details)
}
