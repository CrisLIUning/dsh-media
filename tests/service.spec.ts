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
import { parseSegments } from '../src/tools/transcribe.js'
import { CATALOG, MP4, PNG } from './fixtures.js'
import { json } from './helpers.js'

const GATEWAY = 'https://gw.test'

let state: string
let workspace: string
let seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[]
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
    [`GET ${GATEWAY}/v1/videos/vid_1/content`]: () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
  }
  vi.stubEnv('DSH_MEDIA_TEST_KEY', 'dev-key')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = { method: init?.method ?? 'GET', url: String(input), headers: { ...init?.headers as Record<string, string> | undefined }, body: init?.body }
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

/**
 * A PCM WAV of the given length. The header's byte rate is kept tiny so a
 * long recording stays small: only the header is read for the length.
 */
function wav(seconds: number, byteRate = 1000): Uint8Array {
  const size = Math.round(seconds * byteRate)
  const data = new Uint8Array(44 + size)
  const view = new DataView(data.buffer)
  const put = (offset: number, tag: string) => { for (let i = 0; i < 4; i++) data[offset + i] = tag.charCodeAt(i) }
  put(0, 'RIFF'); view.setUint32(4, 36 + size, true); put(8, 'WAVE')
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, byteRate, true); view.setUint32(28, byteRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  put(36, 'data'); view.setUint32(40, size, true)
  return data
}

const TRANSCRIBE = `POST ${GATEWAY}/v1/audio/transcriptions`
const posts = () => seen.filter(item => item.method === 'POST' && item.url.endsWith('/v1/audio/transcriptions'))
const form = (index = 0) => posts()[index]?.body as FormData

/** Let real I/O turns run while fake time moves on, until the condition holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < 400 && !condition(); turns++) {
    await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(500)
  }
}

/** Settle a promise whose waits run on fake timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  await until(() => done)
  return promise
}

describe('vibedevMedia transcribe', () => {
  afterEach(() => { vi.useRealTimers() })

  it('sends bytes as a background task under the caller\'s key, waits out a busy answer and polls to the final text', async () => {
    const { ctx, service } = await load()
    let busy = 1
    routes[TRANSCRIBE] = () => busy-- > 0
      ? json(503, { id: 'asr_0', status: 'failed', text: '', error: { code: 'AUDIO_CAPACITY_BUSY', message: 'full' } }, { 'retry-after': '0' })
      : json(202, { id: 'asr_1', object: 'audio.transcription', status: 'queued', text: '' })
    const polls = [
      { id: 'asr_1', status: 'in_progress', text: '你好' },
      { id: 'asr_1', status: 'completed', text: ' 你好，世界 ', duration: 7.2, effective: { charged_cny: '0.01' } },
    ]
    routes[`GET ${GATEWAY}/v1/audio/transcriptions/asr_1`] = () => json(200, polls.shift())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = await settle(service.transcribe({ data: wav(7), idempotencyKey: 'dsh-film-asr:t1:0:0' }, { cwd: workspace }, new AbortController().signal))
    // The empty text of the queued answer is not taken as the transcript.
    expect(result).toEqual({
      model: 'doubao-asr-vibedev', text: '你好，世界', language: 'zh', name: 'audio.wav', seconds: 7.2, taskId: 'asr_1', chargedCny: '0.01',
    })
    expect(posts()).toHaveLength(2)
    expect(posts().map(item => item.headers['idempotency-key'])).toEqual(['dsh-film-asr:t1:0:0', 'dsh-film-asr:t1:0:0'])
    expect(form().get('background')).toBe('true')
    expect(form().get('response_format')).toBe('json')
    expect(form().get('language')).toBe('zh')
    expect(form().get('model')).toBe('doubao-asr-vibedev')
    expect((form().get('file') as File).name).toBe('audio.wav')
    expect((form().get('file') as File).type).toBe('audio/wav')
    expect(seen.filter(item => item.url.endsWith('/asr_1'))).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('reads a workspace file, asks for timings and returns segments only when the answer has them', async () => {
    const { ctx, service } = await load()
    await writeFile(join(workspace, 'line.wav'), wav(3))
    routes[TRANSCRIBE] = () => json(200, {
      id: 'asr_2', status: 'completed', text: '第一句。第二句。',
      segments: [{ start: 0, end: 1.2, text: '第一句。' }, { start: 1.4, end: 2.9, text: '第二句。' }, { start: 3, end: 2, text: 'bad' }, { start: 3, end: 4, text: ' ' }],
    })
    const timed = await service.transcribe({ file: 'line.wav', timestamps: true, background: false }, { cwd: workspace }, new AbortController().signal)
    expect(timed.segments).toEqual([{ start: 0, end: 1.2, text: '第一句。' }, { start: 1.4, end: 2.9, text: '第二句。' }])
    expect(timed).toMatchObject({ name: 'line.wav', seconds: 3, taskId: 'asr_2' })
    expect(form().get('response_format')).toBe('verbose_json')
    expect(form().get('timestamp_granularities[]')).toBe('segment')
    expect(form().get('background')).toBeNull()
    // What the gateway answers today: the text and its length, no timings.
    routes[TRANSCRIBE] = () => json(200, { id: 'asr_3', status: 'completed', text: '只有文字', duration: 3 })
    const plain = await service.transcribe({ file: 'line.wav' }, { cwd: workspace }, new AbortController().signal)
    expect(plain).not.toHaveProperty('segments')
    expect(plain.text).toBe('只有文字')
    await ctx.fiber.dispose()
  })

  it('stops waiting when cancelled and names the gateway task that may still be charged', async () => {
    const { ctx, service } = await load()
    routes[TRANSCRIBE] = () => json(202, { id: 'asr_4', status: 'queued', text: '' })
    routes[`GET ${GATEWAY}/v1/audio/transcriptions/asr_4`] = () => json(200, { id: 'asr_4', status: 'in_progress', text: '' })
    const controller = new AbortController()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = service.transcribe({ data: wav(5) }, { cwd: workspace }, controller.signal)
    pending.catch(() => undefined)
    await until(() => seen.some(item => item.url.endsWith('/asr_4')))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED', message: expect.stringContaining('asr_4') })
    expect(seen.filter(item => item.url.endsWith('/asr_4'))).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('reports a failed gateway task', async () => {
    const { ctx, service } = await load()
    routes[TRANSCRIBE] = () => json(202, { id: 'asr_5', status: 'queued', text: '' })
    routes[`GET ${GATEWAY}/v1/audio/transcriptions/asr_5`] = () => json(200, { id: 'asr_5', status: 'failed', text: '', error: { code: 'TRANSCRIPTION_INTERRUPTED', message: 'session ended' } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await expect(settle(service.transcribe({ data: wav(5) }, { cwd: workspace }, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', message: expect.stringContaining('TRANSCRIPTION_INTERRUPTED') })
    await ctx.fiber.dispose()
  })

  it('lets the spending setting ask when the caller did not confirm, and refuses bad input before sending', async () => {
    const { ctx, service } = await load()
    const signal = new AbortController().signal
    routes[TRANSCRIBE] = () => json(200, { status: 'completed', text: 'x' })
    // confirmSpending is on and nobody can be asked here: nothing is sent.
    await expect(service.transcribe({ data: wav(2) }, { cwd: workspace }, signal, { confirmed: false }))
      .rejects.toMatchObject({ code: 'SPENDING_CONFIRMATION_UNAVAILABLE' })
    await expect(service.transcribe({ data: wav(11 * 60) }, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'AUDIO_TOO_LONG' })
    await expect(service.transcribe({ data: PNG }, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'AUDIO_FORMAT_UNSUPPORTED' })
    await expect(service.transcribe({ data: wav(2), file: 'line.wav' }, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'AUDIO_INPUT_INVALID' })
    await expect(service.transcribe({}, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'AUDIO_INPUT_INVALID' })
    await expect(service.transcribe({ data: new Uint8Array(20_000_001) }, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    expect(posts()).toHaveLength(0)
    routes[TRANSCRIBE] = () => json(402, { error: { code: 'INSUFFICIENT_BALANCE', message: 'low' } })
    await expect(service.transcribe({ data: wav(2) }, { cwd: workspace }, signal)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    await ctx.fiber.dispose()
  })
})

describe('parseSegments', () => {
  it('reads OpenAI segments in seconds and doubao utterances in milliseconds, and invents nothing', () => {
    expect(parseSegments({ text: 'a' })).toBeUndefined()
    expect(parseSegments({ segments: [] })).toEqual([])
    expect(parseSegments({ utterances: [{ start_time: 250, end_time: 1500, text: ' 你好 ' }, { start_time: 'x', end_time: 2, text: 'no' }] }))
      .toEqual([{ start: 0.25, end: 1.5, text: '你好' }])
    expect(parseSegments({ result: { utterances: [{ start_time: 0, end_time: 1000, text: '嗯' }] } })).toEqual([{ start: 0, end: 1, text: '嗯' }])
    expect(parseSegments({ segments: [{ start: -1, end: 1, text: 'neg' }, { start: 1, end: Number.NaN, text: 'nan' }] })).toEqual([])
  })
})
