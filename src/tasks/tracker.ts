/**
 * Following video and audio tasks to the end: submit under the task's
 * idempotency key, poll the gateway, save the results into the workspace and
 * record the outcome. Polling belongs to the plugin, not to a tool call or a
 * background job, so a task keeps being followed after its job is stopped and
 * after the host restarts.
 *
 * Money rules: a task record is removed only when the first submission was
 * refused outright, so nothing can exist under its key. Every answer that
 * leaves the outcome open (no answer, a gateway error, a 409) keeps the record,
 * and the same request is resent under the same key, which returns the
 * original task when there is one. A resend that is refused outright is
 * retried only briefly, so a refused request is not created later behind the
 * user's back.
 * @module dsh-vibedev/tasks/tracker
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MediaError } from '../gateway/errors.js'
import type { GatewayHttp } from '../gateway/http.js'
import { extensionFor } from '../media/sources.js'
import { downloadTo, placeFile } from '../util/files.js'
import { parseAudioTask, parseVideoTask } from './remote.js'
import type { RemoteOutput, RemoteTask } from './remote.js'
import { isFinished } from './store.js'
import type { TaskKind, TaskOutput, TaskRecord, TaskStore } from './store.js'

/** Construction options; the clock and `sleep` are test seams. */
export interface TrackerOptions {
  readonly http: GatewayHttp
  readonly store: TaskStore
  readonly log?: (message: string) => void
  readonly now?: () => number
  /** Resolves after `ms`, or early when `signal` aborts; never rejects. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Give up on a task this long after it was created. Defaults to 3 hours. */
  readonly maxAgeMs?: number
  /** An unconfirmed submission is resent until it is this old. Defaults to 5 minutes. */
  readonly resendWindowMs?: number
  /**
   * A resend refused outright is retried until the task is this old, in case
   * an earlier attempt is still being created. Defaults to 3 minutes.
   */
  readonly refusalGraceMs?: number
  /** Download attempts for a finished task before its links are reported instead. Defaults to 5. */
  readonly downloadAttempts?: number
  /** The largest output downloaded. Defaults to 2 GiB. */
  readonly maxDownloadBytes?: number
  /** A claim not renewed for this long is taken over by another process. Defaults to 60 seconds. */
  readonly claimStaleMs?: number
}

interface KindSpec {
  readonly endpoint: string
  poll(id: string): string
  content(id: string, index: number): string
  parse(body: unknown): RemoteTask | undefined
  readonly fallbackType: string
  interval(elapsedMs: number): number
}

const SPECS: Readonly<Record<TaskKind, KindSpec>> = {
  video: {
    endpoint: '/v1/videos',
    poll: id => `/v1/videos/${encodeURIComponent(id)}`,
    content: id => `/v1/videos/${encodeURIComponent(id)}/content`,
    parse: parseVideoTask,
    fallbackType: 'video/mp4',
    interval: elapsed => elapsed < 120_000 ? 6_000 : elapsed < 600_000 ? 10_000 : 15_000,
  },
  audio: {
    endpoint: '/v1/audio/generations',
    poll: id => `/v1/audio/generations/${encodeURIComponent(id)}`,
    content: (id, index) => `/v1/audio/generations/${encodeURIComponent(id)}/content?index=${index}`,
    parse: parseAudioTask,
    fallbackType: 'audio/mp4',
    interval: elapsed => elapsed < 180_000 ? 5_000 : 10_000,
  },
}

const NO_ANSWER_CODES = new Set(['GATEWAY_TIMEOUT', 'GATEWAY_UNREACHABLE', 'GATEWAY_BAD_RESPONSE'])
const CONSECUTIVE_FAILURE_LIMIT = 30
/**
 * How long one submission may take. The gateway submits to the provider over
 * this request's connection and abandons the submission when it drops, so a
 * short client deadline would itself make outcomes unknown.
 */
const SUBMIT_TIMEOUT_MS = 5 * 60_000

/**
 * The gateway could not tell whether the provider received an earlier
 * submission under this key, so it created no task and charges nothing; the
 * key answers this forever. Resubmitting needs a new key.
 */
const SUBMISSION_AMBIGUOUS = 'VIDEO_SUBMISSION_AMBIGUOUS'
/** The same key was sent with a different body: a plugin bug, never retried. */
const KEY_CONFLICT = /_IDEMPOTENCY_CONFLICT$/

/**
 * Whether a failed submission may still have created the task: no answer, an
 * unreadable answer, a gateway error that is not "busy", or a 409 such as
 * `VIDEO_SUBMISSION_IN_PROGRESS` (an earlier attempt is still being submitted).
 * @param error - the failure.
 * @returns true when the same key should be sent again.
 */
export function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof MediaError)) return false
  if (NO_ANSWER_CODES.has(error.code)) return true
  if (error.code === SUBMISSION_AMBIGUOUS || KEY_CONFLICT.test(error.code)) return false
  const status = error.details.status
  return status === 409 || (status !== undefined && status >= 500 && error.details.busy !== true)
}

/**
 * The record of a submission the gateway settled for good without a task.
 * @param error - the failure.
 * @returns the failure to record, or undefined when the error is not one of these.
 */
function settledWithoutTask(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof MediaError)) return undefined
  if (error.code === SUBMISSION_AMBIGUOUS) {
    return {
      code: error.code,
      message: 'The gateway could not confirm the submission with the provider, so it created no task and charged nothing. '
        + 'Submit the request again if it is still wanted.',
    }
  }
  if (KEY_CONFLICT.test(error.code)) {
    return { code: error.code, message: 'The gateway refused the request: its key was already used for a different request. Nothing was charged; submit it again.' }
  }
  return undefined
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve() }, ms)
    const done = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function urlExtension(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The live progress line of a running task.
 * @param task - the gateway's view.
 * @returns a short line such as `in progress 40%`.
 */
export function progressLine(task: RemoteTask): string {
  const word = task.status.toLowerCase()
  const label = word === 'queued' || word === 'submitted' || word === 'pending' ? 'queued' : word.replace(/_/g, ' ')
  return task.progress === undefined ? label : `${label} ${task.progress}%`
}

/** Follows tasks; one poll loop per task. */
export class TaskTracker {
  private readonly following = new Map<string, Promise<TaskRecord>>()
  private readonly submissions = new Map<string, Promise<unknown>>()
  private readonly listeners = new Map<string, Set<(record: TaskRecord) => void>>()
  private readonly claims = new Map<string, ReturnType<typeof setInterval>>()
  private readonly downloadFailures = new Map<string, number>()
  private readonly controller = new AbortController()
  private readonly holder = randomUUID()
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  /**
   * @param options - gateway client, store and test seams.
   */
  constructor(private readonly options: TrackerOptions) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? sleepFor
  }

  private get signal(): AbortSignal {
    return this.controller.signal
  }

  private log(message: string): void {
    this.options.log?.(`dsh-vibedev: ${message}`)
  }

  /**
   * Record and submit a new task. An outright refusal of the first attempt
   * throws and leaves no record. When the outcome stays open, the task stays
   * recorded and is resent in the background, and this throws `SUBMISSION_UNCONFIRMED`.
   * @param draft - the task, with status `submitting`.
   * @param signal - cancels waiting for the submission.
   * @returns the accepted task.
   */
  async submit(draft: TaskRecord, signal?: AbortSignal): Promise<TaskRecord> {
    const submission = this.runSubmission(draft, signal)
    this.submissions.set(draft.id, submission)
    try {
      return await submission
    } finally {
      this.submissions.delete(draft.id)
    }
  }

  private async runSubmission(draft: TaskRecord, signal?: AbortSignal): Promise<TaskRecord> {
    const spec = SPECS[draft.kind]
    await this.options.store.add(draft)
    await this.holdClaim(draft.id)
    let unknown = false
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      let task: RemoteTask | undefined
      try {
        task = spec.parse(await this.options.http.json(spec.endpoint, {
          method: 'POST', json: draft.body, idempotencyKey: draft.id, timeoutMs: SUBMIT_TIMEOUT_MS,
          ...signal === undefined ? {} : { signal },
        }))
        if (task === undefined) throw new MediaError('The VibeDev gateway accepted the request but returned no task id.', 'GATEWAY_BAD_RESPONSE')
      } catch (error) {
        if (signal?.aborted === true) {
          await this.finish(draft.id, {
            status: 'lost',
            error: { code: 'SUBMISSION_CANCELLED', message: 'The request was cancelled while it was being submitted. If the gateway had already created the task, it runs and is charged, but dsh-vibedev cannot follow it.' },
          }).catch(() => undefined)
          await this.releaseClaim(draft.id)
          throw error
        }
        const settled = settledWithoutTask(error)
        if (settled !== undefined) {
          await this.finish(draft.id, { status: 'failed', error: settled }).catch(() => undefined)
          await this.releaseClaim(draft.id)
          throw new MediaError(settled.message, settled.code, { retryable: false }, { cause: error })
        }
        if (!outcomeUnknown(error)) {
          if (!unknown) {
            // Refused before anything could exist under this key.
            this.dropClaim(draft.id)
            await this.options.store.remove(draft.id)
            throw error
          }
          // Refused after an unanswered attempt, which may still be under way: the background resend settles it.
          lastError = error
          break
        }
        unknown = true
        lastError = error
        await this.sleep(2_000 * (attempt + 1), this.signal)
        continue
      }
      // The gateway accepted it: from here on the record is never removed.
      try {
        const accepted = await this.apply(draft, task)
        if (isFinished(accepted)) await this.releaseClaim(accepted.id)
        else this.followQuietly(accepted.id)
        return accepted
      } catch (error) {
        this.log(`recording task ${draft.id} (${task.id}) failed, following it anyway: ${messageOf(error)}`)
        await this.options.store.update(draft.id, { gatewayId: task.id, status: 'pending' }).catch(() => undefined)
        this.followQuietly(draft.id)
        return { ...draft, gatewayId: task.id, status: 'pending', updatedAt: this.now() }
      }
    }
    this.followQuietly(draft.id)
    throw new MediaError(`The VibeDev gateway did not confirm the request (${messageOf(lastError)}). `
      + 'dsh-vibedev keeps resending it for a few minutes under the same request key, so it cannot be created twice, and saves the result if it runs. '
      + `Check media_tasks for task ${draft.id}; do not submit the same request again.`, 'SUBMISSION_UNCONFIRMED', { retryable: false })
  }

  /**
   * Follow a recorded task until it ends or the tracker is disposed. A task
   * still being submitted is followed once its submission settles.
   * @param id - the local task id.
   * @returns the task at the end (or at disposal, still running).
   */
  follow(id: string): Promise<TaskRecord> {
    const running = this.following.get(id)
    if (running !== undefined) return running
    const submission = this.submissions.get(id)
    const loop = (submission === undefined ? Promise.resolve() : submission.then(() => undefined, () => undefined))
      .then(() => this.loop(id))
      .finally(() => { this.following.delete(id) })
    this.following.set(id, loop)
    return loop
  }

  private followQuietly(id: string): void {
    this.follow(id).catch((error: unknown) => { this.log(`following task ${id} stopped: ${messageOf(error)}`) })
  }

  /**
   * Hear about every change to one task.
   * @param id - the local task id.
   * @param listener - called with the updated task.
   * @returns unsubscribe.
   */
  onUpdate(id: string, listener: (record: TaskRecord) => void): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** Follow every task that has not ended, as after a restart. */
  async resume(): Promise<void> {
    for (const record of await this.options.store.list()) {
      if (!isFinished(record)) this.followQuietly(record.id)
    }
  }

  /** Stop all polling and give up this process's claims; tasks stay recorded and are resumed next time. */
  dispose(): void {
    this.controller.abort()
    for (const id of [...this.claims.keys()]) {
      this.dropClaim(id)
      void this.options.store.release(id, this.holder).catch(() => undefined)
    }
  }

  private notify(record: TaskRecord): void {
    for (const listener of this.listeners.get(record.id) ?? []) {
      try { listener(record) } catch { /* a listener cannot break polling */ }
    }
  }

  private async update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'kind' | 'createdAt'>>): Promise<TaskRecord> {
    const next = await this.options.store.update(id, patch)
    if (next === undefined) throw new MediaError(`dsh-vibedev has no task ${id}.`, 'UNKNOWN_TASK')
    this.notify(next)
    return next
  }

  private async finish(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'kind' | 'createdAt'>>): Promise<TaskRecord> {
    this.downloadFailures.delete(id)
    return this.update(id, { ...patch, progress: undefined, finishedAt: this.now() })
  }

  /** Hold (or keep) this process's claim on a task, renewing it while held. */
  private async holdClaim(id: string): Promise<boolean> {
    if (this.claims.has(id)) return true
    const stale = this.options.claimStaleMs ?? 60_000
    const held = await this.options.store.claim(id, this.holder, stale).catch(() => false)
    if (!held) return false
    const timer = setInterval(() => {
      void this.options.store.renewClaim(id, this.holder).catch(() => undefined)
    }, Math.max(1_000, Math.floor(stale / 3)))
    timer.unref?.()
    this.claims.set(id, timer)
    return true
  }

  private dropClaim(id: string): void {
    const timer = this.claims.get(id)
    if (timer !== undefined) clearInterval(timer)
    this.claims.delete(id)
  }

  private async releaseClaim(id: string): Promise<void> {
    if (!this.claims.has(id)) return
    this.dropClaim(id)
    await this.options.store.release(id, this.holder).catch(() => undefined)
  }

  private async loop(id: string): Promise<TaskRecord> {
    let record = await this.options.store.get(id)
    if (record === undefined) throw new MediaError(`dsh-vibedev has no task ${id}.`, 'UNKNOWN_TASK')
    const spec = SPECS[record.kind]
    const maxAge = this.options.maxAgeMs ?? 3 * 3_600_000
    let failures = 0
    try {
      while (!this.signal.aborted) {
        try {
          record = await this.options.store.get(id) ?? record
          if (isFinished(record)) return record
          if (!await this.holdClaim(id)) {
            // Another process is following it; look again later.
            await this.sleep(30_000, this.signal)
            continue
          }
          const age = this.now() - record.createdAt
          if (age > maxAge) {
            return await this.finish(id, { status: 'lost', error: { code: 'TASK_TIMED_OUT', message: `No result after ${Math.round(maxAge / 3_600_000)} hours; dsh-vibedev stopped following it.` } })
          }
          let task: RemoteTask | undefined
          if (record.status === 'submitting' || record.gatewayId === undefined) {
            if (age > (this.options.resendWindowMs ?? 5 * 60_000)) {
              return await this.finish(id, { status: 'lost', error: { code: 'SUBMISSION_UNCONFIRMED', message: 'The gateway never confirmed this request. If it did run, it is not visible to dsh-vibedev.' } })
            }
            task = spec.parse(await this.options.http.json(spec.endpoint, {
              method: 'POST', json: record.body, idempotencyKey: record.id, timeoutMs: SUBMIT_TIMEOUT_MS, signal: this.signal,
            }))
          } else {
            task = spec.parse(await this.options.http.json(spec.poll(record.gatewayId), { timeoutMs: 30_000, signal: this.signal }))
          }
          if (task === undefined) throw new MediaError('The VibeDev gateway returned an unreadable task.', 'GATEWAY_BAD_RESPONSE')
          record = await this.apply(record, task)
          failures = 0
          if (isFinished(record)) return record
          await this.sleep(spec.interval(age), this.signal)
        } catch (error) {
          if (this.signal.aborted) break
          failures++
          const wait = await this.afterFailure(record, error, failures).catch((failure: unknown) => {
            this.log(`task ${id}: ${messageOf(failure)}`)
            return 30_000
          })
          if (wait === undefined) return await this.options.store.get(id) ?? record
          await this.sleep(wait, this.signal)
        }
      }
      return await this.options.store.get(id).catch(() => undefined) ?? record
    } finally {
      await this.releaseClaim(id)
    }
  }

  /**
   * Decide what a failed resend, poll or download means.
   * @returns how long to wait before the next try, or undefined once the task has been ended.
   */
  private async afterFailure(record: TaskRecord, error: unknown, failures: number): Promise<number | undefined> {
    const status = error instanceof MediaError ? error.details.status : undefined
    const code = error instanceof MediaError ? error.code : undefined
    const submitting = record.status === 'submitting' || record.gatewayId === undefined
    if (code !== 'DOWNLOAD_RETRY') this.log(`task ${record.id} (${record.kind}) check failed: ${messageOf(error)}`)
    if (code === 'NOT_SIGNED_IN' || code === 'SIGN_IN_REJECTED') {
      await this.update(record.id, { progress: 'waiting for a VibeDev sign-in' })
      return 60_000
    }
    const settled = submitting ? settledWithoutTask(error) : undefined
    if (settled !== undefined) {
      await this.finish(record.id, { status: 'failed', error: settled })
      return undefined
    }
    if (submitting && !outcomeUnknown(error) && status !== undefined && status >= 400 && status < 500) {
      // The resend was refused outright, so no task exists under the key yet. An earlier
      // attempt may still be being created; after a short grace the refusal stands.
      if (this.now() - record.createdAt < (this.options.refusalGraceMs ?? 3 * 60_000)) return 30_000
      await this.finish(record.id, { status: 'failed', error: { code: code ?? `HTTP_${status}`, message: messageOf(error) } })
      return undefined
    }
    if (status === 402) {
      await this.update(record.id, { progress: 'paused: the VibeDev balance is used up; top up to receive the result' })
      return 60_000
    }
    if (status === 404) {
      await this.finish(record.id, { status: 'lost', error: { code: 'TASK_NOT_FOUND', message: 'The VibeDev gateway no longer knows this task.' } })
      return undefined
    }
    if (failures >= CONSECUTIVE_FAILURE_LIMIT) {
      await this.finish(record.id, { status: 'lost', error: { code: code ?? 'POLL_FAILED', message: `Checking the task failed ${failures} times in a row: ${messageOf(error)}` } })
      return undefined
    }
    return Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4))
  }

  /** Record what the gateway says about a task; save the outputs of a finished one. */
  private async apply(record: TaskRecord, task: RemoteTask): Promise<TaskRecord> {
    const money = {
      ...task.estimatedCny === undefined ? {} : { estimatedCny: task.estimatedCny },
      ...task.chargedCny === undefined ? {} : { chargedCny: task.chargedCny },
    }
    if (task.state === 'pending') {
      return this.update(record.id, { gatewayId: task.id, status: 'pending', progress: progressLine(task), ...money })
    }
    if (task.state === 'failed') {
      return this.finish(record.id, { gatewayId: task.id, status: 'failed', ...money, ...task.error === undefined ? {} : { error: task.error } })
    }
    const current = await this.update(record.id, { gatewayId: task.id, status: 'pending', progress: 'saving the result', ...money })
    const { outputs, missing } = await this.saveOutputs(current, task)
    if (missing > 0) {
      const attempts = (this.downloadFailures.get(record.id) ?? 0) + 1
      this.downloadFailures.set(record.id, attempts)
      if (attempts < (this.options.downloadAttempts ?? 5)) {
        throw new MediaError(`${missing} result file(s) could not be downloaded yet.`, 'DOWNLOAD_RETRY', { retryable: true })
      }
    }
    let charged = money
    if (task.chargedCny === undefined) {
      // The charge settles shortly after completion; one more look, best effort. A missing charge is not a free task.
      const settled = await this.options.http.json(SPECS[record.kind].poll(task.id), { timeoutMs: 15_000, signal: this.signal })
        .then(body => SPECS[record.kind].parse(body), () => undefined)
      if (settled?.chargedCny !== undefined) charged = { ...money, chargedCny: settled.chargedCny }
    }
    return this.finish(record.id, {
      gatewayId: task.id, status: 'completed', outputs, ...charged,
      ...missing === 0 ? {} : { error: { code: 'DOWNLOAD_FAILED', message: `${missing} of ${outputs.length} result file(s) could not be downloaded; the gateway links are listed instead.` } },
    })
  }

  /**
   * Save every output not saved yet, recording each one as it lands. A
   * shutdown mid-download throws, so the task stays open and is resumed.
   */
  private async saveOutputs(record: TaskRecord, task: RemoteTask): Promise<{ outputs: TaskOutput[]; missing: number }> {
    const spec = SPECS[record.kind]
    const saved = new Map((record.outputs ?? []).filter(output => output.path !== undefined && output.index !== undefined).map(output => [output.index, output]))
    const outputs: TaskOutput[] = []
    let missing = 0
    for (const [position, output] of task.outputs.entries()) {
      const earlier = saved.get(output.index)
      if (earlier !== undefined) {
        outputs.push(earlier)
        continue
      }
      const facts = {
        index: output.index,
        ...output.url === undefined ? {} : { url: output.url },
        ...output.contentType === undefined ? {} : { contentType: output.contentType },
        ...output.title === undefined ? {} : { title: output.title },
        ...output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds },
      }
      const fromUrl = urlExtension(output.url)
      const extension = output.contentType === undefined
        ? fromUrl ?? extensionFor(spec.fallbackType)
        : extensionFor(output.contentType, fromUrl ?? extensionFor(spec.fallbackType))
      const stem = task.outputs.length > 1 ? `${record.stem}-${position + 1}` : record.stem
      const temporary = join(record.outputDir, `.dsh-media-${record.id}-${output.index}.part`)
      try {
        const bytes = await this.fetchOutput(record, task, output, temporary)
        const path = await placeFile(temporary, record.outputDir, stem, extension)
        outputs.push({ ...facts, path, bytes })
        await this.options.store.update(record.id, { outputs: outputs.filter(item => item.path !== undefined) }).catch(() => undefined)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        if (this.signal.aborted) throw error
        this.log(`saving output ${position + 1} of task ${record.id} failed: ${messageOf(error)}`)
        outputs.push(facts)
        missing++
      }
    }
    return { outputs, missing }
  }

  /** Download one output: the authenticated `/content` route, then the gateway's no-login link. */
  private async fetchOutput(record: TaskRecord, task: RemoteTask, output: RemoteOutput, temporary: string): Promise<number> {
    const spec = SPECS[record.kind]
    const sources: Array<{ url: string; anonymous: boolean }> = []
    if (record.kind === 'video') sources.push({ url: spec.content(task.id, output.index), anonymous: false })
    if (output.url !== undefined) sources.push({ url: output.url, anonymous: true })
    if (record.kind === 'audio') sources.push({ url: spec.content(task.id, output.index), anonymous: false })
    let lastError: unknown = new MediaError('The gateway named no file to download.', 'OUTPUT_URL_MISSING')
    for (const source of sources) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.options.http.send(source.url, {
            headers: { accept: '*/*' }, anonymous: source.anonymous, timeoutMs: 15 * 60_000, signal: this.signal,
          })
          return await downloadTo(response, temporary, this.options.maxDownloadBytes ?? 2 * 1024 ** 3, this.signal)
        } catch (error) {
          lastError = error
          const status = error instanceof MediaError ? error.details.status : undefined
          if (this.signal.aborted || status !== undefined && status >= 400 && status < 500) break
          await this.sleep(2_000 * (attempt + 1), this.signal)
        }
      }
      if (this.signal.aborted) break
    }
    throw lastError
  }
}
