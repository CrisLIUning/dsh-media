import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { GRANT_KEY, gatewayGrantKey, grantStorage } from '../src/auth/credentials.js'
import { PluginLogin } from '../src/auth/login.js'
import { DEFAULT_GATEWAY_ORIGIN, US_GATEWAY_ORIGIN, gatewayStateDirectory, normalizeGatewayOrigin, developmentKey } from '../src/gateway/origin.js'
import { GatewayHttp } from '../src/gateway/http.js'
import { MediaLibrary } from '../src/gateway/assets.js'
import { TaskStore } from '../src/tasks/store.js'
import { TaskTracker } from '../src/tasks/tracker.js'
import { MP4 } from './fixtures.js'
import { fakeFetch, json } from './helpers.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vibedev-origin-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const grant = { accessToken: 'fixture-cn-access', refreshToken: 'fixture-cn-refresh', expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000 }

describe('gateway origin boundary', () => {
  it('keeps only the historical domestic bucket compatible and canonicalizes equivalent origins', () => {
    expect(normalizeGatewayOrigin('HTTPS://API.VIBEDEV.STUDIO:443/')).toBe(US_GATEWAY_ORIGIN)
    expect(gatewayStateDirectory(dir, DEFAULT_GATEWAY_ORIGIN)).toBe(dir)
    expect(gatewayStateDirectory(dir, US_GATEWAY_ORIGIN)).not.toBe(dir)
    expect(gatewayGrantKey(DEFAULT_GATEWAY_ORIGIN)).toBe(GRANT_KEY)
    expect(gatewayGrantKey(US_GATEWAY_ORIGIN)).not.toBe(GRANT_KEY)
    expect(gatewayGrantKey('HTTPS://API.VIBEDEV.STUDIO:443/')).toBe(gatewayGrantKey(US_GATEWAY_ORIGIN))
    expect(gatewayStateDirectory(dir, 'http://localhost:1234')).not.toBe(gatewayStateDirectory(dir, 'http://localhost:1235'))
    for (const invalid of ['https://user:pass@api.vibedev.studio', 'https://api.vibedev.studio/v1', 'https://api.vibedev.studio?key=x', 'https://api.vibedev.studio/#x']) {
      expect(() => normalizeGatewayOrigin(invalid)).toThrow()
    }
  })

  it('does not read, refresh, delete or transmit domestic or other account credentials when selecting America', async () => {
    const records = new Map<string, CredentialRecord>([
      [GRANT_KEY, { kind: 'grant', payload: grant }],
      ['deepseek-account-platform/default', { kind: 'grant', payload: { accessToken: 'fixture-deepseek' } }],
    ])
    const store = {
      readRecord: async (key: string) => records.get(key),
      modifyRecord: async (key: string, change: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
        const next = await change(records.get(key)); if (next !== undefined) records.set(key, next); return next
      },
      deleteRecord: async (key: string) => { records.delete(key) },
    } as unknown as CredentialProvider
    const before = JSON.stringify([...records])
    const storage = grantStorage(dir, () => store, US_GATEWAY_ORIGIN)
    const network = fakeFetch()
    const login = new PluginLogin({ origin: US_GATEWAY_ORIGIN, storage, fetch: network.fetch, userAgent: 'test' })
    try {
      expect(await login.token()).toBeUndefined()
      await login.signOut()
      expect(network.seen).toEqual([])
      expect(JSON.stringify([...records])).toBe(before)
      await storage.write({ ...grant, accessToken: 'fixture-us-access', refreshToken: 'fixture-us-refresh' })
      expect((await storage.read())?.accessToken).toBe('fixture-us-access')
      expect((await grantStorage(dir, () => store, DEFAULT_GATEWAY_ORIGIN).read())?.accessToken).toBe('fixture-cn-access')
      await storage.write(undefined)
      expect(JSON.stringify([...records])).toBe(before)
    } finally { login.dispose() }
  })

  it('rejects a copied foreign grant and an unmarked legacy grant in a new origin bucket', async () => {
    const storage = grantStorage(dir, () => undefined, US_GATEWAY_ORIGIN)
    await storage.write(grant)
    const file = join(gatewayStateDirectory(dir, US_GATEWAY_ORIGIN), 'session.json')
    await writeFile(file, JSON.stringify({ ...grant, gatewayOrigin: DEFAULT_GATEWAY_ORIGIN }))
    expect(await storage.read()).toBeUndefined()
    await writeFile(file, JSON.stringify(grant))
    expect(await storage.read()).toBeUndefined()
    expect(developmentKey(US_GATEWAY_ORIGIN, 'VIBEDEV_GATEWAY_API_KEY', { VIBEDEV_GATEWAY_API_KEY: 'fixture-cn-key' })).toBeUndefined()
  })

  it('never restores old video/audio or uploading state on an empty American task store; history stays unchanged', async () => {
    const old = new TaskStore(dir)
    const historyUrl = 'https://old-media.example/clip.mp4?sig=old%2Btoken&expires=7'
    for (const kind of ['video', 'audio'] as const) await old.add({
      id: `old-${kind}`, kind, model: 'fixture', label: 'old task', createdAt: 1, updatedAt: 1,
      status: kind === 'video' ? 'pending' : 'submitting', gatewayId: kind === 'video' ? 'old-remote-id' : undefined,
      endpoint: kind === 'video' ? '/v1/videos' : '/v1/audio/generations', body: {}, outputDir: join(dir, 'out'), stem: 'old', outputs: [{ url: historyUrl }],
    })
    await writeFile(join(dir, 'upload-history.json'), JSON.stringify({ asset_id: 'old-upload', content_url: historyUrl }))
    const before = await readFile(join(dir, 'upload-history.json'), 'utf8')
    const network = fakeFetch()
    const http = new GatewayHttp({ origin: US_GATEWAY_ORIGIN, fetch: network.fetch, userAgent: 'test', resolveCredential: async () => undefined })
    const us = new TaskStore(gatewayStateDirectory(dir, US_GATEWAY_ORIGIN))
    const tracker = new TaskTracker({ http, store: us })
    try {
      await tracker.resume()
      expect(await us.list()).toEqual([])
      expect(network.seen).toEqual([])
      expect((await old.list()).map(task => task.outputs?.[0]?.url)).toEqual([historyUrl, historyUrl])
      expect(await readFile(join(dir, 'upload-history.json'), 'utf8')).toBe(before)
    } finally { tracker.dispose() }
  })

  it('uploads and refreshes through API but preserves the complete signed storage URL and never sends an app token to storage', async () => {
    const upload = 'https://media.vibedev.studio/bucket/a%2Fb.mp4?X-Signature=a%2Bb%2F&part=1&part=2'
    const content = 'https://media.vibedev.studio/bucket/a%2Fb.mp4?X-Signature=fresh%2Btoken&expiry=10'
    const network = fakeFetch(
      json(200, { asset_id: 'us-asset', upload_required: true, upload_url: upload, upload_headers: { 'content-type': 'video/mp4' } }),
      new Response(null, { status: 200 }),
      json(200, { asset_id: 'us-asset', content_url: content, reference_url: content, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      json(200, { asset_id: 'us-asset', content_url: content, reference_url: content }),
    )
    const http = new GatewayHttp({ origin: US_GATEWAY_ORIGIN, fetch: network.fetch, userAgent: 'test', resolveCredential: async () => ({ kind: 'plugin', token: 'fixture-us-app' }) })
    let clock = Date.now()
    const library = new MediaLibrary(http, () => clock)
    const asset = await library.upload({ source: 'a.mp4', name: 'a.mp4', mime: 'video/mp4', data: MP4 }, 'video_reference')
    clock += 3_600_000
    await library.upload({ source: 'a.mp4', name: 'a.mp4', mime: 'video/mp4', data: MP4 }, 'video_reference')
    expect(asset.contentUrl).toBe(content)
    expect(network.seen.map(request => request.url)).toEqual([`${US_GATEWAY_ORIGIN}/v1/media-assets/uploads`, upload, `${US_GATEWAY_ORIGIN}/v1/media-assets/us-asset/complete`, `${US_GATEWAY_ORIGIN}/v1/media-assets/us-asset/refresh`])
    expect(network.seen[1]?.headers.authorization).toBeUndefined()
    expect(network.seen[0]?.headers.authorization).toBe('Bearer fixture-us-app')
  })

  it('downloads a returned signed video URL intact instead of probing a domestic content route', async () => {
    const signed = 'https://media.vibedev.studio/v/a%2Fb.mp4?sig=a%2B%2F&expires=99'
    const network = fakeFetch(json(200, { id: 'us-video', status: 'queued' }), json(200, { id: 'us-video', status: 'completed', video: { url: signed }, effective: { charged_cny: '1.00' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
    const http = new GatewayHttp({ origin: US_GATEWAY_ORIGIN, fetch: network.fetch, userAgent: 'test', resolveCredential: async () => ({ kind: 'plugin', token: 'fixture-us-app' }) })
    const tracker = new TaskTracker({ http, store: new TaskStore(gatewayStateDirectory(dir, US_GATEWAY_ORIGIN)), sleep: async () => {} })
    try {
      await tracker.submit({ id: 'new-video', kind: 'video', model: 'fixture', label: 'fixture', createdAt: Date.now(), updatedAt: Date.now(), status: 'submitting', endpoint: '/v1/videos', body: {}, outputDir: join(dir, 'out'), stem: 'new' })
      await tracker.follow('new-video')
      expect(network.seen.map(request => request.url)).toEqual([`${US_GATEWAY_ORIGIN}/v1/videos`, `${US_GATEWAY_ORIGIN}/v1/videos/us-video`, signed])
      expect(network.seen[2]?.headers.authorization).toBeUndefined()
    } finally { tracker.dispose() }
  })

  it('refuses redirects instead of replaying a generation POST into another origin', async () => {
    let otherCalls = 0
    const other = createServer((_request, response) => { otherCalls++; response.end('{}') })
    const first = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/videos` }).end() })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    await new Promise<void>(resolve => first.listen(0, '127.0.0.1', resolve))
    try {
      const http = new GatewayHttp({ origin: `http://127.0.0.1:${(first.address() as AddressInfo).port}`, userAgent: 'test', resolveCredential: async () => ({ kind: 'plugin', token: 'fixture-token' }) })
      await expect(http.send('/v1/videos', { method: 'POST', json: {}, idempotencyKey: 'fixture-request' })).rejects.toThrow()
      expect(otherCalls).toBe(0)
    } finally { first.closeAllConnections(); other.closeAllConnections(); await Promise.all([new Promise<void>(resolve => first.close(() => resolve())), new Promise<void>(resolve => other.close(() => resolve()))]) }
  })

  it('keeps the 503 barrier and never retries a refused generation through another gateway', async () => {
    const network = fakeFetch(json(503, { error: { code: 'MIGRATION_NOT_READY', message: 'candidate is gated', retry_action: 'none' } }))
    const http = new GatewayHttp({ origin: US_GATEWAY_ORIGIN, fetch: network.fetch, userAgent: 'test', resolveCredential: async () => ({ kind: 'plugin', token: 'fixture-us-app' }) })
    await expect(http.send('/v1/videos', { method: 'POST', json: { model: 'fixture' }, idempotencyKey: 'fixture-request' })).rejects.toThrow()
    expect(network.seen.map(request => request.url)).toEqual([`${US_GATEWAY_ORIGIN}/v1/videos`])
  })
})
