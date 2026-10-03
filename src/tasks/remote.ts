/**
 * Reading the gateway's asynchronous task objects: `POST /v1/videos` and
 * `GET /v1/videos/{id}` (OpenAI video shape plus the gateway's `effective`
 * receipt and `asset`), and `POST /v1/audio/generations` and
 * `GET /v1/audio/generations/{id}` (`outputs[]`). Unknown statuses count as
 * still running; only an explicit terminal status ends a task.
 * @module dsh-media/tasks/remote
 */

/** One produced file as the gateway describes it. */
export interface RemoteOutput {
  /** Position in `outputs[]`, for `/content?index=N`. */
  readonly index: number
  readonly url?: string
  readonly contentType?: string
  readonly title?: string
  readonly durationSeconds?: number
}

/** A task's state. */
export interface RemoteTask {
  readonly id: string
  readonly state: 'pending' | 'completed' | 'failed'
  /** The gateway's own status word. */
  readonly status: string
  /** Percent done, when the gateway reports it. */
  readonly progress?: number
  readonly error?: { readonly code: string; readonly message: string }
  /** Estimated price at submission (CNY, two decimals). */
  readonly estimatedCny?: string
  /** Settled charge (CNY); absent until the gateway settles, which is not the same as free. */
  readonly chargedCny?: string
  readonly outputs: readonly RemoteOutput[]
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const httpUrl = (value: unknown): string | undefined => {
  const url = text(value)
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}
const amount = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2)
  const raw = text(value)
  return raw !== undefined && /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : undefined
}

const COMPLETED = new Set(['completed', 'succeeded', 'success', 'done', 'finished'])
const FAILED = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected'])

function stateOf(status: string): RemoteTask['state'] {
  const word = status.toLowerCase()
  if (COMPLETED.has(word)) return 'completed'
  if (FAILED.has(word)) return 'failed'
  return 'pending'
}

function errorOf(raw: Json): RemoteTask['error'] {
  const nested = record(raw.error)
  const message = text(nested?.message) ?? text(raw.error) ?? text(raw.failure_reason) ?? text(raw.error_message) ?? text(raw.fail_reason)
  const code = text(nested?.code) ?? text(nested?.type) ?? text(raw.error_code)
  if (message === undefined && code === undefined) return undefined
  return { code: code ?? 'GENERATION_FAILED', message: message ?? code ?? 'generation failed' }
}

function progressOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // Some lanes report a fraction, others a percentage.
  return Math.min(100, Math.round(value <= 1 && value !== 0 ? value * 100 : value))
}

function receipt(raw: Json): Pick<RemoteTask, 'estimatedCny' | 'chargedCny'> {
  const effective = record(raw.effective) ?? {}
  const estimatedCny = amount(effective.estimated_cny)
  const chargedCny = amount(effective.charged_cny) ?? amount(raw.charged_cny)
  return {
    ...estimatedCny === undefined ? {} : { estimatedCny },
    ...chargedCny === undefined ? {} : { chargedCny },
  }
}

/**
 * Read a video task.
 * @param body - the parsed answer.
 * @returns the task, or undefined when the answer names no task id.
 */
export function parseVideoTask(body: unknown): RemoteTask | undefined {
  const raw = record(body)
  const id = text(raw?.id) ?? text(raw?.task_id)
  if (raw === undefined || id === undefined) return undefined
  const status = text(raw.status) ?? 'queued'
  const video = record(raw.video) ?? {}
  const asset = record(raw.asset) ?? record(video.asset) ?? {}
  const url = httpUrl(video.url) ?? httpUrl(asset.content_url) ?? httpUrl(raw.url) ?? httpUrl(asset.reference_url)
  const durationMs = typeof asset.duration_ms === 'number' && asset.duration_ms > 0 ? asset.duration_ms : undefined
  const seconds = typeof raw.seconds === 'number' ? raw.seconds : typeof raw.seconds === 'string' ? Number(raw.seconds) : undefined
  const contentType = text(asset.content_type) ?? text(video.content_type)
  const durationSeconds = durationMs !== undefined ? durationMs / 1000 : seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
  const state = stateOf(status)
  const error = state === 'failed' ? errorOf(raw) ?? { code: 'GENERATION_FAILED', message: `the task ended with status "${status}"` } : undefined
  const progress = progressOf(raw.progress)
  return {
    id, state, status,
    ...progress === undefined ? {} : { progress },
    ...error === undefined ? {} : { error },
    ...receipt(raw),
    outputs: state === 'completed'
      ? [{
          index: 0,
          ...url === undefined ? {} : { url },
          ...contentType === undefined ? {} : { contentType },
          ...durationSeconds === undefined ? {} : { durationSeconds },
        }]
      : [],
  }
}

/**
 * Read a music or podcast task.
 * @param body - the parsed answer.
 * @returns the task, or undefined when the answer names no task id.
 */
export function parseAudioTask(body: unknown): RemoteTask | undefined {
  const raw = record(body)
  const id = text(raw?.id) ?? text(raw?.task_id)
  if (raw === undefined || id === undefined) return undefined
  const status = text(raw.status) ?? 'queued'
  const state = stateOf(status)
  const outputs: RemoteOutput[] = []
  if (Array.isArray(raw.outputs)) {
    for (const [index, item] of raw.outputs.entries()) {
      const output = record(item)
      if (output === undefined) continue
      const url = httpUrl(output.content_url) ?? httpUrl(output.url)
      const contentType = text(output.content_type)
      const title = text(output.title)
      const duration = typeof output.duration_seconds === 'number' && output.duration_seconds > 0 ? output.duration_seconds : undefined
      outputs.push({
        index,
        ...url === undefined ? {} : { url },
        ...contentType === undefined ? {} : { contentType },
        ...title === undefined ? {} : { title },
        ...duration === undefined ? {} : { durationSeconds: duration },
      })
    }
  }
  const error = state === 'failed' ? errorOf(raw) ?? { code: 'GENERATION_FAILED', message: `the task ended with status "${status}"` } : undefined
  const progress = progressOf(raw.progress)
  return {
    id, state, status,
    ...progress === undefined ? {} : { progress },
    ...error === undefined ? {} : { error },
    ...receipt(raw),
    outputs: state === 'completed' ? outputs : [],
  }
}
