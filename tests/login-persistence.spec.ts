import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Media from '../src/index.js'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { gatewayGrantKey, grantStorage } from '../src/auth/credentials.js'
import * as FileWrites from '../src/util/files.js'
import { PluginLogin } from '../src/auth/login.js'
import type { GrantStorage, PluginGrant } from '../src/auth/login.js'
import { fakeFetch, json } from './helpers.js'

const NOW = Date.parse('2026-10-06T10:00:00Z')
const KEY = gatewayGrantKey('https://api.vibedev.studio')
const fixtureGrant = (suffix = 'one'): PluginGrant => ({ gatewayOrigin: 'https://api.vibedev.studio', accessToken: `fixture-access-${suffix}`, refreshToken: `fixture-refresh-${suffix}`,
  expiresAt: NOW + 3_600_000, refreshExpiresAt: NOW + 30 * 86_400_000 })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-media-login-persist-')) })
afterEach(async () => {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('dsh-media-login-persist-')) throw new Error('Unexpected fixture cleanup path')
  await rm(dir, { recursive: true, force: true })
})
function recordStore(initial?: PluginGrant) {
  const records = new Map<string, CredentialRecord>(initial === undefined ? [] : [[KEY, { kind: 'grant', payload: initial }]])
  const provider = {
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key)
    },
    deleteRecord: async (key: string) => { records.delete(key) },
  } as unknown as CredentialProvider
  return { records, provider }
}
const loginOf = (storage: GrantStorage) => new PluginLogin({ origin: 'https://api.vibedev.studio', storage, now: () => NOW,
  userAgent: 'persistence-fixture', fetch: fakeFetch().fetch, openBrowser: async () => false })

describe('sign-in persistence across startup and provider recovery', () => {
  it('restores a durable host grant in a newly created login instance without a browser or gateway call', async () => {
    const store = recordStore()
    await grantStorage(dir, () => store.provider).write(fixtureGrant())
    const nextProcess = loginOf(grantStorage(dir, () => store.provider))
    expect(await nextProcess.token()).toBe('fixture-access-one')
    nextProcess.dispose()
    expect(await loginOf(grantStorage(dir, () => store.provider)).token()).toBe('fixture-access-one')
  })

  it('retries after a startup read happens before the credential provider is available', async () => {
    const store = recordStore(fixtureGrant())
    let currentProvider: CredentialProvider | undefined
    const login = loginOf(grantStorage(dir, () => currentProvider))
    expect(await login.token()).toBeUndefined()
    currentProvider = store.provider
    expect(await login.token()).toBe('fixture-access-one')
  })

  it('retries a transient read failure instead of permanently treating the persisted grant as absent', async () => {
    let reads = 0
    const storage: GrantStorage = {
      read: async () => { if (++reads === 1) throw new Error('fixture store not ready'); return fixtureGrant() },
      write: async () => {}, update: async () => {}, deviceId: async () => 'fixture-device',
    }
    const login = loginOf(storage)
    expect(await login.token()).toBeUndefined()
    expect(await login.token()).toBe('fixture-access-one')
    expect(reads).toBe(2)
  })

  it('migrates a file fallback when the durable host provider appears and clears it on sign-out', async () => {
    const store = recordStore()
    let provider: CredentialProvider | undefined
    await grantStorage(dir, () => provider).write(fixtureGrant())
    provider = store.provider
    const restarted = grantStorage(dir, () => provider)
    expect(await restarted.read()).toEqual(fixtureGrant())
    expect(store.records.get(KEY)).toEqual({ kind: 'grant', payload: fixtureGrant() })
    await restarted.write(undefined)
    provider = undefined
    expect(await grantStorage(dir, () => provider).read()).toBeUndefined()
  })

  it('keeps a valid host grant usable when fallback cleanup fails, but does not report sign-out as complete', async () => {
    await grantStorage(dir, () => undefined).write(fixtureGrant())
    const store = recordStore(fixtureGrant('two'))
    const storage = grantStorage(dir, () => store.provider)
    const failure = Object.assign(new Error('fixture cleanup refused'), { code: 'EPERM' })
    const write = vi.spyOn(FileWrites, 'writeFileAtomic').mockRejectedValue(failure)
    try {
      await expect(storage.read()).resolves.toEqual(fixtureGrant('two'))
      await expect(storage.write(fixtureGrant('three'))).resolves.toBeUndefined()
      expect(store.records.get(KEY)).toEqual({ kind: 'grant', payload: fixtureGrant('three') })
      await expect(storage.write(undefined)).rejects.toBe(failure)
      expect(store.records.get(KEY)).toEqual({ kind: 'grant', payload: fixtureGrant('three') })
    } finally { write.mockRestore() }
  })

  it('re-reads the fallback under the host lock after another process signs out while migration waits', async () => {
    await grantStorage(dir, () => undefined).write(fixtureGrant())
    const store = recordStore()
    let queued!: () => void
    let release!: () => void
    const requested = new Promise<void>(resolve => { queued = resolve })
    const lock = new Promise<void>(resolve => { release = resolve })
    const migrationProvider = {
      ...store.provider,
      modifyRecord: async (key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        queued(); await lock
        return store.provider.modifyRecord(key as import('@deepseek-ai/dsh-credentials').CredentialKey, mutate)
      },
    } as unknown as CredentialProvider
    const reading = grantStorage(dir, () => migrationProvider).read()
    await requested
    await grantStorage(dir, () => store.provider).write(undefined)
    release()
    expect(await reading).toBeUndefined()
    expect(store.records.has(KEY)).toBe(false)
  })

  it('prefers a newer host grant over a stale fallback and never revives the stale file after sign-out', async () => {
    const store = recordStore(fixtureGrant('two'))
    await grantStorage(dir, () => undefined).write(fixtureGrant())
    const storage = grantStorage(dir, () => store.provider)
    expect(await storage.read()).toEqual(fixtureGrant('two'))
    await storage.write(undefined)
    expect(await grantStorage(dir, () => undefined).read()).toBeUndefined()
  })

  it('does not let a late empty startup read overwrite a sign-in that has already been saved', async () => {
    let finishRead!: (value: PluginGrant | undefined) => void
    const firstRead = new Promise<PluginGrant | undefined>(resolve => { finishRead = resolve })
    let saved: PluginGrant | undefined
    const storage: GrantStorage = {
      read: () => firstRead, write: async grant => { saved = grant }, update: async () => {}, deviceId: async () => 'fixture-device',
    }
    const gateway = fakeFetch(json(200, { access_token: 'fixture-access-one', refresh_token: 'fixture-refresh-one', expires_in: 3600, refresh_expires_in: 2_592_000 }))
    const login = new PluginLogin({ origin: 'https://api.vibedev.studio', storage, now: () => NOW, userAgent: 'persistence-fixture', fetch: gateway.fetch })
    const startup = login.token()
    const pending = await login.startSignIn({ open: false })
    const authorization = new URL(pending.url)
    const callback = new URL(authorization.searchParams.get('callback') as string)
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', authorization.searchParams.get('state') as string)
    const response = await globalThis.fetch(callback)
    expect(response.ok).toBe(true)
    await pending.done
    expect(saved?.accessToken).toBe('fixture-access-one')
    finishRead(undefined)
    await startup
    expect(await login.token()).toBe('fixture-access-one')
    login.dispose()
  })

  it('restores automatically when Cordis credentials arrive and follows committed record changes', async () => {
    const ctx = new Context()
    const headers: string[] = []
    const store = recordStore({ ...fixtureGrant(), expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 30 * 86_400_000 })
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://api.vibedev.studio/v1/models') {
        headers.push(new Headers(init?.headers).get('authorization') ?? '')
        return json(200, { data: [] })
      }
      if (url === 'https://api.vibedev.studio/v1/account/auth/me') return json(200, { data: { balance: '1', currency: 'CNY' } })
      throw new Error('Unexpected fixture request')
    })
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(Media, { gatewayOrigin: 'https://api.vibedev.studio', apiKeyEnv: '', stateDir: dir, openBrowserOnSignIn: false })
      const status = async () => {
        const result = await ctx.tools.execute({ callId: ToolCallId('persistence-status'), name: 'media_account', arguments: { action: 'status' }, signal: new AbortController().signal })
        return result.content.map((part) => part.type === 'text' ? part.text : '').join('\n')
      }
      expect(await status()).toContain('Nobody is signed in')
      expect(headers).toEqual([])
      await ctx.plugin((scoped: Context) => { scoped.provide('credentials', store.provider) })
      await vi.waitFor(() => { expect(headers).toContain('Bearer fixture-access-one') })
      expect(await status()).toContain("this plugin's VibeDev sign-in")
      store.records.set(KEY, { kind: 'grant', payload: { ...fixtureGrant('two'), expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 30 * 86_400_000 } })
      ctx.emit('credentials/record-updated', KEY as import('@deepseek-ai/dsh-credentials').CredentialKey)
      await vi.waitFor(() => { expect(headers).toContain('Bearer fixture-access-two') })
      store.records.delete(KEY)
      ctx.emit('credentials/record-updated', KEY as import('@deepseek-ai/dsh-credentials').CredentialKey)
      await vi.waitFor(async () => { expect(await status()).toContain('Nobody is signed in') })
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })
})
