/**
 * The media service other plugins call, registered as `vibedevMedia`: the
 * film workbench's storyboard generates through it when someone presses a
 * generate button. It takes the same paths as the agent tools — model
 * choice, reference checks and uploads, idempotent submission, a background
 * follower that saves the result — with the caller naming the workspace and
 * where results go. The caller has already shown the price and the user chose
 * to go ahead, so the spending confirmation setting does not ask again.
 * @module dsh-vibedev/service
 */

import type { MediaModel } from './gateway/catalog.js'
import { MediaError } from './gateway/errors.js'
import type { MediaCall, MediaRuntime } from './runtime.js'
import type { TaskRecord, TaskStatus } from './tasks/store.js'
import { generateImages } from './tools/image.js'
import type { ImageRequest } from './tools/image.js'
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
