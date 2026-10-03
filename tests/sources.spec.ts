import { describe, expect, it } from 'vitest'
import { extensionFor, loadMedia, sniffMime } from '../src/media/sources.js'
import type { SourceReader } from '../src/media/sources.js'
import { GIF, JPEG, M4A, MOV, MP3, MP4, PNG, WAV, WEBM } from './fixtures.js'
import { fakeFetch } from './helpers.js'

const noPaths: SourceReader = { readPath: async () => { throw new Error('no paths here') } }

describe('sniffMime', () => {
  it('reads the type from the file header', () => {
    expect([PNG, JPEG, GIF, MP4, MOV, M4A, WAV, MP3, WEBM].map(data => sniffMime(data))).toEqual([
      'image/png', 'image/jpeg', 'image/gif', 'video/mp4', 'video/quicktime', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'video/webm',
    ])
    expect(sniffMime(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg')
  })

  it('trusts the header over the name, and the name only when the header is unknown', () => {
    expect(sniffMime(JPEG, 'photo.png')).toBe('image/jpeg')
    expect(sniffMime(WEBM, 'clip.mkv')).toBe('video/x-matroska')
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'song.MP3')).toBe('audio/mpeg')
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'https://x.test/a.mov?sig=1')).toBe('video/quicktime')
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'notes.txt')).toBe('application/octet-stream')
  })

  it('maps types back to extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('audio/mpeg; charset=binary')).toBe('mp3')
    expect(extensionFor('application/x-unknown')).toBe('bin')
  })
})

describe('loadMedia', () => {
  it('decodes data URLs, with or without parameters', async () => {
    const base64 = Buffer.from(PNG).toString('base64')
    expect(await loadMedia(`data:image/png;base64,${base64}`, noPaths, 1024)).toEqual({ source: 'inline data', name: 'inline.png', mime: 'image/png', data: PNG })
    expect((await loadMedia(`data:image/jpeg;name=x.jpg;base64,${base64}`, noPaths, 1024)).mime).toBe('image/png')
    expect((await loadMedia('data:audio/wav,%00%01', noPaths, 1024)).mime).toBe('audio/wav')
    await expect(loadMedia(`data:image/png;base64,${base64}`, noPaths, 4)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
  })

  it('downloads links, naming the file from the URL and typing it from its bytes', async () => {
    const { fetch, seen } = fakeFetch(new Response(JPEG, { headers: { 'content-type': 'application/octet-stream' } }))
    expect(await loadMedia('https://cdn.example.com/refs/%E5%9B%BE.png?x=1', { ...noPaths, fetch }, 1024)).toEqual({
      source: 'https://cdn.example.com/refs/%E5%9B%BE.png?x=1', name: '图.png', mime: 'image/jpeg', data: JPEG,
    })
    expect(seen[0]?.headers.authorization).toBeUndefined()
    const bare = fakeFetch(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }))
    expect(await loadMedia('https://cdn.example.com/stream', { ...noPaths, fetch: bare.fetch }, 1024)).toMatchObject({ name: 'stream.mp3', mime: 'audio/mpeg' })
  })

  it('stops a download that is larger than the limit', async () => {
    const declared = fakeFetch(new Response(new Uint8Array(10), { headers: { 'content-length': '5000' } }))
    await expect(loadMedia('https://x.test/a.mp4', { ...noPaths, fetch: declared.fetch }, 1000)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    const streamed = fakeFetch(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); controller.close() },
    })))
    await expect(loadMedia('https://x.test/b.mp4', { ...noPaths, fetch: streamed.fetch }, 1000)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    const missing = fakeFetch(new Response('gone', { status: 404 }))
    await expect(loadMedia('https://x.test/c.mp4', { ...noPaths, fetch: missing.fetch }, 1000)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED', details: { status: 404 } })
  })

  it('reads paths through the reader with the size limit', async () => {
    const calls: Array<[string, number]> = []
    const reader: SourceReader = {
      readPath: async (path, maxBytes) => { calls.push([path, maxBytes]); return { data: MOV, name: 'take.mp4' } },
    }
    expect(await loadMedia('  shots/take.mp4 ', reader, 2048)).toEqual({ source: 'shots/take.mp4', name: 'take.mp4', mime: 'video/quicktime', data: MOV })
    expect(calls).toEqual([['shots/take.mp4', 2048]])
  })
})
