/**
 * `GatewaySearchProvider`: a `WebSearchProvider` backed by the VibeDev gateway's
 * `POST /v1/vibedev/web-search`. The gateway returns titles, snippets and
 * publication dates, not page bodies (`web_fetch` reads pages), plus instant
 * answers, which become the result's `content`.
 *
 * The gateway asks clients to send searches one at a time and to wait as
 * `Retry-After` says, so the provider queues searches (`web_search` runs one
 * call's queries in parallel) and waits out short rate-limit and busy answers
 * before giving up. A token the gateway rejects is reported back to where it
 * came from, which renews it, and the search is retried once.
 *
 * Ported from the VibeDev app's own search package
 * (`@vibedev/dsh-web-search-gateway`, provider.ts); here the credential is the
 * plugin's (host account, its own sign-in, or a development key).
 * @module dsh-vibedev/search/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { GatewayCredential } from '../gateway/http.js'

/** Stable id the provider registers under; a profile selects it as `web.searchProvider`. */
export const GATEWAY_SEARCH_PROVIDER_ID = 'vibedev-gateway'

/** The gateway accepts 1–20 results per request. */
const MAX_RESULTS_LIMIT = 20

/** Wait applied to a rate-limited or busy answer that names no `Retry-After`. */
const DEFAULT_RETRY_MS = 1000

/** Where a signed-out user signs in, for the messages the model relays. */
const SIGN_IN_HINT = 'Ask the user to sign in to VibeDev (at the bottom of the sidebar, or in Settings → VibeDev account), then search again.'

/** What the provider needs from its plugin, plus test seams. */
export interface GatewaySearchOptions {
  /** Absolute URL of the gateway's web-search endpoint. */
  readonly endpoint: string
  /** The credential for the next request; undefined while nobody is signed in and no key is set. */
  readonly resolveCredential: () => Promise<GatewayCredential | undefined>
  /** Report a credential the gateway rejected, so its source renews it. */
  readonly rejectCredential?: (credential: GatewayCredential) => Promise<void>
  /** `User-Agent` sent with every request. */
  readonly userAgent: string
  /** Deadline for one HTTP request. */
  readonly requestTimeoutMs: number
  /** Retries after a rate-limited or busy answer. */
  readonly maxRetries: number
  /** Longest `Retry-After` waited out; a longer one fails the search at once. */
  readonly maxRetryWaitMs: number
  /** HTTP client; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Delay used for `Retry-After`; defaults to a timer that the search's signal cancels. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The parts of a gateway error body the provider reads: `{ error: { code, message, field } }`. */
interface SearchFailure {
  readonly code?: string
  readonly message?: string
  readonly field?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** The gateway's own words for a failure, for error messages: ` (CODE: message)`. */
function detail(failure: SearchFailure): string {
  const parts = [failure.code, failure.message].filter(part => part !== undefined)
  return parts.length === 0 ? '' : ` (${parts.join(': ')})`
}

function aborted(signal?: AbortSignal, cause?: unknown): WebError {
  return new WebError('VibeDev web search aborted', 'WEB_ABORTED', { cause: signal?.aborted === true ? signal.reason : cause })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/** Settle with `operation`, or reject as aborted as soon as `signal` fires. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(aborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    // The handlers stay attached after an abort, so a later rejection never goes unhandled.
    void operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() }), signal)
}

/**
 * Milliseconds a `Retry-After` header asks for: delta seconds or an HTTP date.
 * @param header - the header value, or null when absent.
 * @param now - the current epoch milliseconds, for an HTTP date.
 * @returns the wait, or undefined when the header is absent or unreadable.
 */
export function searchRetryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds)) return seconds < 0 ? undefined : Math.round(seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * The request body: the query and, when bounded, the result count within the gateway's limits.
 * Any other field makes the gateway answer 400.
 * @param request - the seam request.
 * @returns the JSON body.
 */
export function requestBody(request: WebSearchRequest): string {
  const maxResults = request.maxResults === undefined
    ? undefined
    : Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.floor(request.maxResults)))
  return JSON.stringify({ query: request.query, ...maxResults === undefined ? {} : { max_results: maxResults } })
}

/**
 * Map a gateway search answer to the seam's result. Entries without a usable URL are dropped;
 * instant answers become `content`.
 * @param payload - the parsed response body.
 * @returns the normalized result.
 */
export function mapSearchResponse(payload: unknown): WebSearchResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new WebError('The VibeDev gateway returned an unreadable web search response.', 'WEB_PROVIDER_ERROR')
  }
  const sources: WebSearchSource[] = []
  for (const item of payload.results) {
    if (!isRecord(item) || typeof item.url !== 'string' || !URL.canParse(item.url)) continue
    const title = text(item.title)
    const snippet = text(item.snippet)
    const publishedAt = text(item.published_at)
    sources.push({
      url: item.url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  const answers = (Array.isArray(payload.answers) ? payload.answers : [])
    .map(answer => text(answer) ?? (isRecord(answer) ? text(answer.answer) : undefined))
    .filter(answer => answer !== undefined)
  return { ...answers.length === 0 ? {} : { content: answers.join('\n\n') }, sources, truncated: false }
}

async function readFailure(response: Response): Promise<SearchFailure> {
  let payload: unknown
  try { payload = await response.json() } catch { return {} }
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined
  if (error === undefined) return {}
  const code = text(error.code)
  const message = text(error.message)
  const field = text(error.field)
  return {
    ...code === undefined ? {} : { code },
    ...message === undefined ? {} : { message },
    ...field === undefined ? {} : { field },
  }
}

/** The error for an answer the provider does not retry, worded for the model to act on. */
function failureError(status: number, failure: SearchFailure, wait: number): WebError {
  switch (status) {
    case 400:
      return new WebError(failure.field === 'query'
        ? `VibeDev web search rejected the query${detail(failure)}: it may be at most 400 characters. Search again with a shorter query.`
        : `VibeDev web search rejected the request${detail(failure)}.`, 'WEB_PROVIDER_ERROR')
    case 401:
      return new WebError(`The VibeDev gateway rejected the sign-in used for web search${detail(failure)}. ${SIGN_IN_HINT}`,
        'WEB_PROVIDER_CREDENTIAL_REJECTED')
    case 402:
      return new WebError(`The VibeDev account has no balance left, so the gateway refused this web search${detail(failure)}. `
        + 'Searching is free, but an empty balance blocks every gateway call: ask the user to top up their VibeDev balance.',
      'WEB_SEARCH_BALANCE')
    case 429:
      return new WebError(`VibeDev web search is rate-limited${detail(failure)}. Wait about ${Math.ceil(wait / 1000)} s `
        + 'before searching again, or answer from what you already have.', 'WEB_SEARCH_RATE_LIMITED')
    case 502:
    case 503:
      return new WebError(`VibeDev web search is temporarily unavailable${detail(failure)}. `
        + 'Tell the user search is unavailable right now and answer without it, or try again later.', 'WEB_SEARCH_UNAVAILABLE')
    default:
      return new WebError(`VibeDev web search failed with HTTP ${status}${detail(failure)}.`, 'WEB_PROVIDER_ERROR')
  }
}

/** Web search through the VibeDev gateway. */
export class GatewaySearchProvider implements WebSearchProvider {
  readonly id = GATEWAY_SEARCH_PROVIDER_ID
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param options - endpoint, credential plane, retry bounds, and test seams.
   */
  constructor(private readonly options: GatewaySearchOptions) {}

  /** Always usable: without a credential a search fails with a sign-in hint rather than an unselected provider. */
  available(): boolean {
    return true
  }

  /**
   * Run one search after the ones already queued.
   * @param request - the query and optional result bound.
   * @param signal - cancels the search, queued or running.
   * @returns the normalized result.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const turn = this.queue.then(() => this.searchNow(request, signal))
    this.queue = turn.then(() => undefined, () => undefined)
    return abortable(turn, signal)
  }

  private async searchNow(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const body = requestBody(request)
    let credential = await this.credential(signal)
    let renewed = false
    let retries = 0
    for (;;) {
      const response = await this.post(body, credential.token, signal)
      if (response.ok) return mapSearchResponse(await this.json(response, signal))
      const failure = await readFailure(response)
      // An account or sign-in token can be renewed once; a development key cannot.
      if (response.status === 401 && credential.kind !== 'key' && !renewed) {
        renewed = true
        await abortable(this.options.rejectCredential?.(credential) ?? Promise.resolve(), signal)
        credential = await this.credential(signal)
        continue
      }
      const wait = searchRetryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_RETRY_MS
      if ((response.status === 429 || response.status === 503) && retries < this.options.maxRetries
        && wait <= this.options.maxRetryWaitMs) {
        retries++
        await (this.options.sleep ?? delay)(wait, signal)
        continue
      }
      throw failureError(response.status, failure, wait)
    }
  }

  private async credential(signal?: AbortSignal): Promise<GatewayCredential> {
    const credential = await abortable(this.options.resolveCredential(), signal)
    if (credential === undefined) {
      throw new WebError(`VibeDev web search needs a signed-in VibeDev account. ${SIGN_IN_HINT}`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    return credential
  }

  private async post(body: string, token: string, signal?: AbortSignal): Promise<Response> {
    throwIfAborted(signal)
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    try {
      return await (this.options.fetch ?? globalThis.fetch)(this.options.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'user-agent': this.options.userAgent,
        },
        body,
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      if (timeout.aborted) {
        throw new WebError(`VibeDev web search did not answer within ${Math.round(this.options.requestTimeoutMs / 1000)} s. `
          + 'Tell the user search is slow right now and answer without it, or try again later.', 'WEB_SEARCH_UNAVAILABLE', { cause: error })
      }
      throw new WebError(`VibeDev web search could not reach the gateway (${error instanceof Error ? error.message : String(error)}). `
        + 'Ask the user to check the network connection.', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async json(response: Response, signal?: AbortSignal): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError('The VibeDev gateway returned an unreadable web search response.', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
