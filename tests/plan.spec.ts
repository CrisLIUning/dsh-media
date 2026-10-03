import { describe, expect, it } from 'vitest'
import { parseMediaCatalog } from '../src/gateway/catalog.js'
import { MediaError } from '../src/gateway/errors.js'
import { estimateVideo } from '../src/pricing.js'
import { checkReferenceDurations, checkReferenceFile, describeVideoModel, planVideo, videoRequestBody } from '../src/video/plan.js'
import { CATALOG, LIVE_CATALOG } from './fixtures.js'

const models = parseMediaCatalog(CATALOG)
const model = (id: string) => {
  const found = models.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}
const seedance = model('seedance-2.0')
const web = model('seedance-2.5-vibedev')
const legacy = model('legacy-video')

function refusal(run: () => unknown): MediaError {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(MediaError)
    return error as MediaError
  }
  throw new Error('expected a refusal')
}

describe('planVideo', () => {
  it('plans a prompt-only video with the default duration and checked options', () => {
    const plan = planVideo(seedance, { prompt: 'a cat', aspectRatio: '9:16', resolution: '720' })
    expect(plan).toMatchObject({ mode: 'text_to_video', duration: 5, aspectRatio: '9:16', resolution: '720p', inputs: {} })
    expect(planVideo(seedance, { prompt: 'a cat', resolution: '720P' }).resolution).toBe('720p')
  })

  it('infers the mode from the inputs present', () => {
    expect(planVideo(seedance, { prompt: 'p', firstFrame: 'a.png' }).mode).toBe('first_frame')
    expect(planVideo(seedance, { prompt: 'p', firstFrame: 'a.png', lastFrame: 'b.png' }).mode).toBe('first_last_frame')
    expect(planVideo(seedance, { prompt: 'p', referenceImages: ['a.png'], referenceAudios: ['m.mp3'] })).toMatchObject({
      mode: 'omni_reference', inputs: { referenceImages: ['a.png'], referenceAudios: ['m.mp3'] },
    })
  })

  it('refuses reference audio as the only reference, naming what the mode needs', () => {
    const error = refusal(() => planVideo(seedance, { prompt: 'p', referenceAudios: ['m.mp3'] }))
    expect(error.code).toBe('VIDEO_INPUT_MISSING')
    expect(error.message).toContain('needs reference_images or reference_videos')
    expect(error.message).toContain('reference audio cannot be the only reference')
  })

  it('refuses more references than the model takes', () => {
    const error = refusal(() => planVideo(seedance, { prompt: 'p', referenceImages: Array.from({ length: 10 }, (_, i) => `${i}.png`) }))
    expect(error).toMatchObject({ code: 'VIDEO_INPUT_TOO_MANY', details: { field: 'reference_images' } })
    expect(error.message).toContain('at most 9 reference images (reference_images)')
  })

  it('refuses inputs a lane cannot carry, and lists what the model supports', () => {
    const frames = refusal(() => planVideo(web, { prompt: 'p', firstFrame: 'a.png' }))
    expect(frames.code).toBe('VIDEO_MODE_UNSUPPORTED')
    expect(frames.message).toContain('omni_reference (reference images/videos/audios): reference_images 1-10')
    const videos = refusal(() => planVideo(web, { prompt: 'p', referenceImages: ['a.png'], referenceVideos: ['v.mp4'] }))
    expect(videos).toMatchObject({ code: 'VIDEO_INPUT_UNSUPPORTED', details: { field: 'reference_videos' } })
  })

  it('refuses a last frame without a first frame and a mode the model lacks', () => {
    expect(refusal(() => planVideo(seedance, { prompt: 'p', lastFrame: 'b.png' })).code).toBe('VIDEO_INPUT_MISSING')
    expect(refusal(() => planVideo(legacy, { prompt: 'p', mode: 'first_last_frame' })).code).toBe('VIDEO_MODE_UNSUPPORTED')
  })

  it('checks duration, ratio, resolution and their allowed combinations', () => {
    expect(refusal(() => planVideo(seedance, { prompt: 'p', duration: 3 })).details.field).toBe('duration')
    expect(refusal(() => planVideo(seedance, { prompt: 'p', aspectRatio: '2:1' })).message).toContain('choose one of 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, adaptive')
    expect(planVideo(legacy, { prompt: 'p', duration: 6, resolution: '1080p' })).toMatchObject({ duration: 6, resolution: '1080p' })
    expect(refusal(() => planVideo(legacy, { prompt: 'p', duration: 10, resolution: '1080p' })).message).toContain('does not offer 10 s 1080p together')
  })

  it('keeps generate_audio false for a model with native audio and refuses it where there is none', () => {
    expect(planVideo(seedance, { prompt: 'p', generateAudio: false }).generateAudio).toBe(false)
    expect(planVideo(seedance, { prompt: 'p' }).generateAudio).toBeUndefined()
    expect(refusal(() => planVideo(legacy, { prompt: 'p', generateAudio: true })).details.field).toBe('generate_audio')
  })

  it('refuses a model whose capabilities it cannot read', () => {
    expect(refusal(() => planVideo(model('future-video'), { prompt: 'p' })).message).toContain('update dsh-media')
  })
})

describe('reference checks', () => {
  it('checks each reference type against the model, falling back to the gateway defaults', () => {
    expect(() => checkReferenceFile(seedance, 'referenceImages', { source: 'a.png', mime: 'image/png', bytes: 100 })).not.toThrow()
    expect(refusal(() => checkReferenceFile(seedance, 'referenceImages', { source: 'a.gif', mime: 'image/gif', bytes: 100 })).code)
      .toBe('REFERENCE_MEDIA_TYPE_UNSUPPORTED')
    expect(refusal(() => checkReferenceFile(seedance, 'referenceVideos', { source: 'v.webm', mime: 'video/webm', bytes: 100 })).message)
      .toContain('accepts video/mp4, video/quicktime')
    expect(() => checkReferenceFile(seedance, 'referenceAudios', { source: 'm.mp3', mime: 'audio/mpeg', bytes: 100 })).not.toThrow()
    expect(refusal(() => checkReferenceFile(seedance, 'referenceAudios', { source: 'm.m4a', mime: 'audio/mp4', bytes: 100 })).code)
      .toBe('REFERENCE_MEDIA_TYPE_UNSUPPORTED')
    expect(refusal(() => checkReferenceFile(web, 'referenceImages', { source: 'big.png', mime: 'image/png', bytes: 11 * 1024 * 1024 })).code)
      .toBe('REFERENCE_TOO_LARGE')
  })

  it('checks each reference video and their total against the measured lengths', () => {
    expect(() => checkReferenceDurations(seedance, [
      { source: 'a.mp4', mime: 'video/mp4', bytes: 1, durationMs: 4_040 },
      { source: 'b.mp4', mime: 'video/mp4', bytes: 1, durationMs: 4_040 },
    ])).not.toThrow()
    expect(refusal(() => checkReferenceDurations(seedance, [{ source: 'a.mp4', mime: 'video/mp4', bytes: 1, durationMs: 1_500 }])).code).toBe('REFERENCE_TOO_SHORT')
    expect(refusal(() => checkReferenceDurations(seedance, [{ source: 'a.mp4', mime: 'video/mp4', bytes: 1, durationMs: 16_000 }])).code).toBe('REFERENCE_TOO_LONG')
    expect(refusal(() => checkReferenceDurations(seedance, [
      { source: 'a.mp4', mime: 'video/mp4', bytes: 1, durationMs: 5_040 },
      { source: 'b.mp4', mime: 'video/mp4', bytes: 1, durationMs: 5_040 },
      { source: 'c.mp4', mime: 'video/mp4', bytes: 1, durationMs: 5_040 },
    ])).message).toContain('15.12 s')
    expect(refusal(() => checkReferenceDurations(seedance, [{ source: 'a.mp4', mime: 'video/mp4', bytes: 1 }])).code).toBe('REFERENCE_DURATION_UNKNOWN')
  })
})

describe('mode inference and defaults', () => {
  const [both] = parseMediaCatalog({
    data: [{
      id: 'frames-and-references', media_type: 'video',
      video: {
        durations_seconds: [5, 10], resolutions: ['720p', '1080p'],
        combinations: [{ duration_seconds: 5, resolution: '720p' }, { duration_seconds: 10, resolution: '1080p' }],
        modes_schema_version: 1,
        modes: {
          text_to_video: { inputs: {}, required_any_of: [] },
          first_last_frame: { inputs: { firstFrame: { min: 1, max: 1 }, lastFrame: { min: 1, max: 1 } }, required_any_of: [['firstFrame', 'lastFrame']] },
          omni_reference: {
            inputs: { firstFrame: { min: 0, max: 1 }, lastFrame: { min: 0, max: 1 }, referenceImages: { min: 0, max: 4 } },
            required_any_of: [['referenceImages']],
          },
        },
      },
    }],
  })
  const model = both as NonNullable<typeof both>

  it('infers the mode that takes every input given', () => {
    expect(planVideo(model, { prompt: 'p', firstFrame: 'a.png', lastFrame: 'b.png', referenceImages: ['c.png'] }).mode).toBe('omni_reference')
    expect(planVideo(model, { prompt: 'p', firstFrame: 'a.png', lastFrame: 'b.png' }).mode).toBe('first_last_frame')
    expect(planVideo(model, { prompt: 'p', firstFrame: 'a.png', referenceImages: ['c.png'] }).mode).toBe('omni_reference')
  })

  it('takes the default length and resolution from the combinations that fit', () => {
    expect(planVideo(model, { prompt: 'p' })).toMatchObject({ duration: 5, resolution: '720p' })
    expect(planVideo(model, { prompt: 'p', resolution: '1080p' })).toMatchObject({ duration: 10, resolution: '1080p' })
    expect(planVideo(model, { prompt: 'p', duration: 10 })).toMatchObject({ duration: 10, resolution: '1080p' })
    expect(refusal(() => planVideo(model, { prompt: 'p', duration: 5, resolution: '1080p' })).message).toContain('does not offer 5 s 1080p together')
  })
})

describe('planVideo on the live catalog shape', () => {
  const live = parseMediaCatalog(LIVE_CATALOG)
  const liveModel = (id: string) => {
    const found = live.find(item => item.id === id)
    if (found === undefined) throw new Error(`missing ${id}`)
    return found
  }

  it('refuses a first frame on the web lane, which takes reference images instead', () => {
    const error = refusal(() => planVideo(liveModel('seedance-2.5-vibedev'), { prompt: 'p', firstFrame: 'a.png' }))
    expect(error.code).toBe('VIDEO_MODE_UNSUPPORTED')
    expect(error.message).toContain('omni_reference (reference images/videos/audios): reference_images 0-10')
    expect(planVideo(liveModel('seedance-2.5-vibedev'), { prompt: 'p', referenceImages: ['a.png'], duration: 30 })).toMatchObject({ mode: 'omni_reference', duration: 30 })
  })

  it('defaults a single-duration lane to that duration and prices it per video', () => {
    const plan = planVideo(liveModel('seedance-2.5-30s-vibedev'), { prompt: 'p' })
    expect(plan.duration).toBe(30)
    expect(estimateVideo(liveModel('seedance-2.5-30s-vibedev'), plan.duration, plan.resolution)).toEqual({ amountCny: 4, basis: '¥4.00 per video' })
  })

  it('asks for 720p on a model with several resolutions, and prices that tier', () => {
    const plan = planVideo(liveModel('seedance-2.0-multi'), { prompt: 'p' })
    expect(plan.resolution).toBe('720p')
    expect(estimateVideo(liveModel('seedance-2.0-multi'), plan.duration, plan.resolution)?.amountCny).toBeCloseTo(7.4)
    expect(planVideo(liveModel('seedance-2.0-multi'), { prompt: 'p', resolution: '480p' }).resolution).toBe('480p')
    expect(planVideo(liveModel('seedance-2.0'), { prompt: 'p' }).resolution).toBeUndefined()
    expect(estimateVideo(liveModel('seedance-2.0'), 5, undefined)?.amountCny).toBeCloseTo(7.4)
  })

  it('applies the per-kind byte limits the live entries declare', () => {
    expect(refusal(() => checkReferenceFile(liveModel('seedance-2.0-multi'), 'referenceImages', { source: 'big.png', mime: 'image/png', bytes: 6 * 1048576 })).code)
      .toBe('REFERENCE_TOO_LARGE')
    expect(refusal(() => checkReferenceDurations(liveModel('seedance-2.0-multi'), [{ source: 'a.mp4', mime: 'video/mp4', bytes: 1, durationMs: 14_000 }])).code)
      .toBe('REFERENCE_TOO_LONG')
  })
})

describe('videoRequestBody', () => {
  it('writes the single vocabulary the gateway translates per provider', () => {
    const plan = planVideo(seedance, { prompt: 'p', referenceImages: ['a.png', 'b.png'], referenceVideos: ['v.mp4'], referenceAudios: ['m.mp3'],
      duration: 10, aspectRatio: '16:9', generateAudio: false })
    expect(videoRequestBody('seedance-2.0', 'p', plan, {
      referenceImages: ['https://g/a', 'https://g/b'], referenceVideos: ['https://g/v'], referenceAudios: ['https://g/m'],
    })).toEqual({
      model: 'seedance-2.0', prompt: 'p', duration: 10, aspect_ratio: '16:9', generate_audio: false,
      referenceImages: ['https://g/a', 'https://g/b'], referenceVideos: ['https://g/v'], referenceAudios: ['https://g/m'],
    })
    const frames = planVideo(seedance, { prompt: 'p', firstFrame: 'a.png', lastFrame: 'b.png' })
    expect(videoRequestBody('seedance-2.0', 'p', frames, { firstFrame: ['https://g/a'], lastFrame: ['https://g/b'] }))
      .toEqual({ model: 'seedance-2.0', prompt: 'p', duration: 5, firstFrame: 'https://g/a', lastFrame: 'https://g/b' })
  })

  it('describes a model for the agent', () => {
    expect(describeVideoModel(seedance)).toContain('first_last_frame (first and last frame): first_frame 1, last_frame 1')
    expect(describeVideoModel(seedance)).toContain('reference videos at most 15 s in total')
  })
})
