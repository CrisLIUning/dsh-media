import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MediaLibrary } from '../src/gateway/assets.js'
import { MediaError } from '../src/gateway/errors.js'
import { GatewayHttp } from '../src/gateway/http.js'
import type { LoadedMedia } from '../src/media/sources.js'
import { MP4, PNG } from './fixtures.js'
import { bodyOf, fakeFetch, json } from './helpers.js'

const ORIGIN = 'https://vibedev.example.com'
const clip: LoadedMedia = { source: 'clips/a.mp4', name: 'a.mp4', mime: 'video/mp4', data: MP4 }
const digest = createHash('sha256').update(MP4).digest('hex')

function library(fetch: typeof globalThis.fetch, now = () => Date.parse('2026-10-03T08:00:00Z')) {
  const http = new GatewayHttp({
    origin: ORIGIN, userAgent: 'vibedev-plugin/0.1.0', fetch,
    resolveCredential: async () => ({ token: 'tok', kind: 'account' }),
    sleep: async () => {},
  })
  return new MediaLibrary(http, now)
}

const completed = (id: string, extra: Record<string, unknown> = {}) => json(200, {
  asset_id: id, status: 'ready', content_type: 'video/mp4', size_bytes: MP4.byteLength,
  reference_url: `${ORIGIN}/v1/media-assets/${id}/content?sig=r`, content_url: `${ORIGIN}/v1/media-assets/${id}/content`,
  expires_at: '2026-10-04T08:00:00Z', duration_ms: 4040, ...extra,
})

describe('MediaLibrary', () => {
  it('declares the upload, puts the bytes with the returned headers and no credential, then completes it', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, {
        asset_id: 'ma_1', upload_required: true, upload_url: 'https://oss.example.com/put?sig=1',
        upload_headers: { 'Content-Type': 'video/mp4', 'x-oss-object-acl': 'private' }, expires_at: '2026-10-03T09:00:00Z',
      }),
      new Response(null, { status: 200 }),
      completed('ma_1'),
    )
    const asset = await library(fetch).upload(clip, 'video_reference')
    expect(asset).toEqual({
      assetId: 'ma_1', referenceUrl: `${ORIGIN}/v1/media-assets/ma_1/content?sig=r`, contentUrl: `${ORIGIN}/v1/media-assets/ma_1/content`,
      contentType: 'video/mp4', expiresAt: '2026-10-04T08:00:00Z', durationMs: 4040, sha256: digest, bytes: MP4.byteLength,
    })
    expect(seen.map(request => `${request.method} ${request.url}`)).toEqual([
      `POST ${ORIGIN}/v1/media-assets/uploads`, 'PUT https://oss.example.com/put?sig=1', `POST ${ORIGIN}/v1/media-assets/ma_1/complete`,
    ])
    expect(bodyOf(seen[0])).toEqual({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: MP4.byteLength, sha256: digest, purpose: 'video_reference' })
    expect(seen[1]?.headers).toMatchObject({ 'content-type': 'video/mp4', 'x-oss-object-acl': 'private' })
    expect(seen[1]?.headers.authorization).toBeUndefined()
    expect(seen[1]?.body).toBe(MP4)
    expect(seen[2]?.headers.authorization).toBe('Bearer tok')
  })

  it('reuses an asset it already uploaded, and refreshes one that is about to expire', async () => {
    let now = Date.parse('2026-10-03T08:00:00Z')
    const { fetch, seen } = fakeFetch(
      json(200, { asset_id: 'ma_1', upload_url: 'https://oss.example.com/put?sig=1' }),
      new Response(null, { status: 200 }),
      completed('ma_1', { expires_at: '2026-10-03T09:00:00Z' }),
      completed('ma_1', { expires_at: '2026-10-04T09:00:00Z', reference_url: `${ORIGIN}/v1/media-assets/ma_1/content?sig=r2` }),
    )
    const media = library(fetch, () => now)
    await media.upload(clip, 'video_reference')
    expect((await media.upload({ ...clip, source: 'copy.mp4' }, 'video_reference')).assetId).toBe('ma_1')
    expect(seen).toHaveLength(3)
    now = Date.parse('2026-10-03T08:55:00Z')
    expect((await media.upload(clip, 'video_reference')).referenceUrl).toBe(`${ORIGIN}/v1/media-assets/ma_1/content?sig=r2`)
    expect(seen.at(-1)?.url).toBe(`${ORIGIN}/v1/media-assets/ma_1/refresh`)
  })

  it('reads back an asset the library already holds instead of uploading it again', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, { asset_id: 'ma_9', upload_required: false, reference_url: `${ORIGIN}/v1/media-assets/ma_9/content?sig=old` }),
      completed('ma_9', { duration_ms: 6000 }),
    )
    const asset = await library(fetch).upload(clip, 'video_reference')
    expect(asset).toMatchObject({ assetId: 'ma_9', durationMs: 6000, referenceUrl: `${ORIGIN}/v1/media-assets/ma_9/content?sig=r` })
    expect(seen.map(request => request.url)).toEqual([`${ORIGIN}/v1/media-assets/uploads`, `${ORIGIN}/v1/media-assets/ma_9/refresh`])
  })

  it('falls back to the declared answer when the read-back fails', async () => {
    const { fetch } = fakeFetch(
      json(200, { asset_id: 'ma_9', upload_required: false, reference_url: `${ORIGIN}/v1/media-assets/ma_9/content?sig=old`, content_type: 'image/png' }),
      json(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    )
    const image: LoadedMedia = { source: 'a.png', name: 'a.png', mime: 'image/png', data: PNG }
    expect(await library(fetch).upload(image, 'video_reference')).toMatchObject({ assetId: 'ma_9', referenceUrl: `${ORIGIN}/v1/media-assets/ma_9/content?sig=old` })
  })

  it('resolves a relative upload address on the gateway', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, { asset_id: 'ma_2', upload_url: '/v1/media-assets/ma_2/blob?sig=2' }),
      new Response(null, { status: 200 }),
      completed('ma_2'),
    )
    await library(fetch).upload(clip, 'video_reference')
    expect(seen[1]?.url).toBe(`${ORIGIN}/v1/media-assets/ma_2/blob?sig=2`)
  })

  it('never puts a download link into a request in place of the reference URL', async () => {
    const { fetch } = fakeFetch(
      json(200, { asset_id: 'ma_4', upload_url: 'https://oss.example.com/put?sig=4' }),
      new Response(null, { status: 200 }),
      json(200, { asset_id: 'ma_4', content_url: `${ORIGIN}/v1/media-assets/ma_4/content` }),
    )
    await expect(library(fetch).upload(clip, 'video_reference')).rejects.toMatchObject({ code: 'ASSET_REFERENCE_MISSING' })
  })

  it('forgets remembered assets after an account change', async () => {
    const { fetch, seen } = fakeFetch(
      json(200, { asset_id: 'ma_1', upload_required: false, reference_url: `${ORIGIN}/r1` }), completed('ma_1'),
      json(200, { asset_id: 'ma_2', upload_required: false, reference_url: `${ORIGIN}/r2` }), completed('ma_2'),
    )
    const media = library(fetch)
    expect((await media.upload(clip, 'video_reference')).assetId).toBe('ma_1')
    media.clear()
    expect((await media.upload(clip, 'video_reference')).assetId).toBe('ma_2')
    expect(seen.filter(request => request.url.endsWith('/uploads'))).toHaveLength(2)
  })

  it('names the file when the gateway refuses or answers without an address', async () => {
    const refused = fakeFetch(json(415, { error: { code: 'MEDIA_ASSET_TYPE_UNSUPPORTED', message: 'video/webm is not accepted' } }))
    const error = await library(refused.fetch).upload(clip, 'video_reference').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MediaError)
    expect(error).toMatchObject({ code: 'MEDIA_ASSET_TYPE_UNSUPPORTED', details: { status: 415 } })

    const empty = fakeFetch(json(200, { upload_required: true }))
    await expect(library(empty.fetch).upload(clip, 'video_reference')).rejects.toMatchObject({ code: 'ASSET_UPLOAD_REFUSED' })

    const noUrl = fakeFetch(json(200, { asset_id: 'ma_3' }))
    await expect(library(noUrl.fetch).upload(clip, 'video_reference')).rejects.toMatchObject({ code: 'ASSET_UPLOAD_URL_MISSING' })
  })
})
