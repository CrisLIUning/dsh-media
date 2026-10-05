/**
 * Failures the plugin reports to the model: a gateway refusal, or a request the
 * plugin refused before anything was sent or charged. Messages are written for
 * the model to act on and relay to the user.
 * @module dsh-vibedev/gateway/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Machine-readable detail carried next to the message. */
export interface MediaErrorDetails {
  /** HTTP status when the gateway answered. */
  readonly status?: number
  /** Whether the same request may succeed later. */
  readonly retryable?: boolean
  /** The request field the failure names, when the gateway says which. */
  readonly field?: string
  /** Where the user tops up, on a balance refusal. */
  readonly rechargeUrl?: string
  /** How long the gateway asked the client to wait. */
  readonly retryAfterMs?: number
  /** The gateway was full and created nothing (a busy 429/503). */
  readonly busy?: boolean
  /** On a task-limit refusal: tasks in progress and the account's limit. */
  readonly active?: number
  readonly limit?: number
  /** On an admission balance refusal: amounts in CNY, as the gateway's two-decimal strings. */
  readonly estimatedCny?: string
  readonly availableCny?: string
  readonly pendingCny?: string
}

/**
 * One failure, with a stable `code` to route on and a message to show. It is a
 * harness error, so a tool failure keeps the code in the durable tool result
 * where a client can route on it (sign-in card, top-up link).
 */
export class MediaError extends HarnessError {
  readonly details: MediaErrorDetails

  /**
   * @param message - what happened and what to do next.
   * @param code - stable failure class, such as `INSUFFICIENT_BALANCE` or `VIDEO_MODE_UNSUPPORTED`.
   * @param details - status, retry and field facts.
   * @param options - the underlying cause, when there is one.
   */
  constructor(message: string, code: string, details: MediaErrorDetails = {}, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'MediaError'
    this.details = details
  }
}

/** The parts of a gateway error body the plugin reads, whatever its shape. */
export interface GatewayFailure {
  readonly code?: string
  readonly message?: string
  readonly field?: string
  readonly retryable?: boolean
  readonly rechargeUrl?: string
  readonly active?: number
  readonly limit?: number
  readonly estimatedCny?: string
  readonly availableCny?: string
  readonly pendingCny?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A CNY amount the gateway sends as a two-decimal string (a number is accepted too). */
function amount(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2)
  const raw = text(value)
  return raw !== undefined && /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : undefined
}

/**
 * Read a gateway error body. The gateway answers in several shapes: OpenAI's
 * `{error:{code,message,type}}`, its own `{error:{code,message,retryable,field}}`,
 * the account API's `{code,message,reason}`, and a top-level `recharge_url` on
 * balance refusals. Media admission refusals add `active`/`limit` (task limit)
 * or `estimated_cny`/`available_cny`/`pending_cny` (balance).
 * @param body - the parsed JSON body, or undefined when it was not JSON.
 * @returns the fields found.
 */
export function parseGatewayFailure(body: unknown): GatewayFailure {
  const root = record(body)
  if (root === undefined) return {}
  const nested = record(root.error)
  const source = nested ?? root
  const code = text(source.code) ?? text(source.type) ?? text(root.reason)
  const message = text(source.message) ?? (typeof root.error === 'string' ? text(root.error) : undefined)
  const field = text(source.field)
  const rechargeUrl = text(source.recharge_url) ?? text(root.recharge_url)
  const numbers = { active: count(source.active), limit: count(source.limit) }
  const amounts = { estimatedCny: amount(source.estimated_cny), availableCny: amount(source.available_cny), pendingCny: amount(source.pending_cny) }
  return {
    ...code === undefined ? {} : { code },
    ...message === undefined ? {} : { message },
    ...field === undefined ? {} : { field },
    ...typeof source.retryable === 'boolean' ? { retryable: source.retryable } : {},
    ...rechargeUrl === undefined ? {} : { rechargeUrl },
    ...Object.fromEntries(Object.entries({ ...numbers, ...amounts }).filter(([, value]) => value !== undefined)),
  }
}

/**
 * Milliseconds a `Retry-After` header asks for: delta seconds or an HTTP date.
 * @param header - the header value, or null when absent.
 * @param now - current epoch milliseconds, for an HTTP date.
 * @returns the wait, or undefined when absent or unreadable.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds)) return seconds < 0 ? undefined : Math.round(seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** `(CODE: message)`, for appending the gateway's own words to a message. */
export function gatewayWords(failure: GatewayFailure): string {
  const parts = [failure.code, failure.message].filter(part => part !== undefined)
  return parts.length === 0 ? '' : ` (${parts.join(': ')})`
}
