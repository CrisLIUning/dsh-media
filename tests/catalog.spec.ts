import { describe, expect, it } from 'vitest'
import { effectiveVideoModes, parseMediaCatalog } from '../src/gateway/catalog.js'
import { CATALOG, LIVE_CATALOG } from './fixtures.js'

const models = parseMediaCatalog(CATALOG)
const byId = (id: string) => {
  const model = models.find(item => item.id === id)
  if (model === undefined) throw new Error(`missing ${id}`)
  return model
}

describe('parseMediaCatalog', () => {
  it('keeps media models with their kind and leaves chat and internal models out', () => {
    expect(models.map(model => [model.id, model.kind, model.audioKind])).toEqual([
      ['gpt-image-2.5-flare', 'image', undefined],
      ['seedance-2.0', 'video', undefined],
      ['seedance-2.5-vibedev', 'video', undefined],
      ['legacy-video', 'video', undefined],
      ['lec-ty-wan-3-0-1050-480p', 'video', undefined],
      ['future-video', 'video', undefined],
      ['doubao-music-vibedev', 'audio', 'music'],
      ['doubao-podcast-vibedev', 'audio', 'podcast'],
      ['doubao-asr-vibedev', 'transcription', undefined],
    ])
  })

  it('reads names, descriptions and selling prices', () => {
    expect(byId('gpt-image-2.5-flare')).toMatchObject({
      name: 'GPT Image 2.5 Flare', description: 'Fast photoreal images.',
      pricing: { currency: 'CNY', tiers: [{ tier: '1K', unit: 'generation', amount: 0.1 }], default: { unit: 'generation', amount: 0.1 } },
    })
    expect(byId('doubao-music-vibedev').pricing).toEqual({ currency: 'CNY', tiers: [], default: { unit: 'generation', amount: 0.5 } })
    expect(byId('doubao-podcast-vibedev').pricing).toBeUndefined()
  })

  it('reads the Seedance 2.0 video block: modes, hosted inputs and reference limits', () => {
    const video = byId('seedance-2.0').video
    expect(video?.modes?.omni_reference).toEqual({
      inputs: {
        referenceImages: { min: 0, max: 9, hosted: false },
        referenceVideos: { min: 0, max: 3, hosted: true },
        referenceAudios: { min: 0, max: 3, hosted: false },
      },
      requiredAnyOf: [['referenceImages'], ['referenceVideos']],
    })
    expect(Object.keys(video?.modes ?? {})).toEqual(['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'])
    expect(video).toMatchObject({
      resolutions: ['720p'], nativeAudio: true, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      allowedImageMimes: ['image/jpeg', 'image/png', 'image/webp'], allowedVideoMimes: ['video/mp4', 'video/quicktime'],
      minReferenceVideoSeconds: 2, maxReferenceVideoSeconds: 15, maxTotalReferenceVideoSeconds: 15, gatewayRelayRequired: true,
    })
    // An empty MIME list states no restriction rather than "nothing allowed".
    expect(video?.allowedAudioMimes).toBeUndefined()
    // Zero byte limits mean "no limit".
    expect(video?.maxAssetBytes).toBeUndefined()
  })

  it('derives conservative modes for a legacy entry without a modes block', () => {
    const modes = effectiveVideoModes(byId('legacy-video').video ?? {})
    expect(Object.keys(modes)).toEqual(['text_to_video', 'first_frame', 'omni_reference'])
    expect(modes.omni_reference).toEqual({
      inputs: { referenceImages: { min: 0, max: 4, hosted: false }, referenceAudios: { min: 0, max: 1, hosted: false } },
      requiredAnyOf: [['referenceImages']],
    })
    expect(byId('legacy-video').video?.combinations).toEqual([
      { duration: 6, resolution: '1080p' }, { duration: 10, resolution: '720p' }, { duration: 6, resolution: '720p' },
    ])
  })

  it('serves no mode from a modes block of an unknown version', () => {
    const video = byId('future-video').video ?? {}
    expect(video.unreadableModesVersion).toBe(2)
    expect(effectiveVideoModes(video)).toEqual({})
  })
})

describe('the live /v1/models shape', () => {
  const live = parseMediaCatalog(LIVE_CATALOG)
  const liveModel = (id: string) => {
    const model = live.find(item => item.id === id)
    if (model === undefined) throw new Error(`missing ${id}`)
    return model
  }

  it('finds image models without a media type', () => {
    expect(live.map(model => [model.id, model.kind])).toEqual([
      ['seedance-2.0', 'video'], ['seedance-2.0-multi', 'video'], ['seedance-2.5-vibedev', 'video'], ['seedance-2.5-30s-vibedev', 'video'],
      ['gpt-image-2.5-flare', 'image'], ['doubao-music-vibedev', 'audio'],
    ])
  })

  it('reads the flattened supported_* fields', () => {
    expect(liveModel('seedance-2.0').video).toMatchObject({
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
      resolutions: ['720p'], maxReferenceVideoSeconds: 15, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      firstFrame: true, lastFrame: true, nativeAudio: true, gatewayRelayRequired: true,
    })
    expect(liveModel('seedance-2.0-multi').video).toMatchObject({ resolutions: ['480p', '720p', '1080p'], maxReferenceImageBytes: 5_242_880 })
  })

  it('derives the frame modes only where a first frame is declared', () => {
    expect(Object.keys(effectiveVideoModes(liveModel('seedance-2.0').video ?? {}))).toEqual(['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'])
    expect(effectiveVideoModes(liveModel('seedance-2.0').video ?? {}).omni_reference).toEqual({
      inputs: {
        referenceImages: { min: 0, max: 9, hosted: false },
        referenceVideos: { min: 0, max: 3, hosted: true },
        referenceAudios: { min: 0, max: 3, hosted: false },
      },
      requiredAnyOf: [['referenceImages'], ['referenceVideos']],
    })
    // The web lane says image_to_video but takes images only as references.
    expect(effectiveVideoModes(liveModel('seedance-2.5-vibedev').video ?? {})).toEqual({
      text_to_video: { inputs: {}, requiredAnyOf: [] },
      omni_reference: { inputs: { referenceImages: { min: 0, max: 10, hosted: false } }, requiredAnyOf: [['referenceImages']] },
    })
  })
})
