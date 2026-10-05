/**
 * The plugin's own VibeDev sign-in, for hosts whose account service does not
 * hold a VibeDev session (official DeepSeek Harness). Authorization code with
 * PKCE (S256) through the system browser and a loopback callback on
 * 127.0.0.1; the gateway issues a plugin session (`client=vibedev-plugin`)
 * whose access token is refreshed with a rotating refresh token.
 *
 * Contract (gateway vibedev204):
 * - browser: `{origin}/vibedev-link?callback=http://127.0.0.1:<port>/<path>&state&response_type=code&code_challenge&code_challenge_method=S256&client=vibedev-plugin`
 * - `POST /api/v1/vibedev/link/redeem {code, code_verifier, token_type:'app', client, device_id, device_model, os_version}`
 * - `POST /api/v1/vibedev/app-token/refresh {refresh_token, device_id}`: a new pair every time; the old refresh token dies
 * - `POST /api/v1/vibedev/app-token/revoke` (bearer or `{refresh_token}`): always 204
 * @module dsh-vibedev/auth/login
 */

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { arch, platform, release } from 'node:os'
import { MediaError } from '../gateway/errors.js'

/** A stored plugin session. */
export interface PluginGrant {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch ms. */
  readonly expiresAt: number
  readonly refreshExpiresAt: number
  readonly sessionId?: string
  readonly user?: { readonly id?: string; readonly email?: string; readonly nickname?: string }
}

/** What a read-modify-write of the stored grant does. */
export type GrantChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly grant: PluginGrant }
  | { readonly kind: 'delete' }

/** Where the grant and the device id live. */
export interface GrantStorage {
  read(): Promise<PluginGrant | undefined>
  write(grant: PluginGrant | undefined): Promise<void>
  /**
   * Read-modify-write of the stored grant, one at a time across processes
   * where the store supports it, so two processes never spend one refresh token.
   * @param change - decides the change from the grant as stored now.
   */
  update(change: (current: PluginGrant | undefined) => Promise<GrantChange>): Promise<void>
  /** A stable id for this installation, sent on redeem and on every refresh. */
  deviceId(): Promise<string>
}

/** Construction options; `fetch`, the clock and `openBrowser` are test seams. */
export interface PluginLoginOptions {
  readonly origin: string
  readonly storage: GrantStorage
  readonly userAgent: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** Open a URL in the system browser; resolves whether that was attempted successfully. */
  readonly openBrowser?: (url: string) => Promise<boolean>
  /** How long a started sign-in waits for the browser. Defaults to 5 minutes. */
  readonly signInTimeoutMs?: number
  /** The client name the gateway records for the sign-in (it picks the key the usage is billed to). Defaults to `vibedev-plugin`. */
  readonly client?: string
  readonly log?: (message: string) => void
}

/** A sign-in waiting for the browser. */
export interface PendingSignIn {
  readonly url: string
  readonly expiresAt: number
  /** Settles when the sign-in completes, fails or times out. */
  readonly done: Promise<PluginGrant>
}

const REFRESH_MARGIN_MS = 2 * 60_000
const CALLBACK_PATH = '/dsh-media/callback'

function base64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * Read a token answer (`redeem` or `refresh`).
 * @param body - the parsed envelope `{code, data}` or a bare data object.
 * @param now - current epoch ms.
 * @param previous - the grant being refreshed, whose identity carries over.
 * @returns the grant, or undefined when the answer lacks tokens.
 */
export function parseGrant(body: unknown, now: number, previous?: PluginGrant): PluginGrant | undefined {
  const envelope = record(body)
  const data = record(envelope?.data) ?? envelope
  const accessToken = text(data?.access_token)
  const refreshToken = text(data?.refresh_token)
  if (data === undefined || accessToken === undefined || refreshToken === undefined) return undefined
  const seconds = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const user = record(data.user)
  const sessionId = text(data.session_id) ?? previous?.sessionId
  const parsedUser = user === undefined ? previous?.user : {
    ...text(user.id) === undefined && typeof user.id !== 'number' ? {} : { id: String(user.id) },
    ...text(user.email) === undefined ? {} : { email: text(user.email) as string },
    ...text(user.nickname) === undefined ? {} : { nickname: text(user.nickname) as string },
  }
  return {
    accessToken, refreshToken,
    expiresAt: now + seconds(data.expires_in, 3600) * 1000,
    refreshExpiresAt: now + seconds(data.refresh_expires_in, 30 * 86_400) * 1000,
    ...sessionId === undefined ? {} : { sessionId },
    ...parsedUser === undefined ? {} : { user: parsedUser },
  }
}

/**
 * Open a URL in the system browser without a shell (an `&` in the URL must not split a command line).
 * @param url - the URL.
 * @returns whether the opener started.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const [command, args] = platform() === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
    : platform() === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    } catch {
      resolve(false)
    }
  })
}

const PAGE = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}</style>'
  + `</head><body>${body}</body></html>`

/** The plugin's VibeDev session. */
export class PluginLogin {
  private grant: PluginGrant | undefined
  private loaded: Promise<void> | undefined
  private refreshing: Promise<PluginGrant | undefined> | undefined
  private pending: (PendingSignIn & { server: Server; cancel: (reason: Error) => void }) | undefined
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly origin: string

  /**
   * @param options - gateway origin, storage and test seams.
   */
  constructor(private readonly options: PluginLoginOptions) {
    this.now = options.now ?? Date.now
    this.origin = options.origin.trim().replace(/\/+$/, '')
  }

  private load(): Promise<void> {
    this.loaded ??= this.options.storage.read().then((grant) => { this.grant = grant }, () => undefined)
    return this.loaded
  }

  /** Take a grant as current and tell listeners when it changed. */
  private adopt(grant: PluginGrant | undefined): void {
    const changed = this.grant?.accessToken !== grant?.accessToken
    this.grant = grant
    if (!changed) return
    for (const listener of this.listeners) {
      try { listener() } catch { /* listeners cannot break sign-in */ }
    }
  }

  private async save(grant: PluginGrant | undefined): Promise<void> {
    await this.options.storage.write(grant)
    this.adopt(grant)
  }

  /**
   * Hear about sign-in and sign-out.
   * @param listener - called after every change.
   * @returns unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The signed-in user, or undefined while signed out. */
  async user(): Promise<PluginGrant['user'] | undefined> {
    await this.load()
    return this.grant === undefined ? undefined : this.grant.user ?? {}
  }

  /** Whether a sign-in is waiting for the browser, and its link. */
  pendingSignIn(): { url: string; expiresAt: number } | undefined {
    return this.pending === undefined ? undefined : { url: this.pending.url, expiresAt: this.pending.expiresAt }
  }

  /**
   * The access token for the next request, refreshed when it is about to expire.
   * @returns the token, or undefined while signed out.
   */
  async token(): Promise<string | undefined> {
    await this.load()
    const grant = this.grant
    if (grant === undefined) return undefined
    if (grant.expiresAt - this.now() > REFRESH_MARGIN_MS) return grant.accessToken
    const refreshed = await this.refresh(grant).catch(() => undefined)
    // A refresh the gateway could not answer keeps the old token; the request decides.
    return refreshed?.accessToken ?? (this.grant === undefined ? undefined : grant.accessToken)
  }

  /**
   * The gateway rejected a token (401): refresh once, unless it already changed.
   * @param token - the rejected token.
   */
  async reject(token: string): Promise<void> {
    await this.load()
    const grant = this.grant
    if (grant === undefined || grant.accessToken !== token) return
    await this.refresh(grant).catch(() => undefined)
  }

  /**
   * Refresh one grant; concurrent callers share the request. The refresh runs
   * inside the store's read-modify-write: when another process has already
   * rotated the token, its grant is adopted instead of spending the old refresh
   * token, which the gateway would treat as reuse and revoke the session.
   * A rejected refresh signs out.
   */
  private refresh(grant: PluginGrant): Promise<PluginGrant | undefined> {
    this.refreshing ??= (async () => {
      try {
        let outcome: PluginGrant | undefined
        let failure: MediaError | undefined
        const deviceId = await this.options.storage.deviceId()
        await this.options.storage.update(async (stored): Promise<GrantChange> => {
          if (stored === undefined) {
            outcome = undefined
            return { kind: 'keep' }
          }
          if (stored.refreshToken !== grant.refreshToken) {
            outcome = stored
            return { kind: 'keep' }
          }
          if (stored.refreshExpiresAt <= this.now()) {
            outcome = undefined
            return { kind: 'delete' }
          }
          const response = await this.post('/api/v1/vibedev/app-token/refresh', { refresh_token: stored.refreshToken, device_id: deviceId })
          const body = await response.json().catch(() => undefined)
          if (response.status === 401 || response.status === 403) {
            this.options.log?.(`dsh-vibedev: the VibeDev session ended (${text(record(body)?.reason) ?? response.status}); signed out`)
            outcome = undefined
            return { kind: 'delete' }
          }
          const next = response.ok ? parseGrant(body, this.now(), stored) : undefined
          if (next === undefined) {
            failure = new MediaError(response.ok ? 'The VibeDev gateway returned no tokens on refresh.' : `Refreshing the VibeDev sign-in failed with HTTP ${response.status}.`,
              'SIGN_IN_REFRESH_FAILED', { status: response.status, retryable: true })
            return { kind: 'keep' }
          }
          outcome = next
          return { kind: 'set', grant: next }
        })
        if (failure !== undefined) throw failure
        if (this.grant === grant) this.adopt(outcome)
        return outcome
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  private post(path: string, json: unknown, token?: string): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(`${this.origin}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json', 'content-type': 'application/json', 'user-agent': this.options.userAgent,
        ...token === undefined ? {} : { authorization: `Bearer ${token}` },
      },
      body: JSON.stringify(json),
      signal: AbortSignal.timeout(30_000),
    })
  }

  /**
   * Start a sign-in: listen on a loopback port, open the authorization page in
   * the system browser, and finish in the background when the browser returns.
   * Starting again while one is waiting returns the waiting one.
   * @param request - `open: false` leaves opening the link to the caller (a page that opens it itself).
   * @returns the authorization link, whether a browser was opened, and the completion.
   */
  async startSignIn(request: { open?: boolean } = {}): Promise<PendingSignIn & { opened: boolean }> {
    const open = (url: string): Promise<boolean> => request.open === false ? Promise.resolve(false) : (this.options.openBrowser ?? openInBrowser)(url)
    if (this.pending !== undefined && this.pending.expiresAt > this.now()) {
      const opened = await open(this.pending.url)
      return { url: this.pending.url, expiresAt: this.pending.expiresAt, done: this.pending.done, opened }
    }
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(18))
    let resolveDone!: (grant: PluginGrant) => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<PluginGrant>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    done.catch(() => undefined)
    let settled = false
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return }
      const answer = (status: number, title: string, body: string) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, body))
      }
      if (settled) { answer(410, 'VibeDev', '<h1>This sign-in link has already been used.</h1><p>此登录链接已使用过。</p>'); return }
      if (url.searchParams.get('state') !== state || url.searchParams.get('code') === null) {
        answer(400, 'VibeDev', '<h1>Sign-in could not be completed.</h1><p>登录未完成：链接无效，请回到对话重新登录。</p>')
        return
      }
      settled = true
      const code = url.searchParams.get('code') as string
      this.redeem(code, verifier).then((grant) => {
        const who = grant.user?.email ?? grant.user?.nickname
        answer(200, 'VibeDev', `<h1>Signed in to VibeDev${who === undefined ? '' : ` as ${who.replace(/[<>&"]/g, '')}`}.</h1>`
          + '<p>已登录 VibeDev，可以关闭此页面，回到对话继续。</p><p>You can close this tab and return to the conversation.</p>')
        finish()
        resolveDone(grant)
      }, (error: unknown) => {
        answer(502, 'VibeDev', '<h1>Sign-in failed.</h1><p>登录失败，请回到对话重新登录。</p>')
        finish()
        rejectDone(error instanceof Error ? error : new Error(String(error)))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const port = (server.address() as AddressInfo).port
    const callback = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    const url = `${this.origin}/vibedev-link?${new URLSearchParams({
      callback, state, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', client: this.options.client ?? 'vibedev-plugin',
    }).toString()}`
    const timeoutMs = this.options.signInTimeoutMs ?? 5 * 60_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      finish()
      rejectDone(new MediaError('The VibeDev sign-in was not completed in time.', 'SIGN_IN_TIMEOUT'))
    }, timeoutMs)
    timer.unref()
    const finish = (): void => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
      if (this.pending?.server === server) this.pending = undefined
    }
    this.pending = {
      url, expiresAt: this.now() + timeoutMs, done, server,
      cancel: (reason) => { if (!settled) { settled = true; finish(); rejectDone(reason) } },
    }
    const opened = await open(url)
    return { url, expiresAt: this.now() + timeoutMs, done, opened }
  }

  private async redeem(code: string, verifier: string): Promise<PluginGrant> {
    const response = await this.post('/api/v1/vibedev/link/redeem', {
      code, code_verifier: verifier, token_type: 'app', client: this.options.client ?? 'vibedev-plugin',
      device_id: await this.options.storage.deviceId(),
      device_model: `${platform()}-${arch()}`.slice(0, 128),
      os_version: release().slice(0, 128),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new MediaError(`The VibeDev gateway refused the sign-in (HTTP ${response.status}${text(record(body)?.reason) === undefined ? '' : `, ${text(record(body)?.reason)}`}).`,
        'SIGN_IN_REFUSED', { status: response.status })
    }
    const grant = parseGrant(body, this.now())
    if (grant === undefined) throw new MediaError('The VibeDev gateway returned no tokens for the sign-in.', 'SIGN_IN_REFUSED')
    await this.save(grant)
    return grant
  }

  /** Sign out: revoke the session at the gateway (best effort) and forget it. */
  async signOut(): Promise<void> {
    await this.load()
    const grant = this.grant
    this.pending?.cancel(new MediaError('The sign-in was cancelled.', 'SIGN_IN_CANCELLED'))
    if (grant === undefined) return
    await this.save(undefined)
    await this.post('/api/v1/vibedev/app-token/revoke', { refresh_token: grant.refreshToken }, grant.accessToken)
      .then(response => response.body?.cancel(), () => undefined)
  }

  /** Stop a waiting sign-in. */
  dispose(): void {
    this.pending?.cancel(new MediaError('The plugin stopped before the sign-in finished.', 'SIGN_IN_CANCELLED'))
  }
}
