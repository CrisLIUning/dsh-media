import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAudioTask, parseVideoTask } from '../src/tasks/remote.js'
import { downloadTo, fileTimestamp, harnessHome, placeFile, safeStem, saveNewFile, stateDirectory } from '../src/util/files.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-media-files-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('file names', () => {
  it('keeps readable text and drops what file systems refuse', () => {
    expect(safeStem('A cat: on/the\\roof?  "night" *2*')).toBe('A-cat-on-the-roof-night-2')
    expect(safeStem('一只猫在屋顶上看月亮，背景是城市夜景，电影感，冷色调', 12)).toBe('一只猫在屋顶上看月亮，背')
    expect(safeStem('...')).toBe('')
    expect(safeStem('con')).toBe('con-file')
    expect(fileTimestamp(new Date(2026, 9, 3, 7, 5, 9))).toBe('20261003-070509')
  })

  it('places a finished file under a free name and never replaces one', async () => {
    const out = join(dir, 'out')
    const first = await saveNewFile(out, 'cat', 'png', new Uint8Array([1]))
    const second = await saveNewFile(out, 'cat', 'png', new Uint8Array([2]))
    expect([first, second]).toEqual([join(out, 'cat.png'), join(out, 'cat-2.png')])
    expect(new Uint8Array(await readFile(first))).toEqual(new Uint8Array([1]))
    const temporary = join(dir, 'x.part')
    await writeFile(temporary, new Uint8Array([3]))
    expect(await placeFile(temporary, out, 'cat', 'png')).toBe(join(out, 'cat-3.png'))
    expect((await readdir(out)).sort()).toEqual(['cat-2.png', 'cat-3.png', 'cat.png'])
    expect(await readdir(dir)).toEqual(['out'])
  })

  it('finds the state directory under the harness home', () => {
    expect(harnessHome({ DSH_HOME: join(dir, 'home') })).toBe(join(dir, 'home'))
    expect(stateDirectory('', { DSH_HOME: join(dir, 'home') })).toBe(join(dir, 'home', 'dsh-media'))
    expect(stateDirectory(join(dir, 'custom'), {})).toBe(join(dir, 'custom'))
  })
})

describe('downloadTo', () => {
  it('streams a body into the temporary file, replacing a leftover', async () => {
    const temporary = join(dir, 'v.part')
    await writeFile(temporary, 'stale leftover from a crash')
    expect(await downloadTo(new Response(new Uint8Array([1, 2, 3, 4])), temporary, 10)).toBe(4)
    expect(new Uint8Array(await readFile(temporary))).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('stops past the limit and cleans up', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close() } })
    await expect(downloadTo(new Response(stream), join(dir, 'big.part'), 10)).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
    await expect(downloadTo(new Response(new Uint8Array(4), { headers: { 'content-length': '99' } }), join(dir, 'big.part'), 10)).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
    expect(await readdir(dir)).toEqual([])
  })
})

describe('gateway task answers', () => {
  it('treats unknown statuses as running and reads fractional progress', () => {
    expect(parseVideoTask({ id: 'v', status: 'rendering', progress: 0.35 })).toMatchObject({ state: 'pending', progress: 35 })
    expect(parseVideoTask({ id: 'v', status: 'in_progress', progress: 60 })).toMatchObject({ state: 'pending', progress: 60, outputs: [] })
    expect(parseVideoTask({ status: 'completed' })).toBeUndefined()
  })

  it('reads the error of a failed task, whatever its shape', () => {
    expect(parseVideoTask({ id: 'v', status: 'failed', failure_reason: 'moderation' })?.error).toEqual({ code: 'GENERATION_FAILED', message: 'moderation' })
    expect(parseAudioTask({ id: 'a', status: 'error' })?.error).toEqual({ code: 'GENERATION_FAILED', message: 'the task ended with status "error"' })
  })

  it('reads the asset of a finished video from the top level or the video block, and a settled charge', () => {
    expect(parseVideoTask({ id: 'v', status: 'succeeded', video: { asset: { content_url: 'https://g/c', content_type: 'video/mp4', duration_ms: 4000 } } })?.outputs)
      .toEqual([{ index: 0, url: 'https://g/c', contentType: 'video/mp4', durationSeconds: 4 }])
    expect(parseVideoTask({ id: 'v', status: 'completed', seconds: '8', url: 'https://g/u' })?.outputs).toEqual([{ index: 0, url: 'https://g/u', durationSeconds: 8 }])
    expect(parseVideoTask({ id: 'v', status: 'completed', effective: { estimated_cny: '0.60', charged_cny: '0.6000000000' } })).toMatchObject({ estimatedCny: '0.60', chargedCny: '0.6000000000' })
  })
})
