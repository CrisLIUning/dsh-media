/**
 * Failure classification for the gateway route: a connection the gateway lost to
 * its own upstream is a transport truncation a retry can recover, while an
 * unexplained terminal error stays the non-retryable fallback.
 */

import { describe, expect, it } from 'vitest'
import { mapStopReason } from '../src/llm/stream.js'

/** The terminal assistant message `mapStopReason` reads (its provider's own type). */
type Terminal = Parameters<typeof mapStopReason>[0]

/** An assistant message that ended with a provider error carrying `text`. */
const failed = (text: string): Terminal => ({
  stopReason: 'error',
  errorMessage: text,
  model: 'gpt-6.1-sol',
  content: [],
} as unknown as Terminal)

const codeOf = (message: Terminal): string | undefined => {
  const reason = mapStopReason(message)
  return reason.kind === 'error' ? reason.failure.code : undefined
}

describe('gateway upstream transport failures', () => {
  it('treats the gateway wordings for a broken upstream stream as transport failures', () => {
    // Observed on the vibedev-gateway route: every one of these ended a turn the
    // person had to notice and repeat by hand.
    for (const text of [
      'Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed',
      'Error Code upstream_stream_read_error: Upstream response stream was interrupted',
      'upstream stream disconnected: connection reset by peer',
      'HTTP/2 stream reset by the upstream provider',
    ]) expect(codeOf(failed(text)), text).toBe('TRANSPORT')
  })

  it('keeps the classifications that were already there', () => {
    expect(codeOf(failed('{"error":{"code":"MISSING_VIBEDEV_SIGNATURE"}} 401'))).toBe('AUTH')
    expect(codeOf(failed('429 rate limit exceeded'))).toBe('RATE_LIMIT')
    expect(codeOf(failed('502 {"error":{"message":"Upstream service temporarily unavailable"}}'))).toBe('SERVER')
    expect(codeOf(failed('upstream stream disconnected: connection timed out'))).toBe('TIMEOUT')
  })

  it('leaves an unexplained terminal error as the non-retryable fallback', () => {
    expect(codeOf(failed('the provider answered something no rule knows'))).toBe('PI_AI_ERROR')
    expect(codeOf({ stopReason: 'pending', model: 'gpt-6.1-sol', content: [] } as unknown as Terminal)).toBe('PI_AI_ERROR')
    expect(codeOf({ stopReason: 'deferred', model: 'gpt-6.1-sol', content: [] } as unknown as Terminal)).toBe('PI_AI_ERROR')
  })
})
