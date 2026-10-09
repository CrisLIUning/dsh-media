import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountService, ACCOUNT_ROUTE_PREFIX, accountRoutes } from '../src/account/index.js'
import { CredentialChain } from '../src/auth/credentials.js'
import { PluginLogin } from '../src/auth/login.js'
import type { GrantChange, GrantStorage, PendingSignIn, PluginGrant, PluginLoginOptions } from '../src/auth/login.js'
import { bodyOf, fakeFetch, json } from './helpers.js'

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: vi.fn((listener: http.RequestListener) => ownServer(actual.createServer(listener))) }
})

// Gateway/storage doubles only; every callback goes through the real loopback listener.
const ORIGIN = 'https://api.us.vibedev.studio'
const SECRET = 'secret-code-verifier-device-token-user-body-reason'
const tokens = () => ({ code: 0, data: { access_token: `${SECRET}-access`, refresh_token: `${SECRET}-refresh`, user: { email: `${SECRET}@example.com` } } })
const active: PluginLogin[] = []
const barriers = new Set<() => void>()
const work = new Set<Promise<unknown>>()
const requests = new Set<AbortController>()
const responses = new Set<Response>()
const servers = new Map<http.Server, Set<Socket>>()
let activity = 0

/** Record before handing an operation to either the test or the product. */
function own<T>(operation: Promise<T>): Promise<T> {
  work.add(operation)
  activity++
  void operation.then(() => { work.delete(operation); activity++ }, () => { work.delete(operation); activity++ })
  return operation
}

function ownServer(server: http.Server): http.Server {
  const sockets = new Set<Socket>()
  servers.set(server, sockets)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  return server
}

function trackedFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const operation = fetch(input, init).then(response => {
      responses.add(response)
      // Track body reads too, including a mock json() stalled behind a barrier.
      return new Proxy(response, {
        get(target, key) {
          if (key === 'json' || key === 'text' || key === 'arrayBuffer') {
            return () => own(target[key]())
          }
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    return own(operation)
  }
}

beforeEach(() => {
  const fetch = trackedFetch(globalThis.fetch)
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') throw new Error('Fixture requests must use a dynamic loopback port')
    const controller = new AbortController()
    requests.add(controller)
    const previous = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return fetch(input, { ...init, signal: previous ? AbortSignal.any([previous, controller.signal]) : controller.signal })
  })
})

/** Drain continuations to a fixed point, using an event-loop checkpoint, not a sleep. */
async function drainOwned(): Promise<void> {
  for (;;) {
    await Promise.allSettled([...work])
    const before = activity
    await new Promise<void>(resolve => setImmediate(resolve))
    if (work.size === 0 && activity === before) return
  }
}

async function cleanupOwned(): Promise<void> {
  try {
    for (const login of active) login.dispose()
    // Reject stalled owned dependencies even in committing, where dispose cannot cancel.
    for (const release of barriers) release()
    for (const controller of requests) controller.abort()
    await drainOwned()
    for (const response of responses) {
      if (response.body !== null && !response.body.locked && !response.bodyUsed) own(response.body.cancel())
    }
    await Promise.allSettled([...servers].map(([server, sockets]) => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    })))
    await drainOwned()
    expect(work.size).toBe(0)
    for (const [server, sockets] of servers) {
      expect(server.listening).toBe(false)
      expect(sockets.size).toBe(0)
    }
  } finally {
    active.splice(0)
    barriers.clear()
    requests.clear()
    responses.clear()
    servers.clear()
    vi.restoreAllMocks()
  }
}
afterEach(cleanupOwned)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = own(new Promise<T>((yes, no) => { resolve = yes; reject = no }))
  barriers.add(() => reject(new Error('Fixture teardown released a held dependency')))
  return { promise, resolve }
}

/** Observe the actual attempt deadline, rather than waiting a fixed duration. */
function deadlineReached(expiresAt: number): Promise<void> {
  const reached = deferred<void>()
  const timer = setTimeout(() => reached.resolve(), Math.max(0, expiresAt - Date.now()))
  barriers.add(() => clearTimeout(timer))
  return reached.promise
}

function memory(): GrantStorage & { current: PluginGrant | undefined } {
  const store = {
    current: undefined as PluginGrant | undefined,
    read: async () => store.current,
    write: async (grant: PluginGrant | undefined) => { store.current = grant },
    update: async (change: (current: PluginGrant | undefined) => Promise<GrantChange>) => {
      const next = await change(store.current)
      if (next.kind === 'set') store.current = next.grant
      else if (next.kind === 'delete') store.current = undefined
    },
    deviceId: async () => `${SECRET}-device`,
  }
  return store
}

function bench(options: Partial<PluginLoginOptions> = {}, ...answers: Parameters<typeof fakeFetch>) {
  const storage = memory()
  const gateway = fakeFetch(...answers)
  const logs: string[] = []
  const login = new PluginLogin({ origin: ORIGIN, storage, userAgent: 'diagnostic-test', log: message => logs.push(message), ...options, fetch: trackedFetch(options.fetch ?? gateway.fetch) })
  active.push(login)
  const start = login.startSignIn.bind(login)
  vi.spyOn(login, 'startSignIn').mockImplementation(request => own(start(request).then(pending => {
    own(pending.done)
    return pending
  })))
  const signOut = login.signOut.bind(login)
  vi.spyOn(login, 'signOut').mockImplementation(() => own(signOut()))
  const chain = new CredentialChain({ origin: ORIGIN, plugin: login, account: () => undefined, apiKey: () => undefined })
  const account = new AccountService({ origin: ORIGIN, userAgent: 'diagnostic-test', login, chain, models: () => ({ count: 0 }), fetch: trackedFetch(fakeFetch(json(503, {})).fetch) })
  return { login, storage, gateway, logs, account }
}

function callback(pending: PendingSignIn, code = `${SECRET}-code`) {
  const authorization = new URL(pending.url)
  const url = new URL(authorization.searchParams.get('callback') as string)
  url.searchParams.set('state', authorization.searchParams.get('state') as string)
  url.searchParams.set('code', code)
  return url
}

function safe(value: unknown, pending?: PendingSignIn, verifier?: unknown) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  expect(serialized).not.toContain(SECRET)
  for (const key of ['code', 'state', 'code_challenge']) {
    const secret = pending === undefined ? undefined : new URL(pending.url).searchParams.get(key)
    if (secret) expect(serialized).not.toContain(secret)
  }
  if (typeof verifier === 'string') expect(serialized).not.toContain(verifier)
  expect(serialized).not.toContain('vibedev-link?')
}

describe('host sign-in diagnostics', () => {
  it.each(['device', 'redeem', 'persist'] as const)('drains fixture work after an assertion fails during %s', async stage => {
    const device = deferred<string>()
    const exchange = deferred<Response>()
    const write = deferred<void>()
    const { login, storage } = bench({}, () => exchange.promise)
    storage.deviceId = () => device.promise
    storage.write = async () => { await write.promise }
    const pending = await login.startSignIn({ open: false })
    let completionSettled = false
    let requestSettled = false
    const completion = pending.done.then(() => { completionSettled = true }, () => { completionSettled = true })
    const request = globalThis.fetch(callback(pending)).then(() => { requestSettled = true }, () => { requestSettled = true })
    let barrierSettled = false
    const barrier = (stage === 'device' ? device.promise : stage === 'redeem' ? exchange.promise : write.promise)
      .then(() => { barrierSettled = true }, () => { barrierSettled = true })
    try {
      if (stage !== 'device') device.resolve(`${SECRET}-device`)
      if (stage === 'persist') exchange.resolve(json(200, tokens()))
      await vi.waitFor(() => expect(login.signInAttempt()?.stage).toBe(stage))
      try {
        throw new Error('fixture assertion failure')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      } finally {
        await cleanupOwned()
      }
      expect(barrierSettled).toBe(true)
      expect(completionSettled).toBe(true)
      expect(requestSettled).toBe(true)
    } finally {
      // Keep the red regression itself safe before the fixture cleanup is fixed.
      login.dispose()
      device.resolve(`${SECRET}-device`)
      exchange.resolve(json(200, tokens()))
      write.resolve()
      await Promise.allSettled([barrier, completion, request])
    }
  })

  it('publishes copied safe phases through device, exchange and atomic commit, retaining success', async () => {
    const device = deferred<string>()
    const exchange = deferred<Response>()
    const write = deferred<void>()
    const { login, storage, gateway, logs, account } = bench({}, () => exchange.promise)
    storage.deviceId = () => device.promise
    const persist = storage.write
    storage.write = async grant => { await write.promise; await persist(grant) }
    const phases: string[] = []
    login.onChange(() => { const attempt = login.signInAttempt(); if (attempt) phases.push(attempt.phase) })
    expect(login.signInAttempt()).toBeUndefined()
    const pending = await login.startSignIn({ open: false })
    const snapshot = login.signInAttempt()!
    expect(snapshot).toMatchObject({ phase: 'waiting-browser', gatewayOrigin: ORIGIN, expiresAt: pending.expiresAt })
    expect(snapshot.id).toBeTruthy()
    expect(login.signInAttempt()).not.toBe(snapshot)
    try { Object.assign(snapshot, { phase: 'failed', gatewayOrigin: SECRET }) } catch { /* frozen snapshots are also acceptable */ }
    expect(login.signInAttempt()).toMatchObject({ phase: 'waiting-browser', gatewayOrigin: ORIGIN })
    const page = globalThis.fetch(callback(pending))
    await vi.waitFor(() => expect(login.signInAttempt()).toMatchObject({ phase: 'exchanging', stage: 'device' }))
    expect((await account.view()).attempt).toMatchObject({ phase: 'exchanging', stage: 'device' })
    device.resolve(`${SECRET}-device`)
    await vi.waitFor(() => expect(gateway.seen).toHaveLength(1))
    expect(login.signInAttempt()).toMatchObject({ phase: 'exchanging', stage: 'redeem' })
    exchange.resolve(json(200, tokens()))
    await vi.waitFor(() => expect(login.signInAttempt()).toMatchObject({ phase: 'committing', stage: 'persist', httpStatus: 200 }))
    expect((await account.view()).attempt?.phase).toBe('committing')
    write.resolve()
    await pending.done
    expect((await page).status).toBe(200)
    const attempt = login.signInAttempt()
    expect(attempt).toMatchObject({ id: snapshot.id, phase: 'succeeded', stage: 'persist', httpStatus: 200 })
    expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual(['preparing', 'waiting-browser', 'exchanging', 'committing', 'succeeded'])
    expect(login.pendingSignIn()).toBeUndefined()
    expect((await account.view()).attempt).toEqual(attempt)
    const route = accountRoutes(account).find(route => route.path === ACCOUNT_ROUTE_PREFIX)!
    expect(await (await route.fetch(new Request('http://host/api/dsh-vibedev/account') as never)).json()).toMatchObject({ attempt })
    safe(attempt, pending)
    safe(logs.join('\n'), pending, (bodyOf(gateway.seen[0]) as Record<string, unknown>).code_verifier)
    expect(logs.join('\n')).toContain('request')
    expect(logs.join('\n')).toContain('response')
    expect(logs.join('\n')).toContain('terminal')
    for (const line of logs) {
      const record = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>
      expect(Object.keys(record).every(key => ['event', 'id', 'phase', 'stage', 'gatewayOrigin', 'path', 'errorCode', 'httpStatus', 'networkCode'].includes(key))).toBe(true)
      expect(record.path).toBe('/api/v1/vibedev/link/redeem')
    }
    const next = await login.startSignIn({ open: false })
    expect(login.signInAttempt()).toMatchObject({ phase: 'waiting-browser' })
    expect(login.signInAttempt()?.id).not.toBe(attempt?.id)
    login.dispose()
    await expect(next.done).rejects.toMatchObject({ code: 'SIGN_IN_CANCELLED' })
  })

  it.each([
    [400, 'gateway-refused'], [401, 'gateway-refused'], [403, 'gateway-refused'], [429, 'gateway-unavailable'], [503, 'gateway-unavailable'],
  ])('classifies HTTP %s without exposing gateway content', async (status, errorCode) => {
    const { login, storage, gateway, logs, account } = bench({}, json(status, { reason: SECRET, message: SECRET, body: SECRET }))
    const pending = await login.startSignIn({ open: false })
    const page = await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(error).toMatchObject({ code: 'SIGN_IN_REFUSED', details: { status } })
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode, httpStatus: status })
    expect((await account.view()).attempt).toEqual(login.signInAttempt())
    const html = await page.text()
    expect(html).toContain(errorCode)
    expect(html).toContain('redeem')
    expect(html).toContain(String(status))
    expect(html).toContain('登录')
    safe(html, pending); safe(`${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${logs.join('\n')}`, pending)
    expect(gateway.seen).toHaveLength(1)
    expect(storage.current).toBeUndefined()
  })

  it.each(['invalid-json', 'no-tokens', 'invalid-tokens'])('classifies a 200 %s answer as protocol', async kind => {
    const response = kind === 'invalid-json' ? new Response(SECRET, { status: 200 })
      : json(200, kind === 'invalid-tokens' ? { data: { access_token: ' ', refresh_token: 123, reason: SECRET } } : { data: { reason: SECRET } })
    const { login, logs } = bench({}, response)
    const pending = await login.startSignIn({ open: false })
    const page = await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode: 'protocol', httpStatus: 200 })
    expect(error.code).toBe('SIGN_IN_REFUSED')
    safe(`${await page.text()}\n${error.message}\n${JSON.stringify(error)}\n${logs.join('\n')}`, pending)
  })

  it.each(['failed-envelope', 'malformed-data'])('rejects a %s even if it carries token-shaped fields', async kind => {
    const body = kind === 'failed-envelope' ? { ...tokens(), code: 403, reason: SECRET }
      : { data: [], access_token: `${SECRET}-access`, refresh_token: `${SECRET}-refresh` }
    const { login, storage } = bench({}, json(200, body))
    const pending = await login.startSignIn({ open: false })
    await globalThis.fetch(callback(pending))
    const outcome = await pending.done.then(() => 'signed-in', () => 'refused')
    expect(outcome).toBe('refused')
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode: 'protocol', httpStatus: 200 })
    expect(storage.current).toBeUndefined()
  })

  it.each([
    ['ECONNRESET', 'network'], ['ECONNREFUSED', 'network'], ['ENOTFOUND', 'network'], ['EAI_AGAIN', 'network'],
    ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], [SECRET, 'network'],
    ['CERT_HAS_EXPIRED', 'network'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'network'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'network'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'network'],
  ])('classifies transport cause %s and allowlists its code', async (code, errorCode) => {
    const cause = Object.assign(new Error(SECRET), { code })
    const { login, logs, gateway } = bench({}, () => { throw new TypeError(SECRET, { cause }) })
    const pending = await login.startSignIn({ open: false })
    const page = await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode })
    expect(login.signInAttempt()?.networkCode).toBe(code === SECRET ? undefined : code)
    expect(login.signInAttempt()?.httpStatus).toBeUndefined()
    safe(`${await page.text()}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${logs.join('\n')}`, pending)
    expect(gateway.seen).toHaveLength(1)
  })

  it('classifies a transport timeout by name without exposing its message', async () => {
    const { login } = bench({}, () => { throw new DOMException(SECRET, 'TimeoutError') })
    const pending = await login.startSignIn({ open: false })
    await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode: 'timeout' })
    safe(error.message)
  })

  it.each(['device', 'persist'] as const)('classifies %s permission failure as storage and logs before fetch', async stage => {
    const { login, storage, logs, gateway } = bench({}, json(200, tokens()))
    const fail = async () => { throw Object.assign(new Error(SECRET), { code: 'EACCES' }) }
    if (stage === 'device') storage.deviceId = fail
    else storage.write = fail
    const pending = await login.startSignIn({ open: false })
    const page = await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage, errorCode: 'storage' })
    expect(login.signInAttempt()?.networkCode).toBeUndefined()
    expect(logs.join('\n')).toContain('request')
    expect(logs.join('\n')).toContain('terminal')
    safe(`${await page.text()}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${logs.join('\n')}`, pending)
    expect(gateway.seen).toHaveLength(stage === 'device' ? 0 : 1)
  })

  it('records sanitized callback listener failure even before browser/fetch', async () => {
    const listener = new EventEmitter() as http.Server
    listener.listen = (() => { queueMicrotask(() => listener.emit('error', Object.assign(new Error(SECRET), { code: 'EADDRINUSE' }))); return listener }) as typeof listener.listen
    listener.close = (() => listener) as typeof listener.close
    listener.closeAllConnections = () => {}
    vi.mocked(http.createServer).mockReturnValueOnce(listener)
    const { login, logs, gateway, account } = bench()
    const route = accountRoutes(account).find(route => route.path === `${ACCOUNT_ROUTE_PREFIX}/sign-in`)!
    const response = await route.fetch(new Request(`http://host${route.path}`, { method: 'POST' }) as never)
    const result = await response.json()
    expect(response.status).toBe(500)
    safe(result)
    expect(result).toMatchObject({ error: { code: 'SIGN_IN_REFUSED' } })
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'listen', errorCode: 'callback' })
    expect((await account.view()).attempt).toEqual(login.signInAttempt())
    safe(logs.join('\n'))
    expect(logs.join('\n')).toContain('terminal')
    expect(gateway.seen).toHaveLength(0)
  })

  it('keeps runtime listener errors classified at the listen stage', async () => {
    const { login, gateway } = bench()
    const pending = await login.startSignIn({ open: false })
    const server = vi.mocked(http.createServer).mock.results.at(-1)?.value as http.Server
    server.emit('error', new Error(SECRET))
    await expect(pending.done).rejects.toMatchObject({ code: 'SIGN_IN_REFUSED' })
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'listen', errorCode: 'callback' })
    expect(gateway.seen).toHaveLength(0)
  })

  it('does not prepare device state after cancellation from a phase observer', async () => {
    const { login, storage, gateway } = bench()
    const prepare = vi.spyOn(storage, 'deviceId')
    login.onChange(() => { if (login.signInAttempt()?.stage === 'device') login.dispose() })
    const pending = await login.startSignIn({ open: false })
    const page = globalThis.fetch(callback(pending)).catch(() => undefined)
    await expect(pending.done).rejects.toMatchObject({ code: 'SIGN_IN_CANCELLED' })
    await page
    expect(prepare).not.toHaveBeenCalled()
    expect(gateway.seen).toHaveLength(0)
  })

  it('enforces GET, unique state and nonempty unique code without consuming the attempt', async () => {
    const { login, gateway } = bench({}, json(200, tokens()))
    const pending = await login.startSignIn({ open: false })
    const valid = callback(pending)
    const invalid: Array<{ url: URL; method?: string; status: number }> = [{ url: valid, method: 'POST', status: 405 }]
    for (const edit of [
      (url: URL) => url.searchParams.set('state', 'wrong'),
      (url: URL) => url.searchParams.append('state', url.searchParams.get('state')!),
      (url: URL) => url.searchParams.delete('code'),
      (url: URL) => url.searchParams.set('code', ''),
      (url: URL) => url.searchParams.set('code', '  '),
      (url: URL) => url.searchParams.append('code', 'second'),
    ]) { const url = new URL(valid); edit(url); invalid.push({ url, status: 400 }) }
    for (const { url, method, status } of invalid) {
      expect((await globalThis.fetch(url, { method })).status).toBe(status)
      expect(gateway.seen).toHaveLength(0)
      expect(login.signInAttempt()?.phase).toBe('waiting-browser')
    }
    expect((await globalThis.fetch(valid)).status).toBe(200)
    await pending.done
    expect(gateway.seen).toHaveLength(1)
  })

  it('allows exactly one exchange when another valid callback arrives during redeem', async () => {
    const exchange = deferred<Response>()
    const { login, gateway } = bench({}, () => exchange.promise)
    const pending = await login.startSignIn({ open: false })
    const first = globalThis.fetch(callback(pending))
    await vi.waitFor(() => expect(gateway.seen).toHaveLength(1))
    expect((await globalThis.fetch(callback(pending))).status).toBe(410)
    expect(gateway.seen).toHaveLength(1)
    exchange.resolve(json(200, tokens()))
    await first; await pending.done
  })

  it('coalesces concurrent starts before the listener is ready', async () => {
    const { login, gateway } = bench({}, json(200, tokens()))
    const [first, second] = await Promise.all([login.startSignIn({ open: false }), login.startSignIn({ open: false })])
    expect(first.url).toBe(second.url)
    expect(first.done).toBe(second.done)
    expect((await globalThis.fetch(callback(first))).status).toBe(200)
    await first.done
    expect(gateway.seen).toHaveLength(1)
  })

  it.each(['cancel', 'deadline'] as const)('settles %s during device preparation without exchanging late', async action => {
    const device = deferred<string>()
    const { login, storage, gateway } = bench({ signInTimeoutMs: action === 'deadline' ? 120 : 5_000 })
    storage.deviceId = () => device.promise
    const pending = await login.startSignIn({ open: false })
    const page = globalThis.fetch(callback(pending)).catch(() => undefined)
    await vi.waitFor(() => expect(login.signInAttempt()?.stage).toBe('device'))
    if (action === 'cancel') login.dispose()
    await expect(pending.done).rejects.toMatchObject({ code: action === 'deadline' ? 'SIGN_IN_TIMEOUT' : 'SIGN_IN_CANCELLED' })
    expect(login.signInAttempt()).toMatchObject({ phase: action === 'deadline' ? 'expired' : 'cancelled', stage: 'device' })
    device.resolve(`${SECRET}-device`)
    await page
    expect(gateway.seen).toHaveLength(0)
    expect(storage.current).toBeUndefined()
  })

  it.each(['cancel', 'deadline'] as const)('guards %s while reading the response body, including a successful replacement', async action => {
    const body = deferred<unknown>()
    const response = json(200, {})
    vi.spyOn(response, 'json').mockImplementation(() => body.promise)
    let signal: AbortSignal | undefined | null
    const { login, storage, gateway } = bench({ signInTimeoutMs: action === 'deadline' ? 150 : 5_000 }, (_request, init) => { signal = init?.signal; return response }, json(200, tokens()))
    const pending = await login.startSignIn({ open: false })
    const firstPage = globalThis.fetch(callback(pending)).catch(() => undefined)
    await vi.waitFor(() => expect(login.signInAttempt()).toMatchObject({ phase: 'exchanging', stage: 'redeem', httpStatus: 200 }))
    if (action === 'cancel') login.dispose()
    await expect(pending.done).rejects.toMatchObject({ code: action === 'deadline' ? 'SIGN_IN_TIMEOUT' : 'SIGN_IN_CANCELLED' })
    expect(signal?.aborted).toBe(true)
    const next = await login.startSignIn({ open: false })
    await globalThis.fetch(callback(next)); await next.done
    const fresh = login.signInAttempt()
    const saved = storage.current
    body.resolve({ access_token: 'stale-access', refresh_token: 'stale-refresh' })
    await firstPage
    await login.user()
    expect(login.signInAttempt()).toEqual(fresh)
    expect(storage.current).toEqual(saved)
    expect(gateway.seen).toHaveLength(2)
  })

  it('checks the absolute deadline when the clock advances before redeem returns', async () => {
    let now = 1_000
    const { login, storage } = bench({ now: () => now, signInTimeoutMs: 5_000 }, () => { now = 6_001; return json(200, tokens()) })
    const pending = await login.startSignIn({ open: false })
    const page = globalThis.fetch(callback(pending)).catch(() => undefined)
    await expect(pending.done).rejects.toMatchObject({ code: 'SIGN_IN_TIMEOUT' })
    await page
    expect(login.signInAttempt()).toMatchObject({ phase: 'expired', stage: 'redeem' })
    expect(storage.current).toBeUndefined()
  })

  it('keeps redirect:error, a cancellable signal, and one selected-origin redeem request', async () => {
    let init: RequestInit | undefined
    const { login, gateway } = bench({ origin: 'HTTPS://API.US.VIBEDEV.STUDIO:443/' }, (_request, options) => { init = options; throw new TypeError(SECRET) })
    const pending = await login.startSignIn({ open: false })
    await globalThis.fetch(callback(pending))
    await expect(pending.done).rejects.toMatchObject({ code: 'SIGN_IN_REFUSED' })
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(gateway.seen.map(request => request.url)).toEqual([`${ORIGIN}/api/v1/vibedev/link/redeem`])
    expect(login.signInAttempt()?.gatewayOrigin).toBe(ORIGIN)
  })

  it('classifies a failed response-body read by its transport cause', async () => {
    const response = json(200, {})
    vi.spyOn(response, 'json').mockRejectedValue(new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code: 'ECONNRESET' }) }))
    const { login, logs } = bench({}, response)
    const pending = await login.startSignIn({ open: false })
    const page = await globalThis.fetch(callback(pending))
    const error = await pending.done.catch(error => error)
    expect(login.signInAttempt()).toMatchObject({ phase: 'failed', stage: 'redeem', errorCode: 'network', networkCode: 'ECONNRESET', httpStatus: 200 })
    safe(`${await page.text()}\n${error.message}\n${logs.join('\n')}`)
  })

  it.each(['dispose', 'signOut', 'deadline'] as const)('aborts redeem on %s and ignores a late grant after a fresh attempt', async action => {
    const exchange = deferred<Response>()
    let signal: AbortSignal | undefined | null
    const { login, storage, gateway, account } = bench({ signInTimeoutMs: action === 'deadline' ? 120 : 5_000 }, (_request, init) => { signal = init?.signal; return exchange.promise })
    const pending = await login.startSignIn({ open: false })
    const page = globalThis.fetch(callback(pending)).catch(() => undefined)
    await vi.waitFor(() => expect(gateway.seen).toHaveLength(1))
    if (action === 'dispose') login.dispose()
    else if (action === 'signOut') await login.signOut()
    await expect(pending.done).rejects.toMatchObject({ code: action === 'deadline' ? 'SIGN_IN_TIMEOUT' : 'SIGN_IN_CANCELLED' })
    expect(signal?.aborted).toBe(true)
    if (action === 'signOut') expect(login.signInAttempt()).toBeUndefined()
    else expect(login.signInAttempt()).toMatchObject({ phase: action === 'deadline' ? 'expired' : 'cancelled', stage: 'redeem' })
    expect((await account.view()).attempt).toEqual(login.signInAttempt())
    const next = await login.startSignIn({ open: false })
    const fresh = login.signInAttempt()
    exchange.resolve(json(200, tokens()))
    await page
    // A subsequent view drains the asynchronous handler after the mocked response resolves.
    await account.view()
    expect(login.signInAttempt()).toEqual(fresh)
    expect(storage.current).toBeUndefined()
    expect(await login.token()).toBeUndefined()
    login.dispose()
    await expect(next.done).rejects.toMatchObject({ code: 'SIGN_IN_CANCELLED' })
  })

  it('expires while waiting for the browser and retains the diagnostic in AccountService', async () => {
    const { login, account } = bench({ signInTimeoutMs: 20 })
    const pending = await login.startSignIn({ open: false })
    await expect(pending.done).rejects.toMatchObject({ code: 'SIGN_IN_TIMEOUT' })
    expect((await account.view()).attempt).toMatchObject({ phase: 'expired', errorCode: 'timeout' })
    expect(login.pendingSignIn()).toBeUndefined()
  })

  it('does not expire or claim cancellation after an atomic write begins; sign-out waits then deletes', async () => {
    const write = deferred<void>()
    const { login, storage, gateway } = bench({ signInTimeoutMs: 200 }, json(200, tokens()), new Response(null, { status: 204 }))
    const persist = storage.write
    storage.write = async grant => { if (grant) await write.promise; await persist(grant) }
    const pending = await login.startSignIn({ open: false })
    const page = globalThis.fetch(callback(pending))
    await vi.waitFor(() => expect(login.signInAttempt()?.phase).toBe('committing'))
    login.dispose()
    const same = await login.startSignIn({ open: false })
    expect(same.done).toBe(pending.done)
    const signedOut = login.signOut()
    await deadlineReached(pending.expiresAt)
    expect(login.signInAttempt()?.phase).toBe('committing')
    write.resolve()
    await pending.done; await page; await signedOut
    expect(login.signInAttempt()).toBeUndefined()
    expect(storage.current).toBeUndefined()
    expect(await login.token()).toBeUndefined()
    expect(gateway.seen).toHaveLength(2)
  })

  it('sanitizes unexpected start errors at the route boundary', async () => {
    const { login, account } = bench()
    vi.spyOn(login, 'startSignIn').mockRejectedValue(Object.assign(new Error(SECRET), { code: SECRET }))
    const route = accountRoutes(account).find(route => route.path === `${ACCOUNT_ROUTE_PREFIX}/sign-in`)!
    const response = await route.fetch(new Request(`http://host${route.path}`, { method: 'POST' }) as never)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: 'INTERNAL' } })
    safe(body)
  })

  it('removes gateway reasons from refresh logs without changing token callers', async () => {
    const { login, storage, logs } = bench({}, json(401, { reason: SECRET, message: SECRET }))
    storage.current = { accessToken: `${SECRET}-access`, refreshToken: `${SECRET}-refresh`, expiresAt: 0, refreshExpiresAt: Date.now() + 3_600_000 }
    expect(await login.token()).toBeUndefined()
    expect(logs.join('\n')).toContain('HTTP 401')
    safe(logs.join('\n'))
  })
})
