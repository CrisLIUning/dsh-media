import { describe, expect, it } from 'vitest'
import { MediaError } from '../src/gateway/errors.js'
import { GatewayHttp } from '../src/gateway/http.js'
import type { GatewayCredential } from '../src/gateway/http.js'
import { bodyOf, fakeFetch, json } from './helpers.js'

const ORIGIN = 'https://vibedev.example.com'

function client(fetch: typeof globalThis.fetch, credentials: Array<GatewayCredential | undefined> = [{ token: 't1', kind: 'account' }]) {
  const rejected: string[] = []
  const waits: number[] = []
  let next = 0
  const http = new GatewayHttp({
    origin: `${ORIGIN}/`,
    userAgent: 'vibedev-plugin/0.1.0',
    resolveCredential: async () => credentials[Math.min(next++, credentials.length - 1)],
    rejectToken: async (credential) => { rejected.push(credential.token) },
    fetch,
    sleep: async (ms) => { waits.push(ms) },
  })
  return { http, rejected, waits }
}

async function failure(run: Promise<unknown>): Promise<MediaError> {
  const error = await run.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(MediaError)
  return error as MediaError
}

describe('GatewayHttp', () => {
  it('sends the credential, user agent, JSON body and idempotency key to the gateway', async () => {
    const { fetch, seen } = fakeFetch(json(200, { id: 'task_1' }))
    const { http } = client(fetch)
    await expect(http.json('/v1/videos', { method: 'POST', json: { model: 'm' }, idempotencyKey: 'key-1' })).resolves.toEqual({ id: 'task_1' })
    expect(seen[0]).toMatchObject({
      url: `${ORIGIN}/v1/videos`, method: 'POST',
      headers: { authorization: 'Bearer t1', 'user-agent': 'vibedev-plugin/0.1.0', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
    })
    expect(bodyOf(seen[0])).toEqual({ model: 'm' })
  })

  it('never sends the credential off the gateway origin or on an anonymous request', async () => {
    const { fetch, seen } = fakeFetch(new Response('ok'), new Response('ok'), new Response('ok'))
    const { http } = client(fetch, [undefined])
    await http.send('https://oss.example.com/upload?sig=1', { method: 'PUT', body: new Uint8Array([1]) })
    await http.send('https://vibedev.example.com.evil.test/v1/models')
    await http.send(`${ORIGIN}/v1/videos/x/content`, { anonymous: true })
    for (const request of seen) expect(request.headers.authorization).toBeUndefined()
  })

  it('refuses a gateway call while nobody is signed in, before sending anything', async () => {
    const { fetch, seen } = fakeFetch()
    const { http } = client(fetch, [undefined])
    const error = await failure(http.json('/v1/models'))
    expect(error.code).toBe('NOT_SIGNED_IN')
    expect(error.message).toContain('Call media_account with action "sign_in"')
    expect(seen).toHaveLength(0)
  })

  it('reports a rejected account token once and retries with the refreshed one', async () => {
    const { fetch, seen } = fakeFetch(
      json(401, { error: { type: 'authentication_error', code: 'APP_TOKEN_EXPIRED', message: 'expired' } }),
      json(200, { data: [] }),
    )
    const { http, rejected } = client(fetch, [{ token: 'old', kind: 'account' }, { token: 'new', kind: 'account' }])
    await expect(http.json('/v1/models')).resolves.toEqual({ data: [] })
    expect(rejected).toEqual(['old'])
    expect(seen.map(request => request.headers.authorization)).toEqual(['Bearer old', 'Bearer new'])
  })

  it('gives up after one refresh, and never refreshes a development key', async () => {
    const revoked = { error: { type: 'authentication_error', code: 'APP_SESSION_REVOKED', message: 'revoked' } }
    const twice = fakeFetch(json(401, revoked), json(401, revoked))
    const plugin = client(twice.fetch, [{ token: 'a', kind: 'plugin' }, { token: 'b', kind: 'plugin' }])
    const error = await failure(plugin.http.json('/v1/models'))
    expect(error).toMatchObject({ code: 'SIGN_IN_REJECTED', details: { status: 401, retryable: false } })
    expect(error.message).toContain('APP_SESSION_REVOKED')
    expect(plugin.rejected).toEqual(['a'])

    const once = fakeFetch(json(401, revoked))
    const key = client(once.fetch, [{ token: 'k', kind: 'key' }])
    expect((await failure(key.http.json('/v1/models'))).code).toBe('SIGN_IN_REJECTED')
    expect(key.rejected).toEqual([])
    expect(once.seen).toHaveLength(1)
  })

  it('turns a balance refusal into a top-up instruction with the recharge link', async () => {
    const { fetch } = fakeFetch(json(402, {
      error: { type: 'insufficient_quota', code: 'INSUFFICIENT_BALANCE', message: 'balance is 0' },
      recharge_url: 'https://vibedev.example.com/recharge',
    }))
    const error = await failure(client(fetch).http.json('/v1/images/generations', { json: {} }))
    expect(error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', details: { status: 402, retryable: false, rechargeUrl: 'https://vibedev.example.com/recharge' } })
    expect(error.message).toContain('top up their VibeDev balance at https://vibedev.example.com/recharge')
  })

  it('quotes the admission estimate when a task would overdraw the balance', async () => {
    const { fetch, seen } = fakeFetch(json(402, {
      error: {
        type: 'insufficient_quota', code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance for this task: estimated ¥2.40, available ¥1.10',
        stage: 'admission', retryable: false, estimated_cny: '2.40', available_cny: '1.10', pending_cny: '0.80', recharge_url: 'https://vibedev.example.com/purchase',
      },
      recharge_url: 'https://vibedev.example.com/purchase',
    }))
    const error = await failure(client(fetch).http.json('/v1/videos', { json: {} }))
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { status: 402, retryable: false, estimatedCny: '2.40', availableCny: '1.10', pendingCny: '0.80', rechargeUrl: 'https://vibedev.example.com/purchase' },
    })
    expect(error.message).toBe('The VibeDev account balance is not enough for this request: this task is estimated at ¥2.40, and ¥1.10 is available '
      + '(tasks in progress hold ¥0.80). Nothing was charged. Ask the user to top up their VibeDev balance at https://vibedev.example.com/purchase.')
    expect(seen).toHaveLength(1)
  })

  it('does not wait on a task limit, which frees only when one of the user\'s tasks ends', async () => {
    const { fetch, seen } = fakeFetch(json(429, {
      error: { code: 'VIDEO_TASK_LIMIT_REACHED', message: '3 video tasks are already in progress (limit 3); wait for one to finish', stage: 'admission', retryable: true, limit: 3, active: 3 },
    }, { 'retry-after': '30' }))
    const { http, waits } = client(fetch)
    const error = await failure(http.json('/v1/videos', { json: {}, maxBusyWaitMs: 60_000 }))
    expect(error).toMatchObject({ code: 'VIDEO_TASK_LIMIT_REACHED', details: { status: 429, retryable: true, active: 3, limit: 3, retryAfterMs: 30_000 } })
    expect(error.message).toContain('already runs as many video tasks at once as it may (3 of 3)')
    expect(waits).toEqual([])
    expect(seen).toHaveLength(1)
  })

  it('waits out a busy answer for as long as the gateway asks', async () => {
    const { fetch, seen } = fakeFetch(
      json(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '3' }),
      json(503, { error: { code: 'APP_TOKEN_UNAVAILABLE', message: 'try later' } }, { 'retry-after': '5' }),
      json(200, { ok: true }),
    )
    const { http, waits } = client(fetch)
    await expect(http.json('/v1/models')).resolves.toEqual({ ok: true })
    expect(waits).toEqual([3000, 5000])
    expect(seen).toHaveLength(3)
  })

  it('fails at once when the requested wait is too long, and after the busy retries run out', async () => {
    const long = fakeFetch(json(429, { error: { code: 'RATE_LIMITED', message: 'later' } }, { 'retry-after': '60' }))
    const error = await failure(client(long.fetch).http.json('/v1/models'))
    expect(error).toMatchObject({ code: 'RATE_LIMITED', details: { status: 429, retryable: true, retryAfterMs: 60_000 } })
    expect(error.message).toContain('Try again in about 60 s; nothing was charged.')

    const busy = { error: { code: 'PROVIDER_CAPACITY_BUSY', message: 'full' } }
    const full = fakeFetch(json(503, busy), json(503, busy), json(503, busy))
    const run = client(full.fetch)
    expect((await failure(run.http.json('/v1/videos', { json: {} }))).code).toBe('PROVIDER_CAPACITY_BUSY')
    expect(run.waits).toEqual([2000, 2000])
  })

  it('does not treat a plain 503 as busy', async () => {
    const { fetch, seen } = fakeFetch(new Response('upstream down', { status: 503 }))
    const error = await failure(client(fetch).http.json('/v1/models'))
    expect(error).toMatchObject({ code: 'HTTP_503' })
    expect(seen).toHaveLength(1)
  })

  it('keeps the gateway code, field and retry hint of other refusals', async () => {
    const { fetch } = fakeFetch(json(422, { error: { code: 'VIDEO_MODE_UNSUPPORTED', message: 'no audio-only reference', field: 'referenceAudios', retryable: false } }))
    const error = await failure(client(fetch).http.json('/v1/videos', { json: {} }))
    expect(error).toMatchObject({ code: 'VIDEO_MODE_UNSUPPORTED', details: { status: 422, field: 'referenceAudios', retryable: false } })
    expect(error.message).toBe('The VibeDev gateway refused the request with HTTP 422 (VIDEO_MODE_UNSUPPORTED: no audio-only reference).')
  })

  it('reports network failures, cancellation and unreadable answers by code', async () => {
    const down = client((async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch)
    expect((await failure(down.http.json('/v1/models'))).code).toBe('GATEWAY_UNREACHABLE')

    const controller = new AbortController()
    controller.abort()
    const { fetch } = fakeFetch()
    expect((await failure(client(fetch).http.json('/v1/models', { signal: controller.signal }))).code).toBe('ABORTED')

    const garbled = fakeFetch(new Response('<html>', { status: 200 }))
    expect((await failure(client(garbled.fetch).http.json('/v1/models'))).code).toBe('GATEWAY_BAD_RESPONSE')
  })
})
