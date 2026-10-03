import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PluginLogin, parseGrant } from '../src/auth/login.js'
import type { GrantChange, GrantStorage, PluginGrant } from '../src/auth/login.js'
import { bodyOf, fakeFetch, json } from './helpers.js'

const ORIGIN = 'https://vibedev.example.com'
const NOW = Date.parse('2026-10-03T10:00:00Z')

function memory(initial?: PluginGrant): GrantStorage & { current: PluginGrant | undefined } {
  const box: { current: PluginGrant | undefined } = { current: initial }
  return Object.assign(box, {
    read: async () => box.current,
    write: async (grant: PluginGrant | undefined) => { box.current = grant },
    update: async (change: (current: PluginGrant | undefined) => Promise<GrantChange>) => {
      const result = await change(box.current)
      if (result.kind === 'set') box.current = result.grant
      else if (result.kind === 'delete') box.current = undefined
    },
    deviceId: async () => 'device-1',
  })
}

const tokens = (n: number, extra: Record<string, unknown> = {}) => ({
  code: 0, message: 'success',
  data: { token_type: 'Bearer', access_token: `vdat_${n}`, expires_in: 3600, refresh_token: `vdrt_${n}`, refresh_expires_in: 2_592_000, ...extra },
})

const grant = (n: number, expiresAt = NOW + 3_600_000): PluginGrant => ({
  accessToken: `vdat_${n}`, refreshToken: `vdrt_${n}`, expiresAt, refreshExpiresAt: NOW + 30 * 86_400_000, sessionId: 's1', user: { email: 'a@example.com' },
})

describe('parseGrant', () => {
  it('reads the redeem envelope, and keeps the identity across a refresh', () => {
    const first = parseGrant(tokens(1, { session_id: 's1', user: { id: 7, email: 'a@example.com', nickname: 'A' } }), NOW)
    expect(first).toEqual({
      accessToken: 'vdat_1', refreshToken: 'vdrt_1', expiresAt: NOW + 3_600_000, refreshExpiresAt: NOW + 2_592_000_000,
      sessionId: 's1', user: { id: '7', email: 'a@example.com', nickname: 'A' },
    })
    expect(parseGrant(tokens(2), NOW + 5, first)).toMatchObject({ accessToken: 'vdat_2', sessionId: 's1', user: { email: 'a@example.com' } })
    expect(parseGrant({ code: 403, reason: 'INVALID_GRANT' }, NOW)).toBeUndefined()
  })
})

describe('PluginLogin', () => {
  it('signs in through the browser with PKCE and a loopback callback', async () => {
    const gateway = fakeFetch(json(200, tokens(1, { session_id: 's1', user: { id: 7, email: 'a@example.com', nickname: 'A' } })))
    const storage = memory()
    let opened: URL | undefined
    let browser: Promise<Response> | undefined
    const login = new PluginLogin({
      origin: `${ORIGIN}/`, storage, userAgent: 'vibedev-plugin/test', fetch: gateway.fetch, now: () => NOW,
      openBrowser: async (url) => {
        opened = new URL(url)
        const callback = opened.searchParams.get('callback') as string
        browser = globalThis.fetch(`${callback}?code=code-1&state=${opened.searchParams.get('state')}`)
        return true
      },
    })
    const started = await login.startSignIn()
    expect(started.opened).toBe(true)
    expect(login.pendingSignIn()?.url).toBe(started.url)
    const signedIn = await started.done
    expect(signedIn).toMatchObject({ accessToken: 'vdat_1', user: { email: 'a@example.com' } })
    const page = await (browser as Promise<Response>)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('已登录 VibeDev')

    const url = opened as URL
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/vibedev-link`)
    expect(Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'callback' && key !== 'state' && key !== 'code_challenge'))).toEqual({
      response_type: 'code', code_challenge_method: 'S256', client: 'vibedev-plugin',
    })
    expect(url.searchParams.get('callback')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dsh-media\/callback$/)
    const redeem = bodyOf(gateway.seen[0]) as Record<string, string>
    expect(gateway.seen[0]?.url).toBe(`${ORIGIN}/api/v1/vibedev/link/redeem`)
    expect(redeem).toMatchObject({ code: 'code-1', token_type: 'app', client: 'vibedev-plugin', device_id: 'device-1' })
    const challenge = createHash('sha256').update(redeem.code_verifier as string).digest('base64url')
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(storage.current?.accessToken).toBe('vdat_1')
    expect(await login.token()).toBe('vdat_1')
    expect(login.pendingSignIn()).toBeUndefined()
  })

  it('ignores a callback with the wrong state, and gives up when the browser never returns', async () => {
    let response: Promise<Response> | undefined
    const login = new PluginLogin({
      origin: ORIGIN, storage: memory(), userAgent: 'ua', fetch: fakeFetch().fetch, signInTimeoutMs: 200,
      openBrowser: async (url) => {
        response = globalThis.fetch(`${new URL(url).searchParams.get('callback')}?code=x&state=forged`)
        return false
      },
    })
    const started = await login.startSignIn()
    expect(started.opened).toBe(false)
    expect((await (response as Promise<Response>)).status).toBe(400)
    await expect(started.done).rejects.toMatchObject({ code: 'SIGN_IN_TIMEOUT' })
  })

  it('refreshes a token that is about to expire, rotating the refresh token', async () => {
    const gateway = fakeFetch(json(200, tokens(2)))
    const storage = memory(grant(1, NOW + 60_000))
    const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'ua', fetch: gateway.fetch, now: () => NOW })
    const [a, b] = await Promise.all([login.token(), login.token()])
    expect([a, b]).toEqual(['vdat_2', 'vdat_2'])
    expect(gateway.seen).toHaveLength(1)
    expect(bodyOf(gateway.seen[0])).toEqual({ refresh_token: 'vdrt_1', device_id: 'device-1' })
    expect(storage.current).toMatchObject({ accessToken: 'vdat_2', refreshToken: 'vdrt_2', sessionId: 's1' })
  })

  it('refreshes once after a 401 and signs out when the session has ended', async () => {
    const gateway = fakeFetch(json(200, tokens(2)), json(401, { code: 401, message: 'refresh token reused', reason: 'REFRESH_TOKEN_REUSED' }))
    const storage = memory(grant(1))
    const changes: number[] = []
    const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'ua', fetch: gateway.fetch, now: () => NOW })
    login.onChange(() => changes.push(changes.length))
    await login.reject('vdat_1')
    expect(await login.token()).toBe('vdat_2')
    await login.reject('vdat_old')
    expect(gateway.seen).toHaveLength(1)
    await login.reject('vdat_2')
    expect(storage.current).toBeUndefined()
    expect(await login.token()).toBeUndefined()
    expect(changes).toHaveLength(2)
  })

  it('adopts a token another process already rotated instead of spending the old refresh token', async () => {
    const gateway = fakeFetch()
    const storage = memory(grant(1, NOW + 30_000))
    const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'ua', fetch: gateway.fetch, now: () => NOW })
    expect(await login.user()).toEqual({ email: 'a@example.com' })
    // Another harness process refreshes in the meantime.
    storage.current = grant(2)
    expect(await login.token()).toBe('vdat_2')
    // A late 401 for the old token changes nothing.
    await login.reject('vdat_1')
    expect(await login.token()).toBe('vdat_2')
    expect(gateway.seen).toEqual([])
  })

  it('keeps the session when the refresh endpoint is only busy', async () => {
    const gateway = fakeFetch(json(503, { code: 503, reason: 'APP_TOKEN_UNAVAILABLE' }, { 'retry-after': '5' }))
    const storage = memory(grant(1, NOW + 30_000))
    const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'ua', fetch: gateway.fetch, now: () => NOW })
    expect(await login.token()).toBe('vdat_1')
    expect(storage.current?.accessToken).toBe('vdat_1')
  })

  it('revokes the session at the gateway on sign-out', async () => {
    const gateway = fakeFetch(new Response(null, { status: 204 }))
    const storage = memory(grant(3))
    const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'ua', fetch: gateway.fetch, now: () => NOW })
    await login.signOut()
    expect(storage.current).toBeUndefined()
    expect(gateway.seen[0]).toMatchObject({ url: `${ORIGIN}/api/v1/vibedev/app-token/revoke`, headers: { authorization: 'Bearer vdat_3' } })
    expect(bodyOf(gateway.seen[0])).toEqual({ refresh_token: 'vdrt_3' })
  })
})
