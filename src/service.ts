/**
 * The media service other plugins call, registered as `vibedevMedia`: the
 * film workbench's storyboard generates through it when someone presses a
 * generate button. It takes the same paths as the agent tools — model
 * choice, reference checks and uploads, idempotent submission, a background
 * follower that saves the result — with the caller naming the workspace and
 * where results go. The caller has already shown the price and the user chose
 * to go ahead, so the spending confirmation setting does not ask again.
 * Transcription (the workbench's gateway caption engine) may instead name the
 * agent tool call it runs for, so the setting asks as it does for the tools;
 * a caller that sends one recording in several parts asks once for all of
 * them with {@link MediaHostService.confirmSpending} and then sends each part
 * as confirmed.
 * @module dsh-media/service
 */

import type { MediaModel } from './gateway/catalog.js'
import { MediaError } from './gateway/errors.js'
import { yuan } from './pricing.js'
import type { MediaCall, MediaRuntime } from './runtime.js'
import type { TaskRecord, TaskStatus } from './tasks/store.js'
import { generateImages } from './tools/image.js'
import type { ImageRequest } from './tools/image.js'
import { transcribeAudio } from './tools/transcribe.js'
import type { TranscribeRequest, TranscribeResult } from './tools/transcribe.js'
import { prepareVideoTask } from './tools/video.js'
import type { VideoRequest } from './tools/video.js'

/** Where a host request runs and where its results go. */
export interface HostTarget {
  /** The workspace; relative input paths resolve against it. */
  readonly cwd: string
  /** Absolute folder the results are saved in. */
  readonly folder: string
  /** File-name stem of the results. */
  readonly stem: string
}

/** How the cost of a host request is confirmed. */
export interface HostSpending {
  /**
   * The caller showed the cost and the user chose to go ahead, so the
   * spending confirmation setting does not ask. Defaults to true, as for the
   * service's other paid calls; pass false with {@link agent} and
   * {@link callId} to let the setting ask through the user's approval.
   */
  readonly confirmed?: boolean
  /** The agent whose tool call this request serves, for the approval prompt. */
  readonly agent?: MediaCall['agent']
  /** That tool call's id. */
  readonly callId?: MediaCall['callId']
}

/** A transcription whose cost is confirmed once before its parts are sent. */
export interface SpendingRequest {
  /** Seconds of audio that will be sent, in all parts together. */
  readonly seconds: number
  /** The estimated price in yuan, when the caller has one. */
  readonly amountCny?: number
}

/** `95 s`, or `125 s (2.1 min)` from a minute on, in English and Chinese. */
function length(seconds: number): { en: string; zh: string } {
  const shown = Number(seconds.toFixed(1))
  if (shown < 60) return { en: `${shown} s`, zh: `${shown} 秒` }
  const minutes = Number((seconds / 60).toFixed(1))
  return { en: `${shown} s (${minutes} min)`, zh: `${shown} 秒（${minutes} 分钟）` }
}

/** A video or audio task, as host callers see it. */
export interface MediaTaskView {
  readonly id: string
  readonly kind: TaskRecord['kind']
  readonly model: string
  readonly status: TaskStatus
  readonly progress?: string
  readonly outputs?: readonly { readonly path?: string; readonly url?: string; readonly durationSeconds?: number }[]
  readonly error?: { readonly code: string; readonly message: string }
  readonly estimatedCny?: string
  readonly chargedCny?: string
  readonly createdAt: number
  readonly updatedAt: number
}

const view = (record: TaskRecord): MediaTaskView => ({
  id: record.id,
  kind: record.kind,
  model: record.model,
  status: record.status,
  ...record.progress === undefined ? {} : { progress: record.progress },
  ...record.outputs === undefined ? {} : { outputs: record.outputs.map(output => ({ ...output })) },
  ...record.error === undefined ? {} : { error: { ...record.error } },
  ...record.estimatedCny === undefined ? {} : { estimatedCny: record.estimatedCny },
  ...record.chargedCny === undefined ? {} : { chargedCny: record.chargedCny },
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

export class MediaHostService {
  constructor(private readonly runtime: MediaRuntime, readonly version: string) {}

  private call(target: HostTarget, signal: AbortSignal): MediaCall {
    return { signal, cwd: target.cwd, confirmed: true }
  }

  /**
   * The media models this account can use (cached briefly).
   * @param signal - cancels the request.
   * @returns the models in catalog order.
   */
  models(signal?: AbortSignal): Promise<readonly MediaModel[]> {
    return this.runtime.models(signal)
  }

  /**
   * Generate images now and save them.
   * @param request - what to generate.
   * @param target - the workspace and where the files go.
   * @param signal - cancels the request.
   * @returns the model, the saved files, the estimate and a revised prompt.
   */
  async generateImages(request: ImageRequest, target: HostTarget, signal: AbortSignal) {
    const result = await generateImages(this.runtime, this.call(target, signal), request, { folder: target.folder, stem: target.stem })
    return { ...result, images: result.images.map(({ data: _data, ...image }) => image) }
  }

  /**
   * Submit a video. The plugin follows the task in the background and saves
   * the video when it finishes; watch it with {@link task} and {@link onTask}.
   * A submission the gateway did not confirm is resent in the background
   * under the same key, so it is reported as a task still being submitted
   * rather than as a failure.
   * @param request - what to generate.
   * @param target - the workspace and where the video goes.
   * @param signal - cancels the preparation and the submission.
   * @returns the task.
   */
  async startVideo(request: VideoRequest, target: HostTarget, signal: AbortSignal): Promise<MediaTaskView> {
    const prepared = await prepareVideoTask(this.runtime, this.call(target, signal), request, { folder: target.folder, stem: target.stem })
    try {
      return view(await this.runtime.tracker.submit(prepared.draft, signal))
    } catch (error) {
      if (error instanceof MediaError && error.code === 'SUBMISSION_UNCONFIRMED') {
        const recorded = await this.runtime.store.get(prepared.draft.id)
        if (recorded !== undefined) return view(recorded)
      }
      throw error
    }
  }

  /**
   * Transcribe one recording (Mandarin only for now; at most 20 MB and 10
   * minutes, see `TRANSCRIBE_LIMITS`). The gateway is asked for a background
   * task unless the request says otherwise, and the task is polled until the
   * transcript is final. The result has the text; `segments` only when the
   * gateway returns timings, which it does not do yet.
   * @param request - the audio (a path relative to `target.cwd`, a link, or bytes) and options.
   * @param target - the workspace.
   * @param signal - stops waiting; a gateway task already accepted runs on and is charged.
   * @param spending - whether the cost was already confirmed (default) or the setting may ask.
   * @returns the transcript.
   */
  transcribe(request: TranscribeRequest, target: Pick<HostTarget, 'cwd'>, signal: AbortSignal,
    spending: HostSpending = {}): Promise<TranscribeResult> {
    const call: MediaCall = {
      signal, cwd: target.cwd, confirmed: spending.confirmed ?? true,
      ...spending.agent === undefined ? {} : { agent: spending.agent },
      ...spending.callId === undefined ? {} : { callId: spending.callId },
    }
    return transcribeAudio(this.runtime, call, { ...request, background: request.background ?? true })
  }

  /**
   * Ask once for the cost of a transcription the caller sends in several
   * parts, as the spending confirmation setting asks before generation: a
   * no-op when the setting is off or `spending.confirmed` is true, otherwise
   * the user is asked through the approval prompt of the agent tool call that
   * `spending` names, with the length and the estimated price. Unlike the
   * service's other calls, a missing `confirmed` counts as not confirmed,
   * since asking is what this call is for. Once it resolves, send each part
   * with {@link transcribe} and `{ confirmed: true }`.
   * @param request - the seconds of audio to be sent and the estimated price.
   * @param spending - the agent and tool call to ask through.
   * @param signal - withdraws the question.
   * @throws {@link MediaError} `AUDIO_INPUT_INVALID` for a negative or non-finite length or price,
   *   `SPENDING_CONFIRMATION_UNAVAILABLE` when nobody can be asked, `SPENDING_DECLINED` when the user
   *   declines or nobody answers, `ABORTED` when the question is withdrawn.
   */
  async confirmSpending(request: SpendingRequest, spending: HostSpending = {}, signal?: AbortSignal): Promise<void> {
    const { seconds, amountCny } = request
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new MediaError(`The length to confirm must be a number of seconds, not ${String(seconds)}.`, 'AUDIO_INPUT_INVALID', { field: 'seconds' })
    }
    if (amountCny !== undefined && (!Number.isFinite(amountCny) || amountCny < 0)) {
      throw new MediaError(`The price to confirm must be an amount in yuan, not ${String(amountCny)}.`, 'AUDIO_INPUT_INVALID', { field: 'amountCny' })
    }
    const call: MediaCall = {
      signal: signal ?? new AbortController().signal,
      ...spending.confirmed === undefined ? {} : { confirmed: spending.confirmed },
      ...spending.agent === undefined ? {} : { agent: spending.agent },
      ...spending.callId === undefined ? {} : { callId: spending.callId },
    }
    const audio = length(seconds)
    await this.runtime.confirmSpending(call, 'audio_transcribe', {
      en: `Transcribe ${audio.en} of audio${amountCny === undefined ? ' (billed per minute)' : `, about ${yuan(amountCny)}`}.`,
      zh: `转写 ${audio.zh}音频${amountCny === undefined ? '（按分钟计费）' : `，约 ${yuan(amountCny)}`}。`,
    })
  }

  /**
   * A task's current state.
   * @param id - the task id.
   * @returns the task, or `undefined` when there is none.
   */
  async task(id: string): Promise<MediaTaskView | undefined> {
    const record = await this.runtime.store.get(id)
    return record === undefined ? undefined : view(record)
  }

  /**
   * Hear about every change to one task.
   * @param id - the task id.
   * @param listener - called with the task after each change.
   * @returns stops listening.
   */
  onTask(id: string, listener: (task: MediaTaskView) => void): () => void {
    return this.runtime.tracker.onUpdate(id, (record) => { listener(view(record)) })
  }
}
