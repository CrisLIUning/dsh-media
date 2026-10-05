/**
 * The VibeDev gateway's chat models on their own route, `vibedev-gateway`, so
 * they sit in the model pickers next to whatever else the Harness offers — the
 * DeepSeek account's models included — and are paid from the VibeDev balance.
 *
 * The catalog comes from the gateway (`GET /v1/models`) with the credential
 * requests use, so nothing is listed before a sign-in: the catalog is per
 * account. It is read at start, on every sign-in, sign-out or account change,
 * and every `catalogRefreshMinutes`; a changed catalog republishes the route
 * so pickers update without a restart.
 *
 * Inside the VibeDev app the host account already serves these models on the
 * app's own account channel; when the credential comes from the host account
 * the route stays empty, so the pickers do not list every model twice.
 *
 * @module dsh-vibedev/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { GatewayAdapter } from './adapter.js'
import type { GatewayCredential } from './adapter.js'
import { parseCatalog } from './catalog.js'
import type { GatewayModel } from './catalog.js'

export { GatewayAdapter, INSUFFICIENT_BALANCE_CODE, SIGN_IN_REQUIRED_CODE } from './adapter.js'
export type { GatewayAdapterOptions, GatewayCredential } from './adapter.js'
export { parseCatalog } from './catalog.js'
export type { GatewayModel } from './catalog.js'

/** The route the gateway's chat models are listed under. */
export const VIBEDEV_ROUTE = 'vibedev-gateway'

/** Shortest gap between two catalog reads that an empty model list asks for. */
const ON_DEMAND_READ_GAP_MS = 15_000

/** What the route needs from the rest of the plugin. */
export interface GatewayModelsOptions {
  /** Gateway origin, without a trailing slash. */
  readonly origin: string
  /** The name pickers and the Models page show for the route. */
  readonly displayName: string
  /** The credential for the next request, from the plugin's credential chain. */
  readonly resolveCredential: () => Promise<GatewayCredential | undefined>
  /** Hand a credential the gateway refused back to its owner. */
  readonly rejectCredential: (credential: GatewayCredential) => Promise<void>
  /** A stable id for this installation (Anthropic session affinity). */
  readonly deviceId: () => Promise<string>
  /** Model ids listed first, in this order, when the catalog offers them. Read at every catalog read. */
  readonly preferredModels: () => readonly string[]
  /** Subscribe to sign-in changes; returns unsubscribe. */
  readonly onCredentialChange: (listener: () => void) => () => void
  readonly catalogRefreshMinutes?: number
  readonly catalogTimeoutMs?: number
  readonly cacheRetention?: 'none' | 'short' | 'long'
}

/** The route's live state, for status lines and tests. */
export interface GatewayModels {
  /** Chat models listed now. */
  models(): readonly GatewayModel[]
  /** Why the route is empty, when it is. */
  hidden(): 'signed-out' | 'host-account' | undefined
  /** Read the catalog now (after a sign-in, say); resolves when the read ends. */
  refresh(): Promise<void>
}

/**
 * The id of the profile entry this plugin runs as — its settings namespace. The plugin loader puts
 * the entry on the fiber; its typing ships with the loader package, so it is read structurally here.
 * @param ctx - the plugin context.
 * @returns the entry id, when the loader mounted the plugin.
 */
function entryId(ctx: Context): string | undefined {
  const id = (ctx.fiber as unknown as { entry?: { options?: { id?: unknown } } }).entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The catalog with the preferred models first, in their configured order, and the rest in catalog order.
 * @param models - the parsed catalog.
 * @param preferred - model ids to list first.
 * @returns the reordered catalog.
 */
export function preferredFirst(models: readonly GatewayModel[], preferred: readonly string[]): GatewayModel[] {
  const rank = new Map(preferred.map((id, index) => [id, index]))
  const first = models.filter(model => rank.has(model.id)).sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0))
  return [...first, ...models.filter(model => !rank.has(model.id))]
}

/**
 * Register the route and keep its catalog current.
 * @param ctx - a context with the `llm` service.
 * @param options - origin, credentials and catalog policy.
 * @returns the route's live state.
 */
export function installGatewayModels(ctx: Context, options: GatewayModelsOptions): GatewayModels {
  const { origin } = options
  const catalogTimeoutMs = options.catalogTimeoutMs ?? 20_000
  let catalog: readonly GatewayModel[] = []
  let catalogKey = '[]'
  let hidden: 'signed-out' | 'host-account' | undefined = 'signed-out'
  let reportedHostAccount = false

  const adapter = new GatewayAdapter({
    provider: VIBEDEV_ROUTE,
    displayName: options.displayName,
    origin: () => origin,
    catalog: () => catalog,
    refreshCatalog: () => refreshIfEmpty(),
    resolveCredential: options.resolveCredential,
    rejectCredential: options.rejectCredential,
    deviceId: options.deviceId,
    cacheRetention: options.cacheRetention ?? 'short',
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`dsh-vibedev: unusable replay state on assistant history for "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
  })
  const registration = ctx.llm.registerAdapter([VIBEDEV_ROUTE], adapter)
  // The Models page lists configurable providers under their settings namespace (this entry's id);
  // the plugin draws its own pages, so the Host generates none for the namespace.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.llm.registerConfigurableProviders([
    { provider: VIBEDEV_ROUTE, displayName: options.displayName, settingsNs: entryId(ctx) ?? 'dsh-vibedev', settingsPath: [] },
  ])

  let reading: Promise<void> | undefined
  let readRequests = 0
  let lastOnDemandRead = 0
  let disposed = false
  const publish = (next: readonly GatewayModel[]): void => {
    const key = JSON.stringify(next)
    if (disposed || key === catalogKey) return
    catalog = next
    catalogKey = key
    registration.replace([VIBEDEV_ROUTE])
    ctx.logger.info(`dsh-vibedev: the VibeDev route lists ${next.length} chat model(s)`)
  }
  const readOnce = async (): Promise<void> => {
    try {
      const credential = await options.resolveCredential()
      if (credential === undefined) {
        hidden = 'signed-out'
        publish([])
        return
      }
      if (credential.kind === 'account') {
        // The VibeDev app: its own account channel already lists these models.
        hidden = 'host-account'
        if (!reportedHostAccount) {
          reportedHostAccount = true
          ctx.logger.info('dsh-vibedev: the app\'s VibeDev account serves the gateway models itself; the plugin route stays empty')
        }
        publish([])
        return
      }
      const response = await fetch(`${origin}/v1/models`, {
        headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(catalogTimeoutMs),
        redirect: 'error',
      })
      if (response.status === 401) await options.rejectCredential(credential).catch(() => undefined)
      if (!response.ok) throw new Error(`gateway catalog answered HTTP ${response.status}`)
      hidden = undefined
      publish(preferredFirst(parseCatalog(await response.json()), options.preferredModels()))
    } catch (error) {
      // A failed read keeps the last catalog: a flaky network must not empty every picker.
      ctx.logger.warn('dsh-vibedev: catalog read failed: %o', error)
    }
  }
  // A request that arrives during a read gets a read of its own once that one ends: a sign-in reports
  // several state changes, and the read the first one starts can look for the credential before the
  // sign-in has stored it.
  const readCatalog = (): Promise<void> => {
    readRequests++
    reading ??= (async () => {
      try {
        let served: number
        do {
          served = readRequests
          await readOnce()
        } while (readRequests !== served && !disposed)
      } finally {
        reading = undefined
      }
    })()
    return reading
  }
  // An empty model list reads the catalog again, at most once per gap, so listing models never waits
  // on an unreachable gateway more often than that.
  const refreshIfEmpty = async (): Promise<void> => {
    if (catalog.length > 0 || disposed) return
    if (reading === undefined && Date.now() - lastOnDemandRead < ON_DEMAND_READ_GAP_MS) return
    lastOnDemandRead = Date.now()
    await readCatalog()
  }

  ctx.effect(() => {
    void readCatalog()
    const timer = setInterval(() => { void readCatalog() }, (options.catalogRefreshMinutes ?? 30) * 60_000)
    timer.unref()
    const unsubscribe = options.onCredentialChange(() => { void readCatalog() })
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
    }
  }, 'dsh-vibedev: VibeDev route catalog')

  // A sign-in, sign-out or account switch in the host app changes which credential the chain picks.
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    accountCtx.effect(() => {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const _view of accountCtx.deepseekAccount.watch(controller.signal)) void readCatalog()
        } catch (error) {
          if (!controller.signal.aborted) ctx.logger.warn('dsh-vibedev: account watch ended: %o', error)
        }
      })()
      return () => { controller.abort() }
    }, 'dsh-vibedev: host account watch')
  })

  return {
    models: () => catalog,
    hidden: () => (catalog.length > 0 ? undefined : hidden),
    refresh: () => readCatalog(),
  }
}
