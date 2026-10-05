/** The browser half's account store: reads, polling pace, and the sign-in / sign-out actions. */

import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_ROUTE, AccountStore, balanceText, displayName } from '../src/client/account-store.js'
import type { AccountView } from '../src/client/account-store.js'

const LINKS = { topUp: 'https://gw.test/purchase', register: 'https://gw.test', usage: 'https://gw.test/usage' }
const SIGNED_OUT: AccountView = { source: 'none', models: { count: 0, hidden: 'signed-out' }, links: LINKS }
const PENDING: AccountView = { ...SIGNED_OUT, pending: { url: 'https://gw.test/vibedev-link?state=s', expiresAt: 9 } }
const SIGNED_IN: AccountView = { source: 'plugin', user: { email: 'a@b.c' }, balance: { amount: '12.50', currency: 'CNY' }, models: { count: 4 }, links: LINKS }

function harness(answers: Record<string, () => Response>) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const timers: Array<{ callback: () => void; ms: number }> = []
  const opened: string[] = []
  const store = new AccountStore({
    fetch: vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, ...init === undefined ? {} : { init } })
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
      const answer = answers[key]
      return answer === undefined ? Promise.reject(new Error(`no answer for ${key}`)) : Promise.resolve(answer())
    }) as unknown as typeof globalThis.fetch,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length },
    clearTimeout: () => {},
    openWindow: (url) => { opened.push(url) },
  })
  return { store, calls, timers, opened }
}

describe('AccountStore', () => {
  it('reads the account on start and polls every minute while nothing waits', async () => {
    const { store, timers } = harness({ [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(SIGNED_OUT) })
    store.start()
    await vi.waitFor(() => { expect(store.getSnapshot().view).toEqual(SIGNED_OUT) })
    expect(timers.at(-1)?.ms).toBe(60_000)
  })

  it('polls every two seconds while a sign-in waits in the browser', async () => {
    const { store, timers } = harness({ [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(PENDING) })
    store.start()
    await vi.waitFor(() => { expect(store.getSnapshot().view?.pending).toBeDefined() })
    expect(timers.at(-1)?.ms).toBe(2_000)
  })

  it('keeps the last view and flags the failure when a read fails', async () => {
    let fail = false
    const { store } = harness({ [`GET ${ACCOUNT_ROUTE}`]: () => fail ? new Response('down', { status: 502 }) : Response.json(SIGNED_IN) })
    await store.refresh()
    fail = true
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: SIGNED_IN, loadFailed: true })
  })

  it('starts a sign-in asking the Host to open the browser, and opens the link itself when it could not', async () => {
    const { store, calls, opened } = harness({
      [`POST ${ACCOUNT_ROUTE}/sign-in`]: () => Response.json({ url: 'https://gw.test/vibedev-link?state=s', expiresAt: 9, opened: false }),
      [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(PENDING),
    })
    await store.signIn()
    const request = calls.find(call => call.path === `${ACCOUNT_ROUTE}/sign-in`)
    expect(JSON.parse(String(request?.init?.body))).toEqual({ open: true })
    expect(opened).toEqual(['https://gw.test/vibedev-link?state=s'])
    expect(store.getSnapshot()).toMatchObject({ busy: undefined, view: PENDING })
  })

  it('does not open the link again when the Host opened the browser', async () => {
    const { store, opened } = harness({
      [`POST ${ACCOUNT_ROUTE}/sign-in`]: () => Response.json({ url: 'https://gw.test/vibedev-link?state=s', expiresAt: 9, opened: true }),
      [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(PENDING),
    })
    await store.signIn()
    expect(opened).toEqual([])
  })

  it('reports a sign-in that could not start', async () => {
    const { store } = harness({
      [`POST ${ACCOUNT_ROUTE}/sign-in`]: () => Response.json({ error: { message: 'no port' } }, { status: 500 }),
      [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(SIGNED_OUT),
    })
    await store.signIn()
    expect(store.getSnapshot().actionError).toEqual({ kind: 'sign-in', message: 'no port' })
  })

  it('signs out and reads the account again; a refused sign-out is reported', async () => {
    let status = 200
    const { store, calls } = harness({
      [`POST ${ACCOUNT_ROUTE}/sign-out`]: () => new Response(status === 200 ? '{"ok":true}' : '{}', { status }),
      [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(SIGNED_OUT),
    })
    await store.signOut()
    expect(calls.map(call => call.path)).toEqual([`${ACCOUNT_ROUTE}/sign-out`, ACCOUNT_ROUTE])
    expect(store.getSnapshot().actionError).toBeUndefined()
    status = 409
    await store.signOut()
    expect(store.getSnapshot().actionError?.kind).toBe('sign-out')
  })

  it('opens the waiting sign-in and the gateway pages the page\'s own way', async () => {
    const { store, opened } = harness({ [`GET ${ACCOUNT_ROUTE}`]: () => Response.json(PENDING) })
    await store.refresh()
    store.openPending()
    store.openLink(LINKS.topUp)
    expect(opened).toEqual(['https://gw.test/vibedev-link?state=s', LINKS.topUp])
  })
})

describe('account text', () => {
  it('names the person by nickname, else email, and writes the balance with its currency', () => {
    expect(displayName(SIGNED_IN)).toBe('a@b.c')
    expect(displayName({ ...SIGNED_IN, user: { nickname: 'n', email: 'a@b.c' } })).toBe('n')
    expect(balanceText(SIGNED_IN)).toBe('¥12.50')
    expect(balanceText({ ...SIGNED_IN, balance: { amount: '3', currency: 'USD' } })).toBe('$3')
    expect(balanceText(SIGNED_OUT)).toBeUndefined()
  })
})
