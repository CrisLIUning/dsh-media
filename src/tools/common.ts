/**
 * Pieces the media tools share: how inputs are described to the model, the
 * background job that reports a video or audio task, and the wording of task
 * outcomes.
 * @module dsh-vibedev/tools/common
 */

import type { JobKind, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import type { MediaRuntime } from '../runtime.js'
import { yuan } from '../pricing.js'
import type { TaskRecord } from '../tasks/store.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'media-video': 'media-video'
    'media-audio': 'media-audio'
  }
}

/** How a media input may be given, for parameter descriptions. */
export const SOURCE_HELP = 'a workspace file path, an http(s) link, or chat:1 for the most recent matching file the user attached in this conversation (chat:2 the one before)'

/**
 * A prompt excerpt for labels.
 * @param prompt - the prompt.
 * @param max - the longest excerpt.
 * @returns the excerpt.
 */
export function excerpt(prompt: string | undefined, max = 60): string {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * The charge line of a finished task.
 * @param record - the task.
 * @returns `Charged ¥4.95.`, an estimate, or the empty string.
 */
export function moneyLine(record: TaskRecord): string {
  if (record.status !== 'completed') return record.status === 'failed' ? ' Failed tasks are not charged.' : ''
  if (record.chargedCny !== undefined) return ` Charged ${yuan(Number(record.chargedCny))}.`
  if (record.estimatedCny !== undefined) return ` Estimated ${yuan(Number(record.estimatedCny))} (the gateway settles the charge shortly).`
  return ''
}

/**
 * The model-facing account of a task's current state.
 * @param runtime - for display paths.
 * @param exec - the tool call, for workspace-relative paths; optional after a restart.
 * @param record - the task.
 * @returns the text.
 */
export function describeTask(runtime: MediaRuntime, exec: ToolRunContext | undefined, record: TaskRecord): string {
  const what = record.kind === 'video' ? 'Video' : 'Audio'
  const show = (path: string) => exec === undefined ? path : runtime.display(exec, path)
  switch (record.status) {
    case 'completed': {
      const saved = (record.outputs ?? []).map((output, index) => {
        const name = output.title === undefined ? '' : ` "${output.title}"`
        const length = output.durationSeconds === undefined ? '' : ` (${output.durationSeconds.toFixed(1)} s)`
        return output.path === undefined
          ? `output ${index + 1}${name} could not be downloaded; link (valid about 30 days): ${output.url ?? 'none'}`
          : `${show(output.path)}${name}${length}`
      })
      return `${what} task ${record.id} finished with ${record.model}. Saved: ${saved.join('; ') || 'nothing'}.${moneyLine(record)}`
    }
    case 'failed':
      return `${what} task ${record.id} failed${record.error === undefined ? '' : ` (${record.error.code}: ${record.error.message})`}.${moneyLine(record)}`
    case 'lost':
      return `${what} task ${record.id} is no longer followed: ${record.error?.message ?? 'unknown reason'}`
    default:
      return `${what} task ${record.id} with ${record.model} is ${record.status === 'submitting' ? 'being submitted' : record.progress ?? 'in progress'}; `
        + `results are saved under ${show(record.outputDir)} when it finishes.`
  }
}

/**
 * Report a submitted task through a background job owned by the calling
 * session, so the agent hears when it ends. Stopping the job stops the report,
 * not the task: the gateway has no cancel, so the task still finishes, is saved
 * and is charged.
 * @param runtime - the media runtime.
 * @param exec - the submitting tool call.
 * @param record - the accepted task.
 * @returns the job id, or undefined when the host has no job registry or refused the job.
 */
export function startTaskJob(runtime: MediaRuntime, exec: ToolRunContext, record: TaskRecord): string | undefined {
  const jobs = runtime.jobs()
  if (jobs === undefined) return undefined
  const kind: JobKind = record.kind === 'video' ? 'media-video' : 'media-audio'
  try {
    return jobs.start({
      kind,
      label: `${record.kind === 'video' ? 'video' : 'audio'} (${record.model}): ${record.label}`,
      ...exec.agent === undefined ? {} : { owner: exec.agent.id },
      run: (job) => {
        let settle!: (outcome: JobOutcome) => void
        const done = new Promise<JobOutcome>((resolve) => { settle = resolve })
        let stopped = false
        const unsubscribe = runtime.tracker.onUpdate(record.id, (next) => {
          if (!stopped && next.progress !== undefined) job.updateProgress(next.progress)
        })
        if (record.progress !== undefined) job.updateProgress(record.progress)
        runtime.tracker.follow(record.id).then((final) => {
          unsubscribe()
          let text: string
          try { text = describeTask(runtime, exec, final) } catch { text = `${record.kind} task ${record.id}: ${final.status}` }
          if (final.status === 'completed') settle({ status: 'completed', detail: final.error === undefined ? 'saved' : 'saved with missing files', result: text })
          else if (final.status === 'failed' || final.status === 'lost') settle({ status: 'failed', detail: final.error?.code ?? final.status, result: text })
          else settle({ status: 'killed', detail: 'the plugin stopped; the task is resumed next time', result: text })
        }, (error: unknown) => {
          unsubscribe()
          settle({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
        })
        return {
          cancel: () => {
            stopped = true
            unsubscribe()
            settle({
              status: 'killed',
              detail: 'stopped reporting; the gateway task keeps running',
              result: `Stopped reporting ${record.kind} task ${record.id}. The gateway cannot cancel it: it still finishes, is saved under `
                + `${runtime.display(exec, record.outputDir)} and is charged. media_tasks shows its state.`,
            })
          },
          done,
        }
      },
    })
  } catch (error) {
    runtime.log(`dsh-vibedev: could not start a background job for task ${record.id}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** A submitted task and how it is reported. */
export interface Submitted {
  readonly record: TaskRecord
  /** The background job reporting it, when the host has a job registry. */
  readonly jobId?: string
  /** The gateway did not confirm the submission; it is being resent under the same key. */
  readonly unconfirmed: boolean
}

/**
 * Submit a task and start its report. An unconfirmed submission is not an
 * error here: the agent must not resubmit it, so it is reported like any
 * other task while the tracker resends it under the same key.
 * @param runtime - the media runtime.
 * @param exec - the tool call.
 * @param draft - the task to submit.
 * @returns the task and its job.
 */
export async function submitTask(runtime: MediaRuntime, exec: ToolRunContext, draft: TaskRecord): Promise<Submitted> {
  let record: TaskRecord
  let unconfirmed = false
  try {
    record = await runtime.tracker.submit(draft, exec.signal)
  } catch (error) {
    if (!(error instanceof MediaError) || error.code !== 'SUBMISSION_UNCONFIRMED') throw error
    record = await runtime.store.get(draft.id) ?? draft
    unconfirmed = true
  }
  const jobId = startTaskJob(runtime, exec, record)
  return { record, unconfirmed, ...jobId === undefined ? {} : { jobId } }
}

/** The sentence about an unconfirmed submission. */
export const UNCONFIRMED_NOTE = 'The gateway did not confirm the submission; dsh-vibedev keeps resending it for a few minutes under the same request key, '
  + 'so it cannot be created twice. Do not submit it again.'

/**
 * Wait for a task in the tool call itself, for hosts without background jobs.
 * @param runtime - the media runtime.
 * @param exec - the tool call; aborting stops waiting, not the task.
 * @param record - the accepted task.
 * @returns the task when it ended, or as it stands when the wait was cut short.
 */
export async function waitForTask(runtime: MediaRuntime, exec: ToolRunContext, record: TaskRecord): Promise<TaskRecord> {
  const final = runtime.tracker.follow(record.id)
  const aborted = new Promise<undefined>((resolve) => {
    if (exec.signal.aborted) resolve(undefined)
    exec.signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  return await Promise.race([final, aborted]) ?? await runtime.store.get(record.id) ?? record
}
