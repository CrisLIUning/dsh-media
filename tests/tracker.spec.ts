import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaError } from '../src/gateway/errors.js'
import { GatewayHttp } from '../src/gateway/http.js'
import { TaskStore } from '../src/tasks/store.js'
import type { TaskRecord } from '../src/tasks/store.js'
import { TaskTracker } from '../src/tasks/tracker.js'
import { M4A, MP4, WAV } from './fixtures.js'
import { bodyOf, fakeFetch, json } from './helpers.js'

const ORIGIN = 'https://vibedev.example.com'
let dir: string

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-media-tracker-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A tracker on a fake gateway whose `sleep` advances the clock instead of waiting. */
function setup(fetch: typeof globalThis.fetch, options: { store?: TaskStore; downloadAttempts?: number; onWait?: (ms: number) => void } = {}) {
  const clock = { now: Date.parse('2026-10-03T09:00:00Z') }
  const now = () => clock.now
  const http = new GatewayHttp({ origin: ORIGIN, userAgent: 'vibedev-plugin/test', fetch, resolveCredential: async () => ({ token: 'tok', kind: 'account' }), sleep: async () => {} })
  const store = options.store ?? new TaskStore(join(dir, 'state'), now)
  const waits: number[] = []
  const tracker = new TaskTracker({
    http, store, now, sleep: async (ms) => { waits.push(ms); options.onWait?.(ms); clock.now += ms },
    ...options.downloadAttempts === undefined ? {} : { downloadAttempts: options.downloadAttempts },
  })
  return { http, store, tracker, waits, clock }
}

const completed = (id: string, extra: Record<string, unknown> = {}) =>
  json(200, { id, status: 'completed', video: { url: `https://cdn.example.com/${id}.mp4` }, effective: { charged_cny: '1.00' }, ...extra })

function draft(kind: TaskRecord['kind'], extra: Partial<TaskRecord> = {}): TaskRecord {
  const at = Date.parse('2026-10-03T09:00:00Z')
  return {
    id: `task-${kind}`, kind, model: kind === 'video' ? 'seedance-2.0' : 'doubao-music-vibedev', label: 'a cat', createdAt: at, updatedAt: at,
    outputDir: join(dir, 'out'), stem: 'cat', endpoint: kind === 'video' ? '/v1/videos' : '/v1/audio/generations',
    body: { model: 'm', prompt: 'a cat' }, status: 'submitting', ...extra,
  }
}

describe('TaskTracker', () => {
  it('submits under the task id as idempotency key, follows the task and saves the video', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, { id: 'vid_1', object: 'video', status: 'queued', effective: { estimated_cny: '4.95' } }),
      json(200, { id: 'vid_1', status: 'in_progress', progress: 40 }),
      json(200, {
        id: 'vid_1', status: 'completed', video: { url: 'https://cdn.example.com/vid_1.mp4' },
        asset: { content_type: 'video/mp4', duration_ms: 5040 }, effective: { estimated_cny: '4.95', charged_cny: '4.95' },
      }),
      new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
    )
    const { tracker, store, waits } = setup(fetch)
    const progress: string[] = []
    tracker.onUpdate('task-video', record => { if (record.progress !== undefined) progress.push(record.progress) })
    const accepted = await tracker.submit(draft('video'))
    expect(accepted).toMatchObject({ status: 'pending', gatewayId: 'vid_1', estimatedCny: '4.95' })
    const final = await tracker.follow('task-video')
    expect(final).toMatchObject({ status: 'completed', chargedCny: '4.95', outputs: [{ path: join(dir, 'out', 'cat.mp4'), bytes: MP4.byteLength, durationSeconds: 5.04, url: 'https://cdn.example.com/vid_1.mp4' }] })
    expect(new Uint8Array(await readFile(join(dir, 'out', 'cat.mp4')))).toEqual(MP4)
    expect(seen.map(request => `${request.method} ${request.url}`)).toEqual([
      `POST ${ORIGIN}/v1/videos`, `GET ${ORIGIN}/v1/videos/vid_1`, `GET ${ORIGIN}/v1/videos/vid_1`, `GET ${ORIGIN}/v1/videos/vid_1/content`,
    ])
    expect(seen[0]?.headers['idempotency-key']).toBe('task-video')
    expect(bodyOf(seen[0])).toEqual({ model: 'm', prompt: 'a cat' })
    expect(seen[3]?.headers.authorization).toBe('Bearer tok')
    expect(progress).toEqual(['queued', 'in progress 40%', 'saving the result'])
    expect(waits).toEqual([6_000])
    expect((await store.get('task-video'))?.status).toBe('completed')
    expect((await readdir(join(dir, 'out'))).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('saves every output of a music task from its no-login links', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, { id: 'aud_1', kind: 'music', status: 'queued' }),
      json(200, {
        id: 'aud_1', status: 'succeeded', effective: { charged_cny: 0.5 },
        outputs: [
          { asset_id: 'a1', content_url: `${ORIGIN}/v1/media-assets/a1/content?sig=1`, content_type: 'audio/mp4', title: 'Cat Song', duration_seconds: 151 },
          { asset_id: 'a2', content_url: `${ORIGIN}/v1/media-assets/a2/content?sig=2`, content_type: 'audio/mp4', title: 'Cat Song (alt)' },
        ],
      }),
      new Response(M4A), new Response(WAV),
    )
    const { tracker } = setup(fetch)
    await tracker.submit(draft('audio'))
    const final = await tracker.follow('task-audio')
    expect(final.chargedCny).toBe('0.50')
    expect(final.outputs?.map(output => [output.path, output.title, output.durationSeconds])).toEqual([
      [join(dir, 'out', 'cat-1.m4a'), 'Cat Song', 151], [join(dir, 'out', 'cat-2.m4a'), 'Cat Song (alt)', undefined],
    ])
    // No-login links are fetched without the credential.
    expect(seen.slice(2).map(request => request.headers.authorization)).toEqual([undefined, undefined])
  })

  it('records a failed task with the gateway reason', async () => {
    const { fetch } = fakeFetch(
      json(200, { id: 'vid_2', status: 'queued' }),
      json(200, { id: 'vid_2', status: 'failed', error: { code: 'CONTENT_REJECTED', message: 'the prompt was rejected by the provider' } }),
    )
    const { tracker } = setup(fetch)
    await tracker.submit(draft('video', { id: 'v2' }))
    expect(await tracker.follow('v2')).toMatchObject({ status: 'failed', error: { code: 'CONTENT_REJECTED', message: 'the prompt was rejected by the provider' } })
  })

  it('forgets a submission the gateway refused, and keeps the refusal code', async () => {
    const { fetch } = fakeFetch(json(429, { error: { code: 'VIDEO_TASK_LIMIT_REACHED', message: 'limit', limit: 3, active: 3 } }, { 'retry-after': '30' }))
    const { tracker, store } = setup(fetch)
    await expect(tracker.submit(draft('video'))).rejects.toMatchObject({ code: 'VIDEO_TASK_LIMIT_REACHED' })
    expect(await store.list()).toEqual([])
  })

  it('resends an unconfirmed submission under the same key', async () => {
    const { fetch, seen } = fakeFetch(
      json(502, { error: { message: 'bad gateway' } }),
      json(200, { id: 'vid_3', status: 'queued' }),
      json(200, { id: 'vid_3', status: 'completed', video: { url: 'https://cdn.example.com/v.mp4' }, effective: { charged_cny: '1.00' } }),
      new Response(MP4),
    )
    const { tracker } = setup(fetch)
    await tracker.submit(draft('video', { id: 'v3' }))
    expect((await tracker.follow('v3')).status).toBe('completed')
    expect(seen.slice(0, 2).map(request => request.headers['idempotency-key'])).toEqual(['v3', 'v3'])
  })

  it('keeps an unanswered submission and resends it in the background', async () => {
    const down = () => { throw new TypeError('fetch failed') }
    const { fetch, seen } = fakeFetch(down, down, down, json(200, { id: 'vid_4', status: 'failed', error: { message: 'no' } }))
    const { tracker, store } = setup(fetch)
    const error = await tracker.submit(draft('video', { id: 'v4' })).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MediaError)
    expect(error).toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' })
    expect((error as Error).message).toContain('do not submit the same request again')
    expect((await tracker.follow('v4')).status).toBe('failed')
    expect(seen.every(request => request.headers['idempotency-key'] === 'v4')).toBe(true)
    expect((await store.get('v4'))?.gatewayId).toBe('vid_4')
  })

  it('waits while the balance is used up, then carries on', async () => {
    const { fetch } = fakeFetch(
      json(402, { error: { code: 'INSUFFICIENT_BALANCE', message: 'balance is 0' }, recharge_url: 'https://x/recharge' }),
      json(200, { id: 'vid_5', status: 'completed', video: { url: 'https://cdn.example.com/v.mp4' }, effective: { charged_cny: '2.00' } }),
      new Response(MP4),
    )
    const { tracker, store, waits } = setup(fetch)
    await store.add(draft('video', { id: 'v5', status: 'pending', gatewayId: 'vid_5' }))
    const progress: string[] = []
    tracker.onUpdate('v5', record => { if (record.progress !== undefined) progress.push(record.progress) })
    expect((await tracker.follow('v5')).status).toBe('completed')
    expect(progress[0]).toContain('balance is used up')
    expect(waits).toEqual([60_000])
  })

  it('treats a gateway error carrying its own code as an open outcome', async () => {
    const { fetch, seen } = fakeFetch(json(500, { error: { type: 'server_error', code: 'upstream_error', message: 'boom' } }), json(200, { id: 'vid_7', status: 'queued' }), completed('vid_7'), new Response(MP4))
    const { tracker } = setup(fetch)
    expect(await tracker.submit(draft('video', { id: 'v7' }))).toMatchObject({ status: 'pending', gatewayId: 'vid_7' })
    expect((await tracker.follow('v7')).status).toBe('completed')
    expect(seen.slice(0, 2).map(request => request.headers['idempotency-key'])).toEqual(['v7', 'v7'])
  })

  it('resends under the same key while an earlier submission is still in progress', async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: 'VIDEO_SUBMISSION_IN_PROGRESS', message: 'in progress', retryable: true } }), json(200, { id: 'vid_8', status: 'queued' }), completed('vid_8'), new Response(MP4))
    const { tracker } = setup(fetch)
    expect((await tracker.submit(draft('video', { id: 'v8' }))).gatewayId).toBe('vid_8')
    expect((await tracker.follow('v8')).status).toBe('completed')
  })

  it('stops at VIDEO_SUBMISSION_AMBIGUOUS, which created nothing and charges nothing', async () => {
    const down = () => { throw new TypeError('fetch failed') }
    const { fetch, seen } = fakeFetch(down, json(409, { error: { code: 'VIDEO_SUBMISSION_AMBIGUOUS', message: 'ambiguous', retryable: false } }))
    const { tracker, store } = setup(fetch)
    const error = await tracker.submit(draft('video', { id: 'v9' })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'VIDEO_SUBMISSION_AMBIGUOUS' })
    expect((error as Error).message).toContain('charged nothing')
    expect(await store.get('v9')).toMatchObject({ status: 'failed', error: { code: 'VIDEO_SUBMISSION_AMBIGUOUS' } })
    expect(seen).toHaveLength(2)
  })

  it('keeps following a task it failed to record after the gateway accepted it', async () => {
    class FlakyStore extends TaskStore {
      failures = 1
      override async update(id: string, patch: Parameters<TaskStore['update']>[1]) {
        if (this.failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
        return super.update(id, patch)
      }
    }
    const { fetch } = fakeFetch(json(200, { id: 'vid_10', status: 'queued' }), completed('vid_10'), new Response(MP4))
    const store = new FlakyStore(join(dir, 'state'))
    const { tracker } = setup(fetch, { store })
    expect(await tracker.submit(draft('video', { id: 'v10' }))).toMatchObject({ status: 'pending', gatewayId: 'vid_10' })
    expect((await tracker.follow('v10')).status).toBe('completed')
  })

  it('keeps a task open when the plugin stops mid-download, and finishes it after a restart', async () => {
    let started!: () => void
    const downloading = new Promise<void>((resolve) => { started = resolve })
    const hang = (_request: unknown, init: RequestInit | undefined) => new Promise<Response>((_resolve, reject) => {
      started()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const first = setup(fakeFetch(completed('vid_11'), hang).fetch)
    await first.store.add(draft('video', { id: 'v11', status: 'pending', gatewayId: 'vid_11' }))
    const followed = first.tracker.follow('v11')
    await downloading
    first.tracker.dispose()
    expect((await followed).status).toBe('pending')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readdir(join(dir, 'out')).catch(() => [])).toEqual([])

    const second = setup(fakeFetch(completed('vid_11'), new Response(MP4)).fetch)
    await second.tracker.resume()
    expect(await second.tracker.follow('v11')).toMatchObject({ status: 'completed', outputs: [{ path: join(dir, 'out', 'cat.mp4') }] })
  })

  it('retries a failed download before reporting the links instead', async () => {
    const { fetch } = fakeFetch(completed('vid_12'), new Response('gone', { status: 404 }), new Response('gone', { status: 404 }), completed('vid_12'), new Response(MP4))
    const { tracker, store } = setup(fetch, { downloadAttempts: 2 })
    await store.add(draft('video', { id: 'v12', status: 'pending', gatewayId: 'vid_12' }))
    const final = await tracker.follow('v12')
    expect(final).toMatchObject({ status: 'completed', outputs: [{ path: join(dir, 'out', 'cat.mp4') }] })
    expect(final.error).toBeUndefined()

    const gone = fakeFetch(completed('vid_13'), new Response('gone', { status: 404 }), new Response('gone', { status: 404 }))
    const once = setup(gone.fetch, { downloadAttempts: 1, store })
    await store.add(draft('video', { id: 'v13', status: 'pending', gatewayId: 'vid_13' }))
    expect(await once.tracker.follow('v13')).toMatchObject({
      status: 'completed', error: { code: 'DOWNLOAD_FAILED' }, outputs: [{ url: 'https://cdn.example.com/vid_13.mp4' }],
    })
  })

  it('leaves a task to the process that holds its claim', async () => {
    let answer!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { answer = resolve })
    const ownerFetch = fakeFetch(() => gate, new Response(MP4))
    const owner = setup(ownerFetch.fetch)
    await owner.store.add(draft('video', { id: 'v14', status: 'pending', gatewayId: 'vid_14' }))
    const owned = owner.tracker.follow('v14')
    while (ownerFetch.seen.length === 0) await new Promise(resolve => setTimeout(resolve, 2))
    // A second process sharing the state directory.
    const bystander = fakeFetch()
    const http = new GatewayHttp({ origin: ORIGIN, userAgent: 'ua', fetch: bystander.fetch, resolveCredential: async () => ({ token: 'tok', kind: 'account' }) })
    const other = new TaskTracker({ http, store: owner.store, sleep: () => new Promise(resolve => setTimeout(resolve, 5)) })
    const watching = other.follow('v14')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(bystander.seen).toEqual([])
    answer(completed('vid_14'))
    expect((await owned).status).toBe('completed')
    expect((await watching).status).toBe('completed')
    expect(bystander.seen).toEqual([])
  })

  it('ends a refused resend after an unanswered attempt with the gateway reason, and stops sending it', async () => {
    const down = () => { throw new TypeError('fetch failed') }
    const refused = () => json(402, { error: { code: 'INSUFFICIENT_BALANCE', message: 'estimated ¥2.40, available ¥1.10', stage: 'admission' } })
    const { fetch, seen } = fakeFetch(down, refused, ...Array.from({ length: 12 }, () => refused))
    const { tracker, store } = setup(fetch)
    // The refusal is the caller's answer now: no waiting for a grace that used to resend a refused request.
    await expect(tracker.submit(draft('video', { id: 'v15' }))).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect(await tracker.follow('v15')).toMatchObject({ status: 'failed', error: { code: 'INSUFFICIENT_BALANCE' } })
    expect((await store.get('v15'))?.status).toBe('failed')
    expect(seen).toHaveLength(2)
  })

  it('treats a structured rejection as final: one submission, no resend in the background', async () => {
    const rejected = json(502, {
      error: {
        code: 'PROVIDER_REQUEST_REJECTED', message: 'reference audio duration must be between 1 and 15 seconds',
        submission_state: 'rejected', retry_action: 'none', retryable: true,
      },
    })
    const { fetch, seen } = fakeFetch(rejected, rejected, rejected, rejected)
    const { tracker, store } = setup(fetch)
    // retryable: true says recovery is still needed; retry_action: none is what forbids creating anything again.
    const error = await tracker.submit(draft('video', { id: 'v17' })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' })
    expect((error as Error).message).toContain('reference audio duration')
    expect(seen).toHaveLength(1)
    await tracker.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toHaveLength(1)
    expect(await store.list()).toEqual([])
  })

  it('saves a rejection the background met after an unanswered attempt, and never resends it', async () => {
    const down = () => { throw new TypeError('fetch failed') }
    const rejected = json(502, { error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'reference audio is 27.07 s; at most 15 s', submission_state: 'rejected', retry_action: 'none' } })
    const { fetch, seen } = fakeFetch(down, rejected, rejected, rejected)
    const { tracker, store } = setup(fetch)
    await expect(tracker.submit(draft('video', { id: 'v18' }))).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' })
    const record = await tracker.follow('v18')
    expect(record).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_REQUEST_REJECTED' } })
    expect(record.error?.message).toContain('27.07 s')
    expect(seen).toHaveLength(2)
    // A restart resumes only what is unfinished; a rejected submission is never sent again.
    await tracker.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toHaveLength(2)
    expect((await store.get('v18'))?.status).toBe('failed')
  })

  it('reconciles an unknown submission under the same key and never mints another', async () => {
    const { fetch, seen } = fakeFetch(
      json(502, { error: { message: 'bad gateway', submission_state: 'unknown', retry_action: 'reconcile', retryable: true } }),
      json(200, { id: 'vid_19', status: 'queued' }),
      completed('vid_19'),
      new Response(MP4),
    )
    const { tracker } = setup(fetch)
    expect(await tracker.submit(draft('video', { id: 'v19' }))).toMatchObject({ status: 'pending', gatewayId: 'vid_19' })
    expect((await tracker.follow('v19')).status).toBe('completed')
    expect(new Set(seen.filter(request => request.method === 'POST').map(request => request.headers['idempotency-key']))).toEqual(new Set(['v19']))
  })

  it('only polls a task it already has, and a failed poll submits nothing', async () => {
    const { fetch, seen } = fakeFetch(
      json(500, { error: { message: 'gateway hiccup' } }),
      json(500, { error: { message: 'gateway hiccup' } }),
      completed('vid_20'),
      new Response(MP4),
    )
    const { tracker, store } = setup(fetch)
    await store.add(draft('video', { id: 'v20', status: 'pending', gatewayId: 'vid_20' }))
    expect((await tracker.follow('v20')).status).toBe('completed')
    expect(seen.filter(request => request.method === 'POST')).toEqual([])
    expect(seen.every(request => request.headers['idempotency-key'] === undefined)).toBe(true)
    expect(await store.get('v20')).toMatchObject({ status: 'completed', gatewayId: 'vid_20' })
  })

  it('stops on the person\'s cancel: no further submission, and nothing resumes it', async () => {
    const down = () => { throw new TypeError('fetch failed') }
    const { fetch, seen } = fakeFetch(down, down, down, down)
    const controller = new AbortController()
    // The cancel lands while the tracker is settling the unanswered attempt.
    const { tracker, store } = setup(fetch, { onWait: () => controller.abort() })
    const error = await tracker.submit(draft('video', { id: 'v23' }), controller.signal).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'ABORTED' })
    expect((await store.get('v23'))?.status).toBe('lost')
    const sent = seen.length
    await tracker.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toHaveLength(sent)
  })

  it('gives each user-asked request its own key, and an accepted submission only its own', async () => {
    // Each answer completes on the spot, so no follow-up poll interleaves with the two submissions.
    const { fetch, seen } = fakeFetch(completed('vid_21'), new Response(MP4), completed('vid_22'), new Response(MP4))
    const { tracker } = setup(fetch)
    await tracker.submit(draft('video', { id: 'v21' }))
    await tracker.submit(draft('video', { id: 'v22' }))
    expect(seen.filter(request => request.method === 'POST').map(request => request.headers['idempotency-key'])).toEqual(['v21', 'v22'])
  })

  it('resumes unfinished tasks after a restart and gives up on stale ones', async () => {
    const { fetch } = fakeFetch(
      json(200, { id: 'vid_6', status: 'completed', video: { url: 'https://cdn.example.com/v.mp4' }, effective: { charged_cny: '1.00' } }),
      new Response(MP4),
    )
    const first = setup(fetch)
    await first.store.add(draft('video', { id: 'live', status: 'pending', gatewayId: 'vid_6' }))
    await first.store.add(draft('video', { id: 'stale', status: 'submitting', createdAt: Date.parse('2026-10-03T08:00:00Z') }))
    // A new process: a fresh store reading the same file.
    const second = setup(fetch)
    await second.tracker.resume()
    expect((await second.tracker.follow('live')).status).toBe('completed')
    expect(await second.tracker.follow('stale')).toMatchObject({ status: 'lost', error: { code: 'SUBMISSION_UNCONFIRMED' } })
  })

  it('does not resend while a submission is still running', async () => {
    let answer!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    const { fetch, seen } = fakeFetch(() => pending, completed('vid_16'), new Response(MP4))
    const { tracker } = setup(fetch)
    const submitting = tracker.submit(draft('video', { id: 'v16' }))
    while (seen.length === 0) await new Promise(resolve => setTimeout(resolve, 2))
    const followed = tracker.follow('v16')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen.filter(request => request.method === 'POST')).toHaveLength(1)
    answer(json(200, { id: 'vid_16', status: 'queued' }))
    await submitting
    expect((await followed).status).toBe('completed')
    expect(seen.filter(request => request.method === 'POST')).toHaveLength(1)
  })
})
