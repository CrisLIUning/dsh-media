/** The `vibedevMedia` host service, as the film workbench calls it, against a fake gateway. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Media from '../src/index.js'
import type { MediaHostService, MediaTaskView } from '../src/index.js'
import { CATALOG, MP4, PNG } from './fixtures.js'
import { json } from './helpers.js'

const GATEWAY = 'https://gw.test'

let state: string
let workspace: string
let seen: { method: string; url: string; body: unknown }[]
let routes: Record<string, () => Response>

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'dsh-media-service-state-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-media-service-ws-'))
  seen = []
  routes = {
    [`GET ${GATEWAY}/v1/models`]: () => json(200, CATALOG),
    [`POST ${GATEWAY}/v1/images/generations`]: () => json(200, { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
    [`POST ${GATEWAY}/v1/media-assets/uploads`]: () => json(200, { asset_id: 'ma_1', upload_required: true, upload_url: 'https://oss.test/put/ma_1', upload_headers: {} }),
    'PUT https://oss.test/put/ma_1': () => new Response(null, { status: 200 }),
    [`POST ${GATEWAY}/v1/media-assets/ma_1/complete`]: () => json(200, { asset_id: 'ma_1', reference_url: `${GATEWAY}/v1/media-assets/ma_1/content?sig=r`, content_type: 'image/png' }),
    [`POST ${GATEWAY}/v1/videos`]: () => json(200, { id: 'vid_1', status: 'queued', effective: { estimated_cny: '4.95' } }),
    [`GET ${GATEWAY}/v1/videos/vid_1`]: () => json(200, { id: 'vid_1', status: 'completed', video: { url: 'https://cdn.test/vid_1.mp4' }, effective: { estimated_cny: '4.95', charged_cny: '4.95' } }),
    ['GET https://cdn.test/vid_1.mp4']: () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
  }
  vi.stubEnv('DSH_MEDIA_TEST_KEY', 'dev-key')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = { method: init?.method ?? 'GET', url: String(input), body: init?.body }
    seen.push(request)
    const route = routes[`${request.method} ${request.url}`]
    if (route === undefined) throw new Error(`no route for ${request.method} ${request.url}`)
    return route()
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(state, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

async function load() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Asking before spending is on: the service's callers confirm in their own interface.
  await ctx.plugin(Media, { gatewayOrigin: `${GATEWAY}/`, apiKeyEnv: 'DSH_MEDIA_TEST_KEY', stateDir: state, confirmSpending: true })
  const service = ctx.get('vibedevMedia') as MediaHostService | undefined
  if (service === undefined) throw new Error('vibedevMedia is not provided')
  return { ctx, service }
}

describe('vibedevMedia host service', () => {
  it('lists the models and generates an image into the folder the caller names', async () => {
    const { ctx, service } = await load()
    expect((await service.models()).map(model => model.id)).toContain('gpt-image-2.5-flare')
    const folder = join(workspace, 'film', 'canvas', 'media')
    const result = await service.generateImages({ prompt: 'a red apple' }, { cwd: workspace, folder, stem: 'image-abc' }, new AbortController().signal)
    expect(result).toMatchObject({ model: 'gpt-image-2.5-flare', images: [{ absolutePath: join(folder, 'image-abc.png'), mediaType: 'image/png', bytes: PNG.byteLength }] })
    expect(new Uint8Array(await readFile(join(folder, 'image-abc.png')))).toEqual(PNG)
    await ctx.fiber.dispose()
  })

  it('reads workspace-relative references against the caller\'s workspace', async () => {
    const { ctx, service } = await load()
    await writeFile(join(workspace, 'ref.png'), PNG)
    routes[`POST ${GATEWAY}/v1/images/edits`] = () => json(200, { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    const result = await service.generateImages({ prompt: 'same apple, blue', references: ['ref.png'] }, { cwd: workspace, folder: join(workspace, 'out'), stem: 'edit' }, new AbortController().signal)
    expect(result.images).toHaveLength(1)
    expect(seen.some(item => item.url.endsWith('/v1/images/edits'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('starts a video, follows it in the background and saves it where asked', async () => {
    const { ctx, service } = await load()
    const folder = join(workspace, 'film', 'canvas', 'media')
    const updates: MediaTaskView[] = []
    const started = await service.startVideo(
      { prompt: 'the apple rolls', referenceImages: [`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`] },
      { cwd: workspace, folder, stem: 'video-xyz' },
      new AbortController().signal,
    )
    expect(started).toMatchObject({ kind: 'video', model: 'seedance-2.0' })
    const stop = service.onTask(started.id, (task) => { updates.push(task) })
    let finished = await service.task(started.id)
    for (let tries = 0; tries < 100 && finished?.status !== 'completed'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      finished = await service.task(started.id)
    }
    stop()
    expect(finished).toMatchObject({ status: 'completed', chargedCny: '4.95' })
    expect(finished?.outputs?.[0]?.path).toBe(join(folder, 'video-xyz.mp4'))
    expect(new Uint8Array(await readFile(join(folder, 'video-xyz.mp4')))).toEqual(MP4)
    await ctx.fiber.dispose()
  })

  it('reports an unknown task as undefined', async () => {
    const { ctx, service } = await load()
    expect(await service.task('missing')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
