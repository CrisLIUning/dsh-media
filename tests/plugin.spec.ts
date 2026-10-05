/** The plugin loaded into a real tool runtime, against a fake gateway. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Media from '../src/index.js'
import { CATALOG, MP4, PNG, WAV } from './fixtures.js'
import { json } from './helpers.js'

const GATEWAY = 'https://gw.test'

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }

let dir: string
let seen: Seen[]
let routes: Record<string, (request: Seen) => Response>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-media-plugin-'))
  seen = []
  routes = {
    [`GET ${GATEWAY}/v1/models`]: () => json(200, CATALOG),
    [`POST ${GATEWAY}/v1/images/generations`]: () => json(200, { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
    [`POST ${GATEWAY}/v1/media-assets/uploads`]: () => json(200, { asset_id: 'ma_1', upload_required: true, upload_url: 'https://oss.test/put/ma_1', upload_headers: { 'x-oss-test': '1' } }),
    'PUT https://oss.test/put/ma_1': () => new Response(null, { status: 200 }),
    [`POST ${GATEWAY}/v1/media-assets/ma_1/complete`]: () => json(200, { asset_id: 'ma_1', reference_url: `${GATEWAY}/v1/media-assets/ma_1/content?sig=r`, content_type: 'image/png' }),
    [`POST ${GATEWAY}/v1/videos`]: () => json(200, { id: 'vid_1', status: 'queued', effective: { estimated_cny: '4.95' } }),
    [`GET ${GATEWAY}/v1/videos/vid_1`]: () => json(200, { id: 'vid_1', status: 'completed', video: { url: 'https://cdn.test/vid_1.mp4' }, effective: { estimated_cny: '4.95', charged_cny: '4.95' } }),
    [`GET ${GATEWAY}/v1/videos/vid_1/content`]: () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
  }
  vi.stubEnv('DSH_MEDIA_TEST_KEY', 'dev-key')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request: Seen = { method: init?.method ?? 'GET', url: String(input), headers: { ...init?.headers as Record<string, string> }, body: init?.body }
    seen.push(request)
    const route = routes[`${request.method} ${request.url}`]
    if (route === undefined) throw new Error(`no route for ${request.method} ${request.url}`)
    return route(request)
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function load() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Media, { gatewayOrigin: `${GATEWAY}/`, apiKeyEnv: 'DSH_MEDIA_TEST_KEY', stateDir: dir })
  let calls = 0
  const run = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
    ctx.tools.execute({ callId: ToolCallId(`call-${++calls}`), name, arguments: args, signal: new AbortController().signal })
  return { ctx, run }
}

const textOf = (result: ToolExecutionResult) => result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')

describe('dsh-media plugin', () => {
  it('registers its tools and guidance', async () => {
    const { ctx } = await load()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => /^(media|image|video|audio)_/.test(name)).sort()).toEqual([
      'audio_generate', 'audio_transcribe', 'image_generate', 'media_account', 'media_models', 'media_tasks', 'video_generate',
    ])
    await ctx.fiber.dispose()
  })

  it('lists the account\'s video models with what each mode accepts', async () => {
    const { ctx, run } = await load()
    const result = await run('media_models', { kind: 'video' })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('- seedance-2.0 — Seedance 2.0 720P; ¥0.99/s (720p)')
    expect(textOf(result)).toContain('omni_reference (reference images/videos/audios): reference_images 0-9, reference_videos 0-3, reference_audios 0-3')
    expect(seen[0]?.headers).toMatchObject({ authorization: 'Bearer dev-key', 'user-agent': `vibedev-plugin/${Media.version}` })
    await ctx.fiber.dispose()
  })

  it('generates an image and saves it', async () => {
    const { ctx, run } = await load()
    const result = await run('image_generate', { prompt: 'a red apple', filename: 'apple' })
    expect(result.isError).toBe(false)
    const file = join(dir, 'outputs', 'media', 'images', 'apple.png')
    expect(result.value).toMatchObject({ model: 'gpt-image-2.5-flare', estimatedCny: '0.10', images: [{ absolutePath: file, mediaType: 'image/png', bytes: PNG.byteLength }] })
    expect(new Uint8Array(await readFile(file))).toEqual(PNG)
    const request = seen.find(item => item.url.endsWith('/v1/images/generations'))
    expect(JSON.parse(request?.body as string)).toEqual({ model: 'gpt-image-2.5-flare', prompt: 'a red apple', n: 1 })
    await ctx.fiber.dispose()
  })

  it('uploads a reference, submits the video and saves the result', async () => {
    const { ctx, run } = await load()
    const result = await run('video_generate', {
      prompt: 'the apple from image 1 rolls across a table',
      reference_images: [`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`],
      filename: 'apple-roll',
    })
    expect(textOf(result)).toContain('finished with seedance-2.0')
    expect(result.value).toMatchObject({ status: 'completed', model: 'seedance-2.0', mode: 'omni_reference', duration: 5, estimatedCny: '4.95' })
    expect(new Uint8Array(await readFile(join(dir, 'outputs', 'media', 'videos', 'apple-roll.mp4')))).toEqual(MP4)
    const upload = seen.find(item => item.url === 'https://oss.test/put/ma_1')
    expect(upload?.headers.authorization).toBeUndefined()
    const submit = seen.find(item => item.method === 'POST' && item.url === `${GATEWAY}/v1/videos`)
    expect(JSON.parse(submit?.body as string)).toEqual({
      model: 'seedance-2.0', prompt: 'the apple from image 1 rolls across a table', duration: 5,
      referenceImages: [`${GATEWAY}/v1/media-assets/ma_1/content?sig=r`],
    })
    expect(submit?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    await ctx.fiber.dispose()
  })

  it('refuses a request no model can serve before uploading anything', async () => {
    const { ctx, run } = await load()
    const result = await run('video_generate', { prompt: 'dance', reference_audios: ['song.mp3'] })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('VIDEO_REQUEST_UNSUPPORTED')
    expect(textOf(result)).toContain('seedance-2.0: The omni_reference mode of seedance-2.0 needs reference_images or reference_videos')
    expect(seen.map(item => item.url)).toEqual([`${GATEWAY}/v1/models`])
    await ctx.fiber.dispose()
  })

  it('reports a balance refusal with its code for the client to route on', async () => {
    routes[`POST ${GATEWAY}/v1/images/generations`] = () => json(402, { error: { code: 'INSUFFICIENT_BALANCE', message: 'balance is 0' }, recharge_url: 'https://vibedev.test/purchase' })
    const { ctx, run } = await load()
    const result = await run('image_generate', { prompt: 'a red apple' })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'MediaError', code: 'INSUFFICIENT_BALANCE' })
    expect(textOf(result)).toContain('top up their VibeDev balance at https://vibedev.test/purchase')
    await ctx.fiber.dispose()
  })

  it('waits for a free transcription slot instead of failing at once', async () => {
    let busy = 3
    routes[`POST ${GATEWAY}/v1/audio/transcriptions`] = () => busy-- > 0
      ? json(503, { error: { code: 'AUDIO_CAPACITY_BUSY', message: 'two jobs running' } }, { 'retry-after': '0' })
      : json(200, { text: '你好，世界' })
    const { ctx, run } = await load()
    const result = await run('audio_transcribe', { file: `data:audio/wav;base64,${Buffer.from(WAV).toString('base64')}` })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ model: 'doubao-asr-vibedev', text: '你好，世界' })
    expect(seen.filter(item => item.url.endsWith('/v1/audio/transcriptions'))).toHaveLength(4)
    await ctx.fiber.dispose()
  })

  it('asks for a sign-in when nobody is signed in', async () => {
    vi.stubEnv('DSH_MEDIA_TEST_KEY', '')
    const { ctx, run } = await load()
    const result = await run('media_models', {})
    expect(result.error?.info?.code).toBe('NOT_SIGNED_IN')
    const status = await run('media_account', { action: 'status' })
    expect(status.value).toMatchObject({ source: 'none' })
    expect(seen).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('dsh-vibedev: the VibeDev models and the account routes', () => {
  async function loadWithHost() {
    const registered: Array<{ path: string; fetch: (request: Request) => Promise<Response> }> = []
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { registered.push(route); return () => {} } } } as never)
    await ctx.plugin(Media, { gatewayOrigin: `${GATEWAY}/`, apiKeyEnv: 'DSH_MEDIA_TEST_KEY', stateDir: dir })
    return { ctx, registered }
  }

  it('lists the gateway chat models on the vibedev-gateway route', async () => {
    const { ctx } = await loadWithHost()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels(Media.VIBEDEV_ROUTE)).map(model => model.id)).toEqual(['deepseek-v4-flash'])
    })
    const catalogRead = seen.find(item => item.url === `${GATEWAY}/v1/models` && item.headers.authorization === 'Bearer dev-key')
    expect(catalogRead).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('serves the account routes, reporting the credential and the listed models', async () => {
    routes[`GET ${GATEWAY}/v1/account/auth/me`] = () => json(200, { code: 0, data: { id: 1, nickname: 'dev', balance: 3, currency: 'CNY' } })
    const { ctx, registered } = await loadWithHost()
    expect(registered.map(route => route.path).sort()).toEqual([
      Media.ACCOUNT_ROUTE_PREFIX, `${Media.ACCOUNT_ROUTE_PREFIX}/cancel`, `${Media.ACCOUNT_ROUTE_PREFIX}/sign-in`, `${Media.ACCOUNT_ROUTE_PREFIX}/sign-out`,
    ])
    await vi.waitFor(async () => { expect(await ctx.llm.listModels(Media.VIBEDEV_ROUTE)).toHaveLength(1) })
    const view = registered.find(route => route.path === Media.ACCOUNT_ROUTE_PREFIX)
    const answer = await view?.fetch(new Request(`http://host${Media.ACCOUNT_ROUTE_PREFIX}`))
    expect(await answer?.json()).toMatchObject({ source: 'key', user: { nickname: 'dev' }, balance: { amount: '3', currency: 'CNY' }, models: { count: 1 } })
    await ctx.fiber.dispose()
  })

  it('lists no VibeDev models while nobody is signed in', async () => {
    vi.stubEnv('DSH_MEDIA_TEST_KEY', '')
    const { ctx } = await loadWithHost()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await ctx.llm.listModels(Media.VIBEDEV_ROUTE)).toEqual([])
    expect(seen.filter(item => item.url === `${GATEWAY}/v1/models`)).toEqual([])
    await ctx.fiber.dispose()
  })
})
