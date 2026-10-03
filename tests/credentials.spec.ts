import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { CredentialChain, grantStorage } from '../src/auth/credentials.js'
import type { PluginLogin } from '../src/auth/login.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-media-cred-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function account(token: string | undefined) {
  const rejected: string[] = []
  const asked: string[] = []
  const service = {
    resolveToken: async (url: string) => { asked.push(url); return token },
    rejectToken: async (value: string) => { rejected.push(value) },
  } as unknown as DeepSeekAccount
  return { service, rejected, asked }
}

function plugin(token: string | undefined) {
  const rejected: string[] = []
  const login = { token: async () => token, reject: async (value: string) => { rejected.push(value) } } as unknown as PluginLogin
  return { login, rejected }
}

describe('CredentialChain', () => {
  it('prefers the host account, then the plugin sign-in, then the development key', async () => {
    const host = account('host-token')
    const own = plugin('plugin-token')
    const chain = (a?: DeepSeekAccount, key?: string) => new CredentialChain({ origin: 'https://gw.test/', account: () => a, plugin: own.login, apiKey: () => key })
    expect(await chain(host.service, 'key').resolve()).toEqual({ token: 'host-token', kind: 'account' })
    expect(host.asked).toEqual(['https://gw.test/v1/models'])
    expect(await chain(account(undefined).service, 'key').resolve()).toEqual({ token: 'plugin-token', kind: 'plugin' })
    const signedOut = new CredentialChain({ origin: 'https://gw.test', account: () => undefined, plugin: plugin(undefined).login, apiKey: () => 'dev-key' })
    expect(await signedOut.resolve()).toEqual({ token: 'dev-key', kind: 'key' })
    const nobody = new CredentialChain({ origin: 'https://gw.test', account: () => undefined, plugin: plugin(undefined).login, apiKey: () => '' })
    expect(await nobody.resolve()).toBeUndefined()
  })

  it('hands a rejected token back to whoever issued it', async () => {
    const host = account('h')
    const own = plugin('p')
    const chain = new CredentialChain({ origin: 'https://gw.test', account: () => host.service, plugin: own.login, apiKey: () => undefined })
    await chain.reject({ token: 'h', kind: 'account' })
    await chain.reject({ token: 'p', kind: 'plugin' })
    await chain.reject({ token: 'k', kind: 'key' })
    expect(host.rejected).toEqual(['h'])
    expect(own.rejected).toEqual(['p'])
  })
})

describe('grantStorage', () => {
  const grant = { accessToken: 'vdat_1', refreshToken: 'vdrt_1', expiresAt: 1, refreshExpiresAt: 2 }

  it('keeps the grant in the host credential store as an opaque record', async () => {
    const records = new Map<string, CredentialRecord>()
    const store = {
      readRecord: async (key: string) => records.get(key),
      modifyRecord: async (key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: string) => { records.delete(key) },
    } as unknown as CredentialProvider
    const storage = grantStorage(dir, () => store)
    await storage.write(grant)
    expect([...records.entries()]).toEqual([['dsh-media/vibedev-session', { kind: 'grant', payload: grant }]])
    expect(await storage.read()).toEqual(grant)
    await storage.write(undefined)
    expect(records.size).toBe(0)
  })

  it('changes the stored grant inside the store\'s read-modify-write', async () => {
    const records = new Map<string, CredentialRecord>()
    let exclusive = 0
    const store = {
      readRecord: async (key: string) => records.get(key),
      modifyRecord: async (key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        exclusive++
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: string) => { records.delete(key) },
    } as unknown as CredentialProvider
    const storage = grantStorage(dir, () => store)
    await storage.write(grant)
    const seen: unknown[] = []
    await storage.update(async (current) => { seen.push(current); return { kind: 'set', grant: { ...grant, accessToken: 'vdat_2' } } })
    expect(records.get('dsh-media/vibedev-session')).toEqual({ kind: 'grant', payload: { ...grant, accessToken: 'vdat_2' } })
    await storage.update(async () => ({ kind: 'keep' }))
    expect(records.size).toBe(1)
    await storage.update(async () => ({ kind: 'delete' }))
    expect(records.size).toBe(0)
    expect(seen).toEqual([grant])
    expect(exclusive).toBe(4)
  })

  it('falls back to a private file, and keeps one device id per installation', async () => {
    const storage = grantStorage(dir, () => undefined)
    expect(await storage.read()).toBeUndefined()
    await storage.write(grant)
    expect(await grantStorage(dir, () => undefined).read()).toEqual(grant)
    await storage.write(undefined)
    expect(await storage.read()).toBeUndefined()
    await storage.update(async current => current === undefined ? { kind: 'set', grant } : { kind: 'keep' })
    expect(await storage.read()).toEqual(grant)
    const id = await storage.deviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await grantStorage(dir, () => undefined).deviceId()).toBe(id)
  })
})
