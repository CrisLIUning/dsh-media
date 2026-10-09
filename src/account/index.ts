/**
 * The VibeDev account as the plugin's pages see it, and the Host routes they
 * call (`/api/dsh-vibedev/account…`, on the client connection like every
 * plugin route):
 *
 * - `GET  /api/dsh-vibedev/account` — where the credential comes from (the
 *   app's account, the plugin's own sign-in, a development key, or none), who
 *   is signed in, the balance, a sign-in waiting for the browser, and how many
 *   VibeDev models the pickers list; `?fresh=1` reads the balance again;
 * - `POST /api/dsh-vibedev/account/sign-in` — `{ open?: boolean }`: start the
 *   plugin's own sign-in; answers the authorization link (`open: false` leaves
 *   opening it to the page);
 * - `POST /api/dsh-vibedev/account/cancel` — stop a waiting sign-in;
 * - `POST /api/dsh-vibedev/account/sign-out` — end the plugin's own sign-in
 *   (an app account is signed out in the app, so that answers 409).
 *
 * The DeepSeek account is never touched: it stays the Harness's own.
 * @module dsh-vibedev/account
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { CredentialChain } from '../auth/credentials.js'
import type { PluginGrant, PluginLogin, SignInAttempt } from '../auth/login.js'

/** Path prefix of the plugin's Host routes. */
export const ACCOUNT_ROUTE_PREFIX = '/api/dsh-vibedev/account'

/** How long a balance read is reused before the gateway is asked again. */
const BALANCE_TTL_MS = 60_000

/** Where the active credential comes from. */
export type AccountSource = 'host' | 'plugin' | 'key' | 'none'

/** What the account pages render. */
export interface AccountView {
  readonly source: AccountSource
  /** The signed-in person, when known. */
  readonly user?: { readonly id?: string; readonly email?: string; readonly nickname?: string }
  /** The balance, when it could be read. */
  readonly balance?: { readonly amount: string; readonly currency: string }
  /** A sign-in waiting for the browser. */
  readonly pending?: { readonly url: string; readonly expiresAt: number }
  /** Safe sign-in progress or the most recent terminal diagnostic. */
  readonly attempt?: SignInAttempt
  /** VibeDev chat models the pickers list now, and why there are none. */
  readonly models: { readonly count: number; readonly hidden?: 'signed-out' | 'host-account' }
  /** Pages on the gateway's site. */
  readonly links: { readonly topUp: string; readonly register: string; readonly usage: string }
  /** The VibeDev account is the app's main account (the VibeDev app): its row leads the sidebar foot and Settings. */
  readonly primary: boolean
}

/** What the account routes need from the plugin. */
export interface AccountServiceOptions {
  readonly origin: string
  readonly userAgent: string
  readonly chain: CredentialChain
  readonly login: PluginLogin
  /** The VibeDev route's model count and why it is empty. */
  readonly models: () => { count: number; hidden?: 'signed-out' | 'host-account' }
  /** Present the VibeDev account as the app's main account. */
  readonly primary?: boolean
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The account state behind the pages. */
export class AccountService {
  private balanceCache: { token: string; at: number; value: Promise<Pick<AccountView, 'balance' | 'user'>> } | undefined
  private readonly now: () => number

  /**
   * @param options - origin, credential chain, the plugin's sign-in and the route's model state.
   */
  constructor(private readonly options: AccountServiceOptions) {
    this.now = options.now ?? Date.now
  }

  /** Links to the gateway's pages. */
  links(): AccountView['links'] {
    const origin = this.options.origin
    return { topUp: `${origin}/purchase`, register: origin, usage: `${origin}/usage` }
  }

  /**
   * The account as it stands.
   * @param fresh - read the balance again instead of reusing a recent read.
   * @returns the view.
   */
  async view(fresh = false): Promise<AccountView> {
    const credential = await this.options.chain.resolve().catch(() => undefined)
    const source: AccountSource = credential === undefined ? 'none' : credential.kind === 'account' ? 'host' : credential.kind
    const pending = this.options.login.pendingSignIn()
    const attempt = this.options.login.signInAttempt()
    const base = {
      source, models: this.options.models(), links: this.links(), primary: this.options.primary === true,
      ...pending === undefined ? {} : { pending },
      ...attempt === undefined ? {} : { attempt },
    }
    if (credential === undefined) return base
    const grantUser = credential.kind === 'plugin' ? await this.options.login.user().catch(() => undefined) : undefined
    const me = await this.me(credential.token, fresh)
    const user = me.user ?? userOf(grantUser)
    return { ...base, ...user === undefined ? {} : { user }, ...me.balance === undefined ? {} : { balance: me.balance } }
  }

  /** `GET /v1/account/auth/me` for one token, reused for a minute. */
  private me(token: string, fresh: boolean): Promise<Pick<AccountView, 'balance' | 'user'>> {
    const cached = this.balanceCache
    if (!fresh && cached !== undefined && cached.token === token && this.now() - cached.at < BALANCE_TTL_MS) return cached.value
    const value = (async (): Promise<Pick<AccountView, 'balance' | 'user'>> => {
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.origin}/v1/account/auth/me`, {
          headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': this.options.userAgent },
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        })
        if (!response.ok) return {}
        const body = record(await response.json().catch(() => undefined))
        const data = record(body?.data) ?? body
        const balance = typeof data?.balance === 'number' && Number.isFinite(data.balance) ? String(data.balance) : text(data?.balance)
        const currency = text(data?.currency) ?? 'CNY'
        const id = typeof data?.id === 'number' ? String(data.id) : text(data?.id)
        const nickname = text(data?.nickname) ?? text(data?.username)
        const email = text(data?.email)
        const user = id === undefined && nickname === undefined && email === undefined
          ? undefined
          : { ...id === undefined ? {} : { id }, ...email === undefined ? {} : { email }, ...nickname === undefined ? {} : { nickname } }
        return {
          ...balance === undefined || !/^-?\d+(\.\d+)?$/.test(balance) ? {} : { balance: { amount: balance, currency } },
          ...user === undefined ? {} : { user },
        }
      } catch {
        // The page shows the account without a balance; the next read tries again.
        return {}
      }
    })()
    this.balanceCache = { token, at: this.now(), value }
    // A failed read is not kept: the next view asks again.
    void value.then((read) => { if (read.balance === undefined && this.balanceCache?.value === value) this.balanceCache = undefined })
    return value
  }

  /**
   * Start the plugin's own sign-in.
   * @param open - open the system browser (false: the page opens the link itself).
   * @returns the authorization link and whether a browser was opened.
   */
  async signIn(open: boolean): Promise<{ url: string; expiresAt: number; opened: boolean }> {
    const started = await this.options.login.startSignIn({ open })
    return { url: started.url, expiresAt: started.expiresAt, opened: started.opened }
  }

  /** Stop a waiting sign-in. */
  cancel(): void {
    this.options.login.dispose()
  }

  /**
   * End the plugin's own sign-in.
   * @returns false when the credential is the app's account, which is signed out in the app.
   */
  async signOut(): Promise<boolean> {
    const credential = await this.options.chain.resolve().catch(() => undefined)
    if (credential?.kind === 'account') return false
    await this.options.login.signOut()
    this.balanceCache = undefined
    return true
  }
}

function userOf(user: PluginGrant['user'] | undefined): AccountView['user'] | undefined {
  if (user === undefined) return undefined
  const { id, email, nickname } = user
  if (id === undefined && email === undefined && nickname === undefined) return undefined
  return { ...id === undefined ? {} : { id }, ...email === undefined ? {} : { email }, ...nickname === undefined ? {} : { nickname } }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function failure(error: unknown): Response {
  const candidate = record(error)?.code
  // Even an unexpected storage/listener error may contain tokens, URLs or paths.
  // Keep legacy route codes, but never copy arbitrary codes, messages or causes.
  const code = candidate === 'SIGN_IN_REFUSED' || candidate === 'SIGN_IN_TIMEOUT' || candidate === 'SIGN_IN_CANCELLED' ? candidate : 'INTERNAL'
  const message = code === 'SIGN_IN_CANCELLED' ? 'Sign-in was cancelled. 登录已取消。'
    : code === 'SIGN_IN_TIMEOUT' ? 'Sign-in expired. 登录已超时，请重新登录。'
      : 'The account request could not be completed. 账号请求未完成，请查看登录诊断后重试。'
  return json(500, { error: { code, message } })
}

/**
 * The account routes.
 * @param account - the account service.
 * @returns routes for the client connection.
 */
export function accountRoutes(account: AccountService): ConnectionFetchRoute[] {
  return [
    {
      path: ACCOUNT_ROUTE_PREFIX,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return json(200, await account.view(new URL(request.url, 'http://host').searchParams.get('fresh') === '1'))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/sign-in`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = record(await request.json().catch(() => undefined))
          return json(200, await account.signIn(body?.open !== false))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/cancel`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => {
        account.cancel()
        return Promise.resolve(json(200, { ok: true }))
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/sign-out`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return await account.signOut()
            ? json(200, { ok: true })
            : json(409, { error: { code: 'SIGNED_IN_BY_APP', message: 'The VibeDev account is the app\'s sign-in; sign out in the app.' } })
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}
