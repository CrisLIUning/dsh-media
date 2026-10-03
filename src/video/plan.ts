/**
 * Video request planning: choose the generation mode, check every input and
 * option against what the chosen model declares, and build the request body.
 * Everything here runs before anything is uploaded or charged, so a request the
 * model cannot serve fails with a message that lists what it can.
 * @module dsh-media/video/plan
 */

import { MediaError } from '../gateway/errors.js'
import { VIDEO_INPUTS, VIDEO_MODES, effectiveVideoModes } from '../gateway/catalog.js'
import type { MediaModel, VideoCapabilities, VideoInput, VideoMode, VideoModeConstraint } from '../gateway/catalog.js'

/** What the caller asks for. Sources are workspace paths or URLs. */
export interface VideoRequestOptions {
  readonly prompt: string
  readonly mode?: VideoMode
  readonly duration?: number
  readonly aspectRatio?: string
  readonly resolution?: string
  readonly generateAudio?: boolean
  readonly firstFrame?: string
  readonly lastFrame?: string
  readonly referenceImages?: readonly string[]
  readonly referenceVideos?: readonly string[]
  readonly referenceAudios?: readonly string[]
}

/** A checked request, ready for its inputs to be uploaded. */
export interface VideoPlan {
  readonly mode: VideoMode
  readonly constraint: VideoModeConstraint
  readonly duration?: number
  readonly aspectRatio?: string
  readonly resolution?: string
  readonly generateAudio?: boolean
  /** Sources per input, in the caller's order. */
  readonly inputs: Partial<Record<VideoInput, readonly string[]>>
}

/** The media kind each input carries. */
export const INPUT_KIND: Readonly<Record<VideoInput, 'image' | 'video' | 'audio'>> = {
  firstFrame: 'image', lastFrame: 'image', referenceImages: 'image', referenceVideos: 'video', referenceAudios: 'audio',
}

/** The `video_generate` parameter each input arrives in; messages name inputs by it. */
export const INPUT_PARAM: Readonly<Record<VideoInput, string>> = {
  firstFrame: 'first_frame', lastFrame: 'last_frame', referenceImages: 'reference_images',
  referenceVideos: 'reference_videos', referenceAudios: 'reference_audios',
}

const INPUT_NOUN: Readonly<Record<VideoInput, readonly [string, string]>> = {
  firstFrame: ['first frame', 'first frames'], lastFrame: ['last frame', 'last frames'],
  referenceImages: ['reference image', 'reference images'], referenceVideos: ['reference video', 'reference videos'],
  referenceAudios: ['reference audio', 'reference audios'],
}

function noun(input: VideoInput, count: number): string {
  return `${count} ${INPUT_NOUN[input][count === 1 ? 0 : 1]}`
}

function needs(groups: readonly (readonly VideoInput[])[]): string {
  return groups.map(group => group.map(input => INPUT_PARAM[input]).join(' + ')).join(' or ')
}

/** MIME types the gateway accepts for hosted references when the catalog names none. */
export const DEFAULT_REFERENCE_MIMES: Readonly<Record<'image' | 'video' | 'audio', readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/wav'],
}

/** The gateway media library's default per-file ceiling. */
export const MEDIA_LIBRARY_MAX_BYTES = 256 * 1024 * 1024

const MODE_LABEL: Readonly<Record<VideoMode, string>> = {
  text_to_video: 'text_to_video (prompt only)',
  first_frame: 'first_frame (animate one first frame)',
  first_last_frame: 'first_last_frame (first and last frame)',
  omni_reference: 'omni_reference (reference images/videos/audios)',
}

function describeInputs(constraint: VideoModeConstraint): string {
  const parts: string[] = []
  for (const input of VIDEO_INPUTS) {
    const limit = constraint.inputs[input]
    if (limit === undefined || limit.max === 0) continue
    const range = limit.min === limit.max ? `${limit.max}` : `${limit.min}-${limit.max}`
    parts.push(`${INPUT_PARAM[input]} ${range}`)
  }
  const required = constraint.requiredAnyOf.length === 0 ? '' : `; needs ${needs(constraint.requiredAnyOf)}`
  return parts.length === 0 ? 'no media inputs' : `${parts.join(', ')}${required}`
}

function describeOptions(video: VideoCapabilities, constraint?: VideoModeConstraint): string {
  const durations = constraint?.durations ?? video.durations
  const ratios = constraint?.ratios ?? video.ratios
  const resolutions = constraint?.resolutions ?? video.resolutions
  const parts: string[] = []
  if (durations !== undefined) parts.push(`durations ${durations.join('/')} s`)
  if (ratios !== undefined) parts.push(`aspect ratios ${ratios.join(', ')}`)
  if (resolutions !== undefined) parts.push(`resolutions ${resolutions.join(', ')}`)
  if (video.nativeAudio === true) parts.push('can generate audio (generate_audio)')
  return parts.join('; ')
}

/**
 * A one-paragraph account of what a video model accepts, for errors and model listings.
 * @param model - the video model.
 * @returns the description.
 */
export function describeVideoModel(model: MediaModel): string {
  const video = model.video ?? {}
  if (video.unreadableModesVersion !== undefined) {
    return `${model.id} declares capabilities in a format this plugin version does not read (modes schema ${video.unreadableModesVersion}); update dsh-media to use it.`
  }
  const modes = effectiveVideoModes(video)
  const lines = VIDEO_MODES.filter(mode => modes[mode] !== undefined).map((mode) => {
    const constraint = modes[mode] as VideoModeConstraint
    const options = describeOptions(video, constraint)
    return `${MODE_LABEL[mode]}: ${describeInputs(constraint)}${options === '' ? '' : `; ${options}`}`
  })
  const limits: string[] = []
  if (video.minReferenceVideoSeconds !== undefined || video.maxReferenceVideoSeconds !== undefined) {
    limits.push(`each reference video ${video.minReferenceVideoSeconds ?? 0}-${video.maxReferenceVideoSeconds ?? '∞'} s`)
  }
  if (video.maxTotalReferenceVideoSeconds !== undefined) limits.push(`reference videos at most ${video.maxTotalReferenceVideoSeconds} s in total`)
  if (video.combinations !== undefined) {
    limits.push(`allowed combinations: ${video.combinations.map(c => [c.duration === undefined ? '' : `${c.duration}s`, c.ratio ?? '', c.resolution ?? ''].filter(Boolean).join(' ')).join('; ')}`)
  }
  return `${model.id} supports ${lines.length === 0 ? 'no generation mode' : lines.join(' | ')}${limits.length === 0 ? '' : `. Limits: ${limits.join('; ')}`}.`
}

function present(options: VideoRequestOptions): Partial<Record<VideoInput, readonly string[]>> {
  const inputs: Partial<Record<VideoInput, readonly string[]>> = {}
  const single = (value: string | undefined): readonly string[] | undefined =>
    value === undefined || value.trim() === '' ? undefined : [value.trim()]
  const many = (value: readonly string[] | undefined): readonly string[] | undefined => {
    const items = (value ?? []).map(item => item.trim()).filter(item => item !== '')
    return items.length === 0 ? undefined : items
  }
  const entries: Array<[VideoInput, readonly string[] | undefined]> = [
    ['firstFrame', single(options.firstFrame)], ['lastFrame', single(options.lastFrame)],
    ['referenceImages', many(options.referenceImages)], ['referenceVideos', many(options.referenceVideos)],
    ['referenceAudios', many(options.referenceAudios)],
  ]
  for (const [input, value] of entries) if (value !== undefined) inputs[input] = value
  return inputs
}

/**
 * The mode a request means when it names none.
 * @param inputs - the inputs present.
 * @param modes - the model's usable modes.
 * @returns the inferred mode.
 */
function inferMode(inputs: Partial<Record<VideoInput, readonly string[]>>, modes: Partial<Record<VideoMode, VideoModeConstraint>>): VideoMode {
  const references = inputs.referenceImages !== undefined || inputs.referenceVideos !== undefined || inputs.referenceAudios !== undefined
  const preference: readonly VideoMode[] = inputs.lastFrame !== undefined
    ? ['first_last_frame', 'omni_reference']
    : inputs.firstFrame !== undefined
      ? references ? ['omni_reference', 'first_frame'] : ['first_frame', 'omni_reference']
      : references ? ['omni_reference'] : ['text_to_video']
  // The first mode that takes every input present; failing that, the first choice, whose refusal names the problem.
  return preference.find(mode => modes[mode] !== undefined && accepts(modes[mode] as VideoModeConstraint, inputs)) ?? preference[0] as VideoMode
}

/** Whether a mode takes every input present and its required inputs are there. */
function accepts(constraint: VideoModeConstraint, inputs: Partial<Record<VideoInput, readonly string[]>>): boolean {
  const count = (input: VideoInput) => inputs[input]?.length ?? 0
  if (VIDEO_INPUTS.some(input => count(input) > 0 && (constraint.inputs[input]?.max ?? 0) === 0)) return false
  return constraint.requiredAnyOf.length === 0 || constraint.requiredAnyOf.some(group => group.every(input => count(input) > 0))
}

/** Whether one of the model's combinations allows these choices; unknown choices match anything. */
function combinationAllows(video: VideoCapabilities, duration: number | undefined, ratio: string | undefined, resolution: string | undefined): boolean {
  if (video.combinations === undefined) return true
  return video.combinations.some(combo =>
    (combo.duration === undefined || duration === undefined || combo.duration === duration)
    && (combo.ratio === undefined || ratio === undefined || combo.ratio === ratio)
    && (combo.resolution === undefined || resolution === undefined || combo.resolution.toLowerCase() === resolution.toLowerCase()))
}

/** `720` → `720p`; matching is case-insensitive. */
function normalizeResolution(value: string): string {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? `${trimmed}p` : trimmed
}

function pick(allowed: readonly string[] | undefined, value: string | undefined, label: string, model: MediaModel, normalize = (v: string) => v.trim()): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const wanted = normalize(value)
  if (allowed === undefined) return wanted
  const match = allowed.find(item => item.toLowerCase() === wanted.toLowerCase())
  if (match === undefined) {
    throw new MediaError(`${model.id} does not support ${label} "${value}"; choose one of ${allowed.join(', ')}.`, 'VIDEO_OPTION_UNSUPPORTED', { field: label })
  }
  return match
}

/**
 * Check a request against the model and fix its mode and options.
 * @param model - the chosen video model.
 * @param options - prompt, mode, options and input sources.
 * @returns the plan.
 * @throws {@link MediaError} naming what the model supports.
 */
export function planVideo(model: MediaModel, options: VideoRequestOptions): VideoPlan {
  const fail = (message: string, code = 'VIDEO_REQUEST_UNSUPPORTED', fieldName?: string): never => {
    throw new MediaError([message, describeVideoModel(model)].filter(part => part !== '').join(' '), code,
      fieldName === undefined ? {} : { field: fieldName })
  }
  if (model.kind !== 'video' || model.video === undefined) fail(`${model.id} is not a video model.`, 'NOT_A_VIDEO_MODEL')
  const video = model.video as VideoCapabilities
  if (video.unreadableModesVersion !== undefined) fail('', 'VIDEO_CAPABILITIES_UNREADABLE')
  if (options.prompt.trim() === '') fail('A video request needs a prompt.', 'VIDEO_PROMPT_REQUIRED', 'prompt')
  const modes = effectiveVideoModes(video)
  const inputs = present(options)
  const mode = options.mode ?? inferMode(inputs, modes)
  const constraint = modes[mode]
  if (constraint === undefined) fail(`${model.id} does not support the ${mode} mode.`, 'VIDEO_MODE_UNSUPPORTED', 'mode')
  const checked = constraint as VideoModeConstraint
  if (inputs.lastFrame !== undefined && inputs.firstFrame === undefined) fail('A last_frame needs a first_frame.', 'VIDEO_INPUT_MISSING', 'first_frame')
  for (const input of VIDEO_INPUTS) {
    const count = inputs[input]?.length ?? 0
    const limit = checked.inputs[input]
    const param = INPUT_PARAM[input]
    if (count > 0 && (limit === undefined || limit.max === 0)) {
      fail(`The ${mode} mode of ${model.id} does not take ${param}.`, 'VIDEO_INPUT_UNSUPPORTED', param)
    }
    if (limit !== undefined && count > limit.max) {
      fail(`${model.id} takes at most ${noun(input, limit.max)} (${param}) in the ${mode} mode; got ${count}.`, 'VIDEO_INPUT_TOO_MANY', param)
    }
    if (limit !== undefined && count < limit.min) {
      fail(`The ${mode} mode of ${model.id} needs at least ${noun(input, limit.min)} (${param}); got ${count}.`, 'VIDEO_INPUT_MISSING', param)
    }
  }
  if (checked.requiredAnyOf.length > 0
    && !checked.requiredAnyOf.some(group => group.every(input => (inputs[input]?.length ?? 0) > 0))) {
    fail(`The ${mode} mode of ${model.id} needs ${needs(checked.requiredAnyOf)}`
      + `${mode === 'omni_reference' && inputs.referenceAudios !== undefined ? ' (reference audio cannot be the only reference)' : ''}.`, 'VIDEO_INPUT_MISSING')
  }
  const durations = checked.durations ?? video.durations
  const ratios = checked.ratios ?? video.ratios
  const resolutions = checked.resolutions ?? video.resolutions
  const requested = options.duration
  if (requested !== undefined) {
    if (!Number.isFinite(requested) || requested <= 0) fail(`Duration ${requested} is not a positive number of seconds.`, 'VIDEO_OPTION_UNSUPPORTED', 'duration')
    if (durations !== undefined && !durations.includes(requested)) {
      fail(`${model.id} does not support a ${requested} s video in the ${mode} mode.`, 'VIDEO_OPTION_UNSUPPORTED', 'duration')
    }
  }
  const aspectRatio = pick(ratios, options.aspectRatio, 'aspect_ratio', model)
  let resolution = pick(resolutions, options.resolution, 'resolution', model, normalizeResolution)
  let duration = requested
  if (duration === undefined) {
    // The default length: 5 s when offered, else the shortest, among the lengths the combinations allow with these choices.
    const offered = durations ?? [...new Set((video.combinations ?? []).flatMap(combo => combo.duration === undefined ? [] : [combo.duration]))]
    const fitting = offered.filter(length => combinationAllows(video, length, aspectRatio, resolution))
    const pool = fitting.length > 0 ? fitting : offered
    if (pool.length > 0) duration = pool.includes(5) ? 5 : Math.min(...pool)
  }
  if (resolution === undefined && resolutions !== undefined && resolutions.length > 1) {
    // Prices differ per resolution, so a model offering several gets an explicit one (720p
    // when allowed) instead of a provider default the estimate cannot know.
    const fitting = resolutions.filter(item => combinationAllows(video, duration, aspectRatio, item))
    resolution = fitting.find(item => item.toLowerCase() === '720p') ?? (video.combinations === undefined ? undefined : fitting[0])
  }
  if (!combinationAllows(video, duration, aspectRatio, resolution)) {
    fail(`${model.id} does not offer ${[duration === undefined ? '' : `${duration} s`, aspectRatio, resolution].filter(Boolean).join(' ')} together.`, 'VIDEO_OPTION_UNSUPPORTED')
  }
  if (options.generateAudio === true && video.nativeAudio !== true) fail(`${model.id} does not generate audio.`, 'VIDEO_OPTION_UNSUPPORTED', 'generate_audio')
  return {
    mode, constraint: checked, inputs,
    ...duration === undefined ? {} : { duration },
    ...aspectRatio === undefined ? {} : { aspectRatio },
    ...resolution === undefined ? {} : { resolution },
    // Only a model that declares native audio hears the switch; false must stay false.
    ...video.nativeAudio === true && options.generateAudio !== undefined ? { generateAudio: options.generateAudio } : {},
  }
}

/** One reference's facts, as loaded or uploaded. */
export interface ReferenceMedia {
  readonly source: string
  readonly mime: string
  readonly bytes: number
  /** Measured duration of an uploaded audio or video, in milliseconds. */
  readonly durationMs?: number
}

/**
 * Check one reference's format and size before it is uploaded.
 * @param model - the video model.
 * @param input - which input it fills.
 * @param media - its type and size.
 * @throws {@link MediaError} when the model or the gateway would refuse it.
 */
export function checkReferenceFile(model: MediaModel, input: VideoInput, media: ReferenceMedia): void {
  const video = model.video ?? {}
  const kind = INPUT_KIND[input]
  const param = INPUT_PARAM[input]
  const allowed = (kind === 'image' ? video.allowedImageMimes : kind === 'video' ? video.allowedVideoMimes : video.allowedAudioMimes)
    ?? DEFAULT_REFERENCE_MIMES[kind]
  if (!allowed.includes(media.mime)) {
    throw new MediaError(`${param} "${media.source}" is ${media.mime}; ${model.id} accepts ${allowed.join(', ')} for ${kind} references. `
      + 'Convert the file first (for example with ffmpeg) and try again.', 'REFERENCE_MEDIA_TYPE_UNSUPPORTED', { field: param })
  }
  const limit = referenceByteLimit(model, input)
  if (media.bytes > limit) {
    throw new MediaError(`${param} "${media.source}" is ${(media.bytes / 1048576).toFixed(1)} MiB; the limit is ${(limit / 1048576).toFixed(1)} MiB.`,
      'REFERENCE_TOO_LARGE', { field: param })
  }
}

/**
 * The largest file one input may be: the model's per-kind limit, its asset
 * limit and the media library ceiling, whichever is smallest.
 * @param model - the video model.
 * @param input - which input.
 * @returns the limit in bytes.
 */
export function referenceByteLimit(model: MediaModel, input: VideoInput): number {
  const video = model.video ?? {}
  const kind = INPUT_KIND[input]
  const kindMax = kind === 'image' ? video.maxReferenceImageBytes : kind === 'video' ? video.maxReferenceVideoBytes : video.maxReferenceAudioBytes
  return Math.min(kindMax ?? Infinity, video.maxAssetBytes ?? Infinity, MEDIA_LIBRARY_MAX_BYTES)
}

/**
 * Check reference video durations once the gateway has measured them.
 * @param model - the video model.
 * @param videos - the uploaded reference videos, in order.
 * @throws {@link MediaError} when a clip or the total is outside the model's limits.
 */
export function checkReferenceDurations(model: MediaModel, videos: readonly ReferenceMedia[]): void {
  const video = model.video ?? {}
  let totalMs = 0
  for (const [index, clip] of videos.entries()) {
    if (clip.durationMs === undefined) {
      if (video.minReferenceVideoSeconds !== undefined || video.maxReferenceVideoSeconds !== undefined || video.maxTotalReferenceVideoSeconds !== undefined) {
        throw new MediaError(`The gateway could not measure the length of reference video ${index + 1} ("${clip.source}"), so ${model.id}'s length limits cannot be checked. `
          + 'Re-encode it as a standard MP4 and try again.', 'REFERENCE_DURATION_UNKNOWN', { field: 'reference_videos' })
      }
      continue
    }
    const seconds = clip.durationMs / 1000
    if (video.minReferenceVideoSeconds !== undefined && seconds < video.minReferenceVideoSeconds) {
      throw new MediaError(`Reference video ${index + 1} ("${clip.source}") is ${seconds.toFixed(2)} s; ${model.id} needs at least ${video.minReferenceVideoSeconds} s per clip.`,
        'REFERENCE_TOO_SHORT', { field: 'reference_videos' })
    }
    if (video.maxReferenceVideoSeconds !== undefined && seconds > video.maxReferenceVideoSeconds) {
      throw new MediaError(`Reference video ${index + 1} ("${clip.source}") is ${seconds.toFixed(2)} s; ${model.id} takes at most ${video.maxReferenceVideoSeconds} s per clip. Trim it first.`,
        'REFERENCE_TOO_LONG', { field: 'reference_videos' })
    }
    totalMs += clip.durationMs
  }
  if (video.maxTotalReferenceVideoSeconds !== undefined && totalMs / 1000 > video.maxTotalReferenceVideoSeconds) {
    throw new MediaError(`The reference videos add up to ${(totalMs / 1000).toFixed(2)} s; ${model.id} takes at most ${video.maxTotalReferenceVideoSeconds} s in total.`,
      'REFERENCE_TOTAL_TOO_LONG', { field: 'reference_videos' })
  }
}

/**
 * The `/v1/videos` body for a plan whose inputs are uploaded. The gateway reads
 * one vocabulary and translates it per provider.
 * @param model - the model id.
 * @param prompt - the prompt.
 * @param plan - the checked plan.
 * @param urls - the gateway reference URL of every input, in order.
 * @returns the request body.
 */
export function videoRequestBody(model: string, prompt: string, plan: VideoPlan, urls: Partial<Record<VideoInput, readonly string[]>>): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt }
  if (plan.duration !== undefined) body.duration = plan.duration
  if (plan.aspectRatio !== undefined) body.aspect_ratio = plan.aspectRatio
  if (plan.resolution !== undefined) body.resolution = plan.resolution
  if (plan.generateAudio !== undefined) body.generate_audio = plan.generateAudio
  const first = urls.firstFrame?.[0]
  const last = urls.lastFrame?.[0]
  if (first !== undefined) body.firstFrame = first
  if (last !== undefined) body.lastFrame = last
  for (const input of ['referenceImages', 'referenceVideos', 'referenceAudios'] as const) {
    const values = urls[input]
    if (values !== undefined && values.length > 0) body[input] = [...values]
  }
  return body
}
