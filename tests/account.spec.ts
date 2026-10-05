/** The account state the pages render, and the Host routes they call. */

import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_ROUTE_PREFIX, AccountService, accountRoutes } from '../src/account/index.js'
import type { CredentialChain } from '../src/auth/credentials.js'
import type { PluginGrant, PluginLogin } from '../src/auth/login.js'
import type { GatewayCredential } from '../src/gateway/http.js'

const ORIGIN = 'https://gw.test'

/** A credential chain and plugin sign-in double. */
function bench(credential: GatewayCredential | undefined, options: { user?: PluginGrant['user']; me?: () => Response; primary?: boolean } = {}) {
  let current = credential
  const login = {
    pendingSignIn: vi.fn((): { url: string; expiresAt: number } | undefined => undefined),
    user: vi.fn(() => Promise.resolve(options.user)),
    startSignIn: vi.fn((_request?: { open?: boolean }) => Promise.resolve({ url: `${ORIGIN}/vibedev-link?state=s`, expiresAt: 1_000, opened: false, done: new Promise<never>(() => {}) })),
    signOut: vi.fn(() => { current = undefined; return Promise.resolve() }),
    dispose: vi.fn(),
  }
  const chain = { resolve: vi.fn(() => Promise.resolve(current)), reject: vi.fn(() => Promise.resolve()) }
  const fetch = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve((options.me ?? (() => Response.json({ code: 0, data: { id: 7, email: 'a@b.c', balance: '12.50', currency: 'CNY' } })))()))
  let now = 0
  const account = new AccountService({
    origin: ORIGIN, userAgent: 'vibedev-plugin/test',
    chain: chain as unknown as CredentialChain, login: login as unknown as PluginLogin,
    models: () => ({ count: current === undefined ? 0 : 3, ...current === undefined ? { hidden: 'signed-out' as const } : {} }),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    ...options.primary === undefined ? {} : { primary: options.primary },
  })
  return { account, login, chain, fetch, advance: (ms: number) => { now += ms } }
}

describe('AccountService', () => {
  it('reports nobody signed in, with the links and no models, without asking the gateway', async () => {
    const { account, fetch } = bench(undefined)
    const view = await account.view()
    expect(view).toEqual({
      source: 'none',
      models: { count: 0, hidden: 'signed-out' },
      links: { topUp: `${ORIGIN}/purchase`, register: ORIGIN, usage: `${ORIGIN}/usage` },
      primary: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says when the VibeDev account is the app’s main account', async () => {
    expect((await bench(undefined, { primary: true }).account.view()).primary).toBe(true)
    expect((await bench({ token: 'vdat_1', kind: 'plugin' }, { primary: true }).account.view()).primary).toBe(true)
  })

  it('shows the plugin sign-in with the person and the balance from the gateway', async () => {
    const { account, fetch } = bench({ token: 'vdat_1', kind: 'plugin' }, { user: { email: 'grant@b.c' } })
    const view = await account.view()
    expect(view).toMatchObject({ source: 'plugin', user: { id: '7', email: 'a@b.c' }, balance: { amount: '12.50', currency: 'CNY' }, models: { count: 3 } })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ORIGIN}/v1/account/auth/me`)
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer vdat_1')
  })

  it('falls back to the sign-in\'s own user when the gateway cannot be read, and shows no balance', async () => {
    const { account } = bench({ token: 'vdat_1', kind: 'plugin' }, { user: { nickname: 'grant' }, me: () => new Response('nope', { status: 503 }) })
    const view = await account.view()
    expect(view.user).toEqual({ nickname: 'grant' })
    expect(view.balance).toBeUndefined()
  })

  it('names the app as the source when the credential is the app\'s account', async () => {
    const { account } = bench({ token: 'vdat_app', kind: 'account' })
    expect((await account.view()).source).toBe('host')
  })

  it('reuses a balance read for a minute unless a fresh one is asked for', async () => {
    const { account, fetch, advance } = bench({ token: 'vdat_1', kind: 'plugin' })
    await account.view()
    await account.view()
    expect(fetch).toHaveBeenCalledTimes(1)
    await account.view(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(61_000)
    await account.view()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('shows a sign-in waiting in the browser', async () => {
    const { account, login } = bench(undefined)
    login.pendingSignIn.mockReturnValue({ url: `${ORIGIN}/vibedev-link?state=s`, expiresAt: 5_000 })
    expect((await account.view()).pending).toEqual({ url: `${ORIGIN}/vibedev-link?state=s`, expiresAt: 5_000 })
  })

  it('starts the sign-in without opening a browser when the page opens the link itself', async () => {
    const { account, login } = bench(undefined)
    expect(await account.signIn(false)).toEqual({ url: `${ORIGIN}/vibedev-link?state=s`, expiresAt: 1_000, opened: false })
    expect(login.startSignIn).toHaveBeenCalledWith({ open: false })
  })

  it('signs out of the plugin sign-in, but leaves the app\'s account to the app', async () => {
    const plugin = bench({ token: 'vdat_1', kind: 'plugin' })
    expect(await plugin.account.signOut()).toBe(true)
    expect(plugin.login.signOut).toHaveBeenCalledTimes(1)
    const host = bench({ token: 'vdat_app', kind: 'account' })
    expect(await host.account.signOut()).toBe(false)
    expect(host.login.signOut).not.toHaveBeenCalled()
  })
})

describe('account routes', () => {
  const route = (account: AccountService, path: string) => {
    const found = accountRoutes(account).find(item => item.path === path)
    if (found === undefined) throw new Error(`no route ${path}`)
    return found
  }
  const call = (account: AccountService, path: string, method: string, body?: unknown) =>
    route(account, path).fetch(new Request(`http://host${path}`, { method, ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } }) as never)

  it('answers the view, and a fresh balance with ?fresh=1', async () => {
    const { account, fetch } = bench({ token: 'vdat_1', kind: 'plugin' })
    const answer = await call(account, ACCOUNT_ROUTE_PREFIX, 'GET')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ source: 'plugin', balance: { amount: '12.50' } })
    await route(account, ACCOUNT_ROUTE_PREFIX).fetch(new Request(`http://host${ACCOUNT_ROUTE_PREFIX}?fresh=1`) as never)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('starts a sign-in, opening the browser unless asked not to', async () => {
    const { account, login } = bench(undefined)
    await call(account, `${ACCOUNT_ROUTE_PREFIX}/sign-in`, 'POST', {})
    expect(login.startSignIn).toHaveBeenLastCalledWith({ open: true })
    const answer = await call(account, `${ACCOUNT_ROUTE_PREFIX}/sign-in`, 'POST', { open: false })
    expect(login.startSignIn).toHaveBeenLastCalledWith({ open: false })
    expect(await answer.json()).toMatchObject({ url: `${ORIGIN}/vibedev-link?state=s`, opened: false })
  })

  it('cancels a waiting sign-in', async () => {
    const { account, login } = bench(undefined)
    expect((await call(account, `${ACCOUNT_ROUTE_PREFIX}/cancel`, 'POST')).status).toBe(200)
    expect(login.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses to sign the app\'s account out', async () => {
    const { account } = bench({ token: 'vdat_app', kind: 'account' })
    const answer = await call(account, `${ACCOUNT_ROUTE_PREFIX}/sign-out`, 'POST')
    expect(answer.status).toBe(409)
    expect(await answer.json()).toMatchObject({ error: { code: 'SIGNED_IN_BY_APP' } })
  })
})
