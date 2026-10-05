/**
 * `video_generate`: plan a video request against what the chosen model
 * declares, upload every reference to the gateway media library, check the
 * measured reference lengths, submit once under an idempotency key and report
 * the result through a background job.
 * @module dsh-vibedev/tools/video
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MediaModel, VideoInput, VideoMode } from '../gateway/catalog.js'
import { VIDEO_INPUTS, VIDEO_MODES } from '../gateway/catalog.js'
import { MediaError } from '../gateway/errors.js'
import type { UploadedAsset } from '../gateway/assets.js'
import { estimateVideo, yuan } from '../pricing.js'
import type { MediaCall, MediaRuntime } from '../runtime.js'
import type { TaskRecord } from '../tasks/store.js'
import { INPUT_KIND, INPUT_PARAM, checkReferenceDurations, checkReferenceFile, planVideo, referenceByteLimit, videoRequestBody } from '../video/plan.js'
import type { VideoPlan, VideoRequestOptions } from '../video/plan.js'
import { SOURCE_HELP, UNCONFIRMED_NOTE, describeTask, excerpt, submitTask, waitForTask } from './common.js'

const UPLOAD_CONCURRENCY = 3

function firstSentence(message: string): string {
  const end = message.search(/\.\s/)
  return end === -1 ? message : message.slice(0, end + 1)
}

/**
 * Choose a model that can serve the request: the one named, else the pinned
 * one, else the first in catalog order whose declared modes accept it.
 * @returns the model and its plan.
 */
async function chooseModel(runtime: MediaRuntime, requested: string | undefined, options: VideoRequestOptions, signal: AbortSignal): Promise<{ model: MediaModel; plan: VideoPlan }> {
  if (requested !== undefined && requested.trim() !== '') {
    const model = await runtime.pickModel('video', 'video', requested, undefined, signal)
    return { model, plan: planVideo(model, options) }
  }
  const first = await runtime.pickModel('video', 'video', undefined, undefined, signal)
  const models = (await runtime.models(signal)).filter(model => model.kind === 'video')
  const ordered = [first, ...models.filter(model => model !== first)]
  const refusals: string[] = []
  for (const model of ordered) {
    try {
      return { model, plan: planVideo(model, options) }
    } catch (error) {
      if (!(error instanceof MediaError)) throw error
      if (ordered.length === 1) throw error
      refusals.push(`${model.id}: ${firstSentence(error.message)}`)
    }
  }
  throw new MediaError(`No video model on this VibeDev account can serve this request. ${refusals.join(' ')} `
    + 'Use media_models to see what each model accepts, then adjust the inputs or options.', 'VIDEO_REQUEST_UNSUPPORTED')
}

/** Run `run` over `items`, `limit` at a time; after the first failure no new item starts. */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++
      try {
        results[index] = await run(items[index] as T)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** One video request, as the tool and host callers make it. */
export interface VideoRequest extends VideoRequestOptions {
  readonly model?: string
}

/** A video request checked, uploaded and priced, ready to submit. */
export interface PreparedVideo {
  readonly model: MediaModel
  readonly plan: VideoPlan
  /** The task to submit (status `submitting`). */
  readonly draft: TaskRecord
  /** One entry per uploaded input, in request order. */
  readonly inputs: readonly VideoInput[]
  /** `5 s, 16:9, 720p`, for messages. */
  readonly shape: string
}

/**
 * Everything before a video submission: choose a model that can serve the
 * request, load and check every input, upload them all to the gateway media
 * library, check the measured reference lengths, price it, confirm the
 * spending, and build the task.
 * @param runtime - the media runtime.
 * @param call - the tool call or host call.
 * @param request - what to generate.
 * @param save - where the finished video goes: the folder and the file-name stem.
 * @returns the prepared task.
 */
export async function prepareVideoTask(
  runtime: MediaRuntime,
  call: MediaCall,
  request: VideoRequest,
  save: { readonly folder: string; readonly stem: string },
): Promise<PreparedVideo> {
  const { model: requested, ...options } = request
  const { model, plan } = await chooseModel(runtime, requested, options, call.signal)

  // Load and check every input before anything is uploaded, then upload them all.
  const sources: Array<{ input: VideoInput; source: string }> = []
  for (const input of VIDEO_INPUTS) for (const source of plan.inputs[input] ?? []) sources.push({ input, source })
  const loaded = []
  for (const { input, source } of sources) {
    const media = await runtime.load(call, source, INPUT_KIND[input], referenceByteLimit(model, input))
    checkReferenceFile(model, input, { source: media.source, mime: media.mime, bytes: media.data.byteLength })
    loaded.push({ input, media })
  }
  // One failed upload stops the others: the request cannot be sent without every reference.
  const uploads = new AbortController()
  const relay = (): void => { uploads.abort(call.signal.reason) }
  call.signal.addEventListener('abort', relay, { once: true })
  let assets: UploadedAsset[]
  try {
    assets = await mapLimited(loaded, UPLOAD_CONCURRENCY, async ({ media }) => {
      try {
        return await runtime.library.upload(media, 'video_reference', uploads.signal)
      } catch (error) {
        uploads.abort(error)
        throw error
      }
    })
  } finally {
    call.signal.removeEventListener('abort', relay)
  }
  const videos = loaded.flatMap((item, index) => item.input === 'referenceVideos'
    ? [{ source: item.media.source, mime: item.media.mime, bytes: item.media.data.byteLength, ...assets[index]?.durationMs === undefined ? {} : { durationMs: assets[index]?.durationMs as number } }]
    : [])
  checkReferenceDurations(model, videos)
  const urls: Partial<Record<VideoInput, string[]>> = {}
  for (const [index, item] of loaded.entries()) {
    const asset = assets[index] as UploadedAsset
    ;(urls[item.input] ??= []).push(asset.referenceUrl)
  }

  const referenceMs = videos.reduce((sum, clip) => sum + (clip.durationMs ?? 0), 0)
  const estimate = estimateVideo(model, plan.duration, plan.resolution, referenceMs)
  const shape = [plan.duration === undefined ? undefined : `${plan.duration} s`, plan.aspectRatio, plan.resolution].filter(Boolean).join(', ')
  await runtime.confirmSpending(call, 'video_generate', {
    en: `Generate a video with ${model.id} (${plan.mode}${shape === '' ? '' : `, ${shape}`})${estimate === undefined ? '' : `, about ${yuan(estimate.amountCny)} (${estimate.basis})`}. Charged only if it succeeds.`,
    zh: `用 ${model.id} 生成视频（${plan.mode}${shape === '' ? '' : `，${shape}`}）${estimate === undefined ? '' : `，约 ${yuan(estimate.amountCny)}`}，成功才扣费。`,
  })

  const now = runtime.now()
  const draft: TaskRecord = {
    id: randomUUID(), kind: 'video', model: model.id, label: excerpt(request.prompt), createdAt: now, updatedAt: now,
    ...call.agent === undefined ? {} : { owner: call.agent.id },
    outputDir: save.folder, stem: save.stem,
    endpoint: '/v1/videos', body: videoRequestBody(model.id, request.prompt, plan, urls), status: 'submitting',
    ...estimate === undefined ? {} : { estimatedCny: estimate.amountCny.toFixed(2) },
  }
  return { model, plan, draft, inputs: loaded.map(item => item.input), shape }
}

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function videoGenerateTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'video_generate',
    description: 'Generate a video with a VibeDev video model. It runs as a background job (usually 1-10 minutes): this call returns once the '
      + 'gateway accepts the task, you are notified when it finishes, and the file is saved in the workspace (media/videos/). '
      + 'Modes: text_to_video (prompt only), first_frame (animate an image), first_last_frame (animate from one image to another), '
      + 'omni_reference (reference images, videos and audio guide characters, motion, style and sound). Each model supports different modes, '
      + 'reference counts, durations, aspect ratios and resolutions; media_models lists them, and requests a model cannot serve are refused '
      + 'before anything is uploaded or charged. Charged per second of video (plus reference video length) only when it succeeds; '
      + 'a running task cannot be cancelled.',
    parameters: {
      prompt: {
        type: 'string', required: true,
        description: 'What happens: subject, action, camera movement, style, lighting, sound. With references, say how each is used, '
          + 'numbered in the order given (for example "the woman from image 1 dances to the music from audio 1, moving like the dancer in video 1").',
      },
      model: { type: 'string', description: 'Video model id from media_models. Omit to pick the first model that supports the request.' },
      mode: { type: 'string', enum: [...VIDEO_MODES], description: 'Generation mode. Omit to infer it from the inputs.' },
      duration: { type: 'integer', description: 'Length in seconds; must be one the model offers (media_models). Default 5 when offered.' },
      aspect_ratio: { type: 'string', description: 'Such as 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 or adaptive; must be one the model offers.' },
      resolution: { type: 'string', description: 'Such as 480p, 720p or 1080p; must be one the model offers. Default 720p when the model offers several; the price per second depends on it.' },
      generate_audio: { type: 'boolean', description: 'Generate sound with the video, for models that can. Default: the model\'s own default.' },
      first_frame: { type: 'string', description: `Image the video starts from; ${SOURCE_HELP}.` },
      last_frame: { type: 'string', description: `Image the video ends on (needs first_frame); ${SOURCE_HELP}.` },
      reference_images: {
        type: 'array', items: { type: 'string' },
        description: `Reference images for characters, products, scenes or style (omni_reference). Each is ${SOURCE_HELP}.`,
      },
      reference_videos: {
        type: 'array', items: { type: 'string' },
        description: `Reference videos for motion, camera work or effects (omni_reference; MP4 or MOV). Each is ${SOURCE_HELP}.`,
      },
      reference_audios: {
        type: 'array', items: { type: 'string' },
        description: `Reference audio for music, voice or sound (omni_reference; MP3 or WAV); needs at least one reference image or video. Each is ${SOURCE_HELP}.`,
      },
      filename: { type: 'string', description: 'File name for the result, without extension. Default: a timestamp plus the start of the prompt.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          model: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          jobId: { type: 'string' },
          duration: { type: 'number' },
          aspectRatio: { type: 'string' },
          resolution: { type: 'string' },
          estimatedCny: { type: 'string' },
          outputs: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { path: { type: 'string' }, url: { type: 'string' }, durationSeconds: { type: 'number' } },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const { model, plan, draft, inputs, shape } = await prepareVideoTask(runtime, exec, {
        prompt: args.prompt,
        ...args.model === undefined ? {} : { model: args.model },
        ...args.mode === undefined ? {} : { mode: args.mode as VideoMode },
        ...args.duration === undefined ? {} : { duration: args.duration },
        ...args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio },
        ...args.resolution === undefined ? {} : { resolution: args.resolution },
        ...args.generate_audio === undefined ? {} : { generateAudio: args.generate_audio },
        ...args.first_frame === undefined ? {} : { firstFrame: args.first_frame },
        ...args.last_frame === undefined ? {} : { lastFrame: args.last_frame },
        ...args.reference_images === undefined ? {} : { referenceImages: args.reference_images },
        ...args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos },
        ...args.reference_audios === undefined ? {} : { referenceAudios: args.reference_audios },
      }, { folder: runtime.outputFolder(exec, 'videos'), stem: runtime.stem(args.filename, args.prompt) })
      const { record: accepted, jobId, unconfirmed } = await submitTask(runtime, exec, draft)
      const estimated = accepted.estimatedCny ?? draft.estimatedCny
      const references = inputs.length === 0 ? '' : ` with ${inputs.length} input${inputs.length === 1 ? '' : 's'} (${[...new Set(inputs.map(input => INPUT_PARAM[input]))].join(', ')})`
      const summary = `${model.id}, ${plan.mode}${shape === '' ? '' : `, ${shape}`}${references}`
      const base = {
        taskId: accepted.id, model: model.id, mode: plan.mode,
        ...plan.duration === undefined ? {} : { duration: plan.duration },
        ...plan.aspectRatio === undefined ? {} : { aspectRatio: plan.aspectRatio },
        ...plan.resolution === undefined ? {} : { resolution: plan.resolution },
        ...estimated === undefined ? {} : { estimatedCny: estimated },
      }
      if (jobId !== undefined) {
        return {
          ...base, status: accepted.status, jobId,
          message: `${unconfirmed ? `Video task ${accepted.id} (${summary}): ${UNCONFIRMED_NOTE}` : `Video task submitted (${summary}).`} `
            + `Background job ${jobId} reports when it finishes; the file is saved under ${runtime.display(exec, accepted.outputDir)}. `
            + `${estimated === undefined ? '' : `Estimated ${yuan(Number(estimated))}, charged only if it succeeds. `}`
            + 'Carry on with other work meanwhile; there is no need to poll.',
        }
      }
      const final = await waitForTask(runtime, exec, accepted)
      return {
        ...base, status: final.status,
        ...final.outputs === undefined ? {} : {
          outputs: final.outputs.map(output => ({
            ...output.path === undefined ? {} : { path: runtime.display(exec, output.path) },
            ...output.url === undefined ? {} : { url: output.url },
            ...output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds },
          })),
        },
        message: describeTask(runtime, exec, final),
      }
    },
  })
}
