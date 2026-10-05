/**
 * The gateway search provider: request shape, answer mapping, token renewal, backoff, failures, and queueing.
 * Ported with the provider from the VibeDev app's search package; the plugin's own sign-in (`plugin`) is renewed
 * like a host account token.
 */

import { describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { GatewaySearchProvider, mapSearchResponse, requestBody, searchRetryAfterMs as retryAfterMs } from '../src/search/provider.js'
import type { GatewaySearchOptions } from '../src/search/provider.js'
import type { GatewayCredential as GatewaySearchCredential } from '../src/gateway/http.js'

const ENDPOINT = 'https://gateway.test/v1/vibedev/web-search'

const ANSWER = {
  query: 'Go context',
  results: [
    { title: ' Go context ', url: 'https://go.dev/blog/context', snippet: 'Package context …', published_at: '2026-09-01T00:00:00Z' },
    { title: 'no address' },
    { title: 'bad address', url: 'not a url' },
    { title: '', url: 'https://example.com/a', snippet: null, published_at: null },
  ],
  suggestions: ['go context timeout'],
  answers: ['42', { answer: 'forty-two' }, ''],
  cached: false,
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: { query?: string; max_results?: number }
}

/** A provider over a scripted gateway; each request takes the next reply, and credentials are handed out in order. */
function provider(
  replies: Array<Response | (() => Promise<Response>)>,
  credentials: GatewaySearchCredential[] = [{ token: 'vdat_1', kind: 'account' }],
  overrides: Partial<GatewaySearchOptions> = {},
) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const rejected: string[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Call['body'],
    })
    const next = replies.shift()
    if (next === undefined) throw new Error('unexpected request')
    return typeof next === 'function' ? await next() : next
  }
  const search = new GatewaySearchProvider({
    endpoint: ENDPOINT,
    resolveCredential: () => Promise.resolve(credentials.length > 1 ? credentials.shift() : credentials[0]),
    rejectCredential: (credential) => { rejected.push(credential.token); return Promise.resolve() },
    userAgent: 'vibedev-app/test',
    requestTimeoutMs: 5000,
    maxRetries: 2,
    maxRetryWaitMs: 10_000,
    fetch,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    ...overrides,
  })
  return { search, calls, sleeps, rejected }
}

async function failure(promise: Promise<unknown>): Promise<WebError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(WebError)
  return error as WebError
}

describe('GatewaySearchProvider', () => {
  it('sends the query with a bounded result count, the bearer token and the VibeDev user agent, and maps the answer', async () => {
    const p = provider([reply(200, ANSWER)])

    const result = await p.search.search({ query: 'Go 语言 context', maxResults: 50 })

    expect(p.calls).toHaveLength(1)
    expect(p.calls[0]?.url).toBe(ENDPOINT)
    expect(p.calls[0]?.headers).toMatchObject({
      authorization: 'Bearer vdat_1', 'content-type': 'application/json', 'user-agent': 'vibedev-app/test',
    })
    expect(p.calls[0]?.body).toEqual({ query: 'Go 语言 context', max_results: 20 })
    expect(result).toEqual({
      content: '42\n\nforty-two',
      sources: [
        { url: 'https://go.dev/blog/context', title: 'Go context', snippet: 'Package context …', publishedAt: '2026-09-01T00:00:00Z' },
        { url: 'https://example.com/a' },
      ],
      truncated: false,
    })
  })

  it('refreshes a rejected account token once and retries with the new one', async () => {
    const p = provider([reply(401, { error: { code: 'APP_TOKEN_EXPIRED', message: 'expired' } }), reply(200, ANSWER)],
      [{ token: 'vdat_1', kind: 'account' }, { token: 'vdat_2', kind: 'account' }])

    await p.search.search({ query: 'q' })

    expect(p.rejected).toEqual(['vdat_1'])
    expect(p.calls.map(call => call.headers.authorization)).toEqual(['Bearer vdat_1', 'Bearer vdat_2'])
  })

  it('renews a token from the plugin sign-in the same way', async () => {
    const p = provider([reply(401, { error: { code: 'APP_TOKEN_EXPIRED' } }), reply(200, ANSWER)],
      [{ token: 'vdat_p1', kind: 'plugin' }, { token: 'vdat_p2', kind: 'plugin' }])

    await p.search.search({ query: 'q' })

    expect(p.rejected).toEqual(['vdat_p1'])
    expect(p.calls.map(call => call.headers.authorization)).toEqual(['Bearer vdat_p1', 'Bearer vdat_p2'])
  })

  it('asks for a new sign-in when the refreshed token is rejected too, and never refreshes a development key', async () => {
    const account = provider([reply(401, { error: { code: 'APP_TOKEN_EXPIRED' } }), reply(401, { error: { code: 'APP_TOKEN_REVOKED' } })])
    expect(await failure(account.search.search({ query: 'q' }))).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_REJECTED' })
    expect(account.rejected).toEqual(['vdat_1'])

    const key = provider([reply(401, { error: { code: 'MISSING_VIBEDEV_SIGNATURE' } })], [{ token: 'sk-dev', kind: 'key' }])
    const error = await failure(key.search.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_REJECTED')
    expect(error.message).toContain('MISSING_VIBEDEV_SIGNATURE')
    expect(key.rejected).toEqual([])
    expect(key.calls).toHaveLength(1)
  })

  it('waits out Retry-After on rate-limited and busy answers before giving up', async () => {
    const recovering = provider([
      reply(429, { error: { code: 'WEB_SEARCH_RATE_LIMITED', retryable: true } }, { 'retry-after': '2' }),
      reply(503, { error: { code: 'WEB_SEARCH_BUSY', retryable: true } }),
      reply(200, ANSWER),
    ])
    await recovering.search.search({ query: 'q' })
    expect(recovering.sleeps).toEqual([2000, 1000])

    const down = provider([1, 2, 3].map(() => reply(503, { error: { code: 'WEB_SEARCH_UNAVAILABLE' } })))
    expect(await failure(down.search.search({ query: 'q' }))).toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' })
    expect(down.calls).toHaveLength(3)

    const throttled = provider([reply(429, { error: { code: 'WEB_SEARCH_RATE_LIMITED' } }, { 'retry-after': '30' })])
    const error = await failure(throttled.search.search({ query: 'q' }))
    expect(error.code).toBe('WEB_SEARCH_RATE_LIMITED')
    expect(error.message).toContain('30 s')
    expect(throttled.sleeps).toEqual([])
  })

  it('explains balance, query and upstream failures without retrying them', async () => {
    const cases = [
      { status: 402, code: 'INSUFFICIENT_BALANCE', field: undefined, expected: 'WEB_SEARCH_BALANCE', words: 'top up' },
      { status: 400, code: 'INVALID_WEB_SEARCH_REQUEST', field: 'query', expected: 'WEB_PROVIDER_ERROR', words: 'shorter query' },
      { status: 502, code: 'WEB_SEARCH_UPSTREAM_FAILED', field: undefined, expected: 'WEB_SEARCH_UNAVAILABLE', words: 'unavailable' },
    ]
    for (const { status, code, field, expected, words } of cases) {
      const p = provider([reply(status, { error: { code, message: 'gateway words', ...field === undefined ? {} : { field } } })])
      const error = await failure(p.search.search({ query: 'q' }))
      expect(error.code).toBe(expected)
      expect(error.message).toContain(words)
      expect(error.message).toContain(`${code}: gateway words`)
      expect(p.calls).toHaveLength(1)
      expect(p.sleeps).toEqual([])
    }
  })

  it('asks for a sign-in without calling the gateway while nobody is signed in', async () => {
    const p = provider([], [], { resolveCredential: () => Promise.resolve(undefined) })
    const error = await failure(p.search.search({ query: 'q' }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(error.message).toContain('Settings → VibeDev account')
    expect(p.calls).toEqual([])
  })

  it('sends one search at a time and drops a queued search its caller cancelled', async () => {
    let release: (response: Response) => void = () => {}
    const p = provider([() => new Promise<Response>((resolve) => { release = resolve }), reply(200, ANSWER)])
    const first = p.search.search({ query: 'a' })
    const controller = new AbortController()
    const cancelled = p.search.search({ query: 'b' }, controller.signal)
    const third = p.search.search({ query: 'c' })
    await vi.waitFor(() => { expect(p.calls).toHaveLength(1) })

    controller.abort()
    expect(await failure(cancelled)).toMatchObject({ code: 'WEB_ABORTED' })
    expect(p.calls).toHaveLength(1)

    release(reply(200, ANSWER))
    await first
    await third
    expect(p.calls.map(call => call.body.query)).toEqual(['a', 'c'])
  })
})

describe('request and answer helpers', () => {
  it('sends max_results only when bounded, within 1–20', () => {
    expect(JSON.parse(requestBody({ query: 'q' }))).toEqual({ query: 'q' })
    expect(JSON.parse(requestBody({ query: 'q', maxResults: 0 }))).toEqual({ query: 'q', max_results: 1 })
    expect(JSON.parse(requestBody({ query: 'q', maxResults: 7.9 }))).toEqual({ query: 'q', max_results: 7 })
  })

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs('Sat, 03 Oct 2026 12:00:10 GMT', Date.parse('2026-10-03T12:00:00Z'))).toBe(10_000)
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('soon')).toBeUndefined()
    expect(retryAfterMs('-1')).toBeUndefined()
  })

  it('refuses an answer without a results list', () => {
    expect(() => mapSearchResponse({ error: 'nope' })).toThrow(WebError)
    expect(mapSearchResponse({ results: [] })).toEqual({ sources: [], truncated: false })
  })
})
