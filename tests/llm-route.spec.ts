/**
 * The `vibedev-gateway` route: the catalog is read with the plugin's credential, so nothing is
 * listed before a sign-in; it follows sign-ins and sign-outs, and stays empty in the VibeDev app,
 * whose own account already lists these models.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { installGatewayModels, preferredFirst, VIBEDEV_ROUTE } from '../src/llm/index.js'
import type { GatewayCredential, GatewayModels, GatewayModelsOptions } from '../src/llm/index.js'
import { parseCatalog } from '../src/llm/catalog.js'
import { CATALOG, closeGatewayDoubles, gatewayDouble } from './llm-gateway-double.js'

afterEach(async () => { await closeGatewayDoubles() })

const CATALOG_IDS = ['claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash', 'glm-5.3']

/** Let the route's startup and change-driven reads run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

/** A stand-in credential chain: what it resolves, a way to hold reads open, and change notices. */
function fakeCredentials() {
  let credential: GatewayCredential | undefined
  let gate: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const rejected: GatewayCredential[] = []
  return {
    set: (next: GatewayCredential | undefined): void => { credential = next },
    /** Hold the reads that start from now on until the returned release is called. */
    hold: (): (() => void) => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => { release = resolve })
      return () => { gate = Promise.resolve(); release() }
    },
    notify: (): void => { for (const listener of listeners) listener() },
    rejected,
    options: {
      resolveCredential: (): Promise<GatewayCredential | undefined> => {
        const value = credential
        return gate.then(() => value)
      },
      rejectCredential: (rejectedCredential: GatewayCredential): Promise<void> => { rejected.push(rejectedCredential); return Promise.resolve() },
      onCredentialChange: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
}

async function mount(origin: string, credentials: ReturnType<typeof fakeCredentials>, extra: Partial<GatewayModelsOptions> = {}): Promise<{ ctx: Context; route: GatewayModels }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  let route: GatewayModels | undefined
  await ctx.plugin({
    name: 'vibedev-route-test',
    inject: ['llm'],
    apply: (scoped: Context) => {
      route = installGatewayModels(scoped, {
        origin, displayName: 'VibeDev', deviceId: () => Promise.resolve('device-1'), preferredModels: () => [],
        ...credentials.options, ...extra,
      })
    },
  })
  if (route === undefined) throw new Error('the route was not installed')
  return { ctx, route }
}

const listed = async (ctx: Context): Promise<string[]> => (await ctx.llm.listModels(VIBEDEV_ROUTE)).map(model => model.id)

describe('preferredFirst', () => {
  it('lists the preferred models first in their order and keeps the rest in catalog order', () => {
    const models = parseCatalog(CATALOG)
    expect(preferredFirst(models, ['deepseek-v4-flash', 'missing', 'gpt-5.5']).map(model => model.id))
      .toEqual(['deepseek-v4-flash', 'gpt-5.5', 'claude-opus-5-5', 'glm-5.3'])
    expect(preferredFirst(models, []).map(model => model.id)).toEqual(models.map(model => model.id))
  })
})

describe('the vibedev-gateway route', () => {
  it('lists the catalog chat models with the plugin sign-in, read with its token', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const credentials = fakeCredentials()
    credentials.set({ token: 'vdat_plugin', kind: 'plugin' })
    const { ctx, route } = await mount(gateway.url, credentials)
    await vi.waitFor(async () => { expect(await listed(ctx)).toEqual(CATALOG_IDS) })
    expect(gateway.catalogRequests[0]?.headers.authorization).toBe('Bearer vdat_plugin')
    expect(route.hidden()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('puts the preferred models first', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const credentials = fakeCredentials()
    credentials.set({ token: 'vdat_plugin', kind: 'plugin' })
    const { ctx } = await mount(gateway.url, credentials, { preferredModels: () => ['glm-5.3'] })
    await vi.waitFor(async () => { expect(await listed(ctx)).toEqual(['glm-5.3', 'claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash']) })
    await ctx.fiber.dispose()
  })

  it('lists nothing and asks the gateway nothing while nobody is signed in', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const { ctx, route } = await mount(gateway.url, fakeCredentials())
    await settle()
    expect(await listed(ctx)).toEqual([])
    expect(gateway.catalogRequests).toEqual([])
    expect(route.hidden()).toBe('signed-out')
    await ctx.fiber.dispose()
  })

  it('lists the models once a sign-in is reported, and empties the route again on sign-out', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const credentials = fakeCredentials()
    const { ctx, route } = await mount(gateway.url, credentials)
    await settle()

    credentials.set({ token: 'vdat_new', kind: 'plugin' })
    credentials.notify()
    await vi.waitFor(async () => { expect(await listed(ctx)).toEqual(CATALOG_IDS) })

    credentials.set(undefined)
    credentials.notify()
    await vi.waitFor(async () => { expect(await listed(ctx)).toEqual([]) })
    expect(route.hidden()).toBe('signed-out')
    await ctx.fiber.dispose()
  })

  it('reads the catalog again when the sign-in stores its credential during a read', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const credentials = fakeCredentials()
    const { ctx } = await mount(gateway.url, credentials)
    await settle()

    // The sign-in's first notice starts a read that looks for the credential before it is stored...
    const release = credentials.hold()
    credentials.notify()
    await settle()
    // ...and the notice that stores it arrives while that read is still waiting.
    credentials.set({ token: 'vdat_new', kind: 'plugin' })
    credentials.notify()
    release()

    await vi.waitFor(() => { expect(gateway.catalogRequests).toHaveLength(1) })
    expect(gateway.catalogRequests[0]?.headers.authorization).toBe('Bearer vdat_new')
    await ctx.fiber.dispose()
  })

  it('stays empty in the VibeDev app, whose own account lists these models, and asks the gateway nothing', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const credentials = fakeCredentials()
    credentials.set({ token: 'vdat_app', kind: 'account' })
    const { ctx, route } = await mount(gateway.url, credentials)
    await settle()
    expect(await listed(ctx)).toEqual([])
    expect(gateway.catalogRequests).toEqual([])
    expect(route.hidden()).toBe('host-account')
    await ctx.fiber.dispose()
  })

  it('hands a credential the catalog read was refused back to its owner and keeps the route empty', async () => {
    const gateway = await gatewayDouble(CATALOG, [], { catalogStatus: 401 })
    const credentials = fakeCredentials()
    credentials.set({ token: 'vdat_stale', kind: 'plugin' })
    const { ctx } = await mount(gateway.url, credentials)
    await vi.waitFor(() => { expect(credentials.rejected.map(credential => credential.token)).toEqual(['vdat_stale']) })
    expect(await listed(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('asks the gateway again for an empty catalog at most once per gap', async () => {
    const gateway = await gatewayDouble({ object: 'list', data: [{ id: 'plain-entry', object: 'model' }] })
    const credentials = fakeCredentials()
    credentials.set({ token: 'vdat_plain', kind: 'plugin' })
    const { ctx } = await mount(gateway.url, credentials)
    await vi.waitFor(() => { expect(gateway.catalogRequests).toHaveLength(1) })

    expect(await listed(ctx)).toEqual([])
    expect(await listed(ctx)).toEqual([])

    expect(gateway.catalogRequests).toHaveLength(2)
    await ctx.fiber.dispose()
  })
})
