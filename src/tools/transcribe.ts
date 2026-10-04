/**
 * Speech to text with a VibeDev transcription model: the `audio_transcribe`
 * tool and {@link transcribeAudio}, the core it shares with the
 * `vibedevMedia` host service (the film workbench's caption engine). Short
 * files answer directly; long ones become a gateway task that is polled here.
 *
 * Timings: the gateway answers with the whole transcript only. Its
 * `transcriptionResponse` (sub2api-vibedev `vibedev/audio/http/handler.go`)
 * carries `text` and `duration` and nothing per segment, and the doubao2api
 * sidecar behind it keeps only the latest transcript text. A request for
 * `verbose_json` is accepted and answered as `json`. Segments are parsed when
 * an answer carries them, so callers pick them up when the gateway adds them;
 * they are never made up from the text.
 * @module dsh-media/tools/transcribe
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import { yuan } from '../pricing.js'
import type { MediaCall, MediaRuntime } from '../runtime.js'
import { extensionFor, sniffMime } from '../media/sources.js'
import type { LoadedMedia } from '../media/sources.js'
import { saveNewFile } from '../util/files.js'
import { SOURCE_HELP } from './common.js'

const MAX_BYTES = 20 * 1000 * 1000
const MAX_SECONDS = 10 * 60
const INLINE_CHARS = 20_000
const POLL_MS = 3_000
const POLL_LIMIT_MS = 15 * 60_000
/** Busy answers waited out before a transcription is reported busy (each wait is the gateway's Retry-After). */
const BUSY_RETRIES = 30
const ACCEPTED = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'video/mp4', 'video/webm']
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'interrupted'])
const DONE = new Set(['completed', 'succeeded', 'success', 'done'])

/** What one transcription may send, for callers that prepare audio before asking. */
export const TRANSCRIBE_LIMITS: {
  /** Largest file, in bytes (decimal megabytes, as the gateway counts). */
  readonly maxBytes: number
  /** Longest recording, in seconds. */
  readonly maxSeconds: number
  /** MIME types the gateway transcribes; 16 kHz mono WAV works best. */
  readonly accepted: readonly string[]
} = { maxBytes: MAX_BYTES, maxSeconds: MAX_SECONDS, accepted: ACCEPTED }

/** One transcription request: a file or bytes, plus options. */
export interface TranscribeRequest {
  /**
   * The audio: a workspace-relative or absolute path, an http(s) link, a
   * `data:` URL, or `chat:N` for agent calls. Give this or {@link data}.
   */
  readonly file?: string
  /** The audio bytes, for callers that hold them already. Give this or {@link file}. */
  readonly data?: Uint8Array
  /** The type of {@link data}; read from its header when omitted. */
  readonly mimeType?: string
  /** File name {@link data} is uploaded as; `audio.<ext>` when omitted. */
  readonly name?: string
  /** Language code of the speech; the gateway takes Mandarin (`zh`) only. Defaults to `zh`. */
  readonly language?: string
  /** Transcription model id; the pinned or first catalog model when omitted. */
  readonly model?: string
  /**
   * Sent as `Idempotency-Key`: the same key with the same file answers with
   * the same gateway task instead of transcribing (and charging) again. The
   * gateway refuses a key reused with a different file or file name
   * (`AUDIO_IDEMPOTENCY_CONFLICT`).
   */
  readonly idempotencyKey?: string
  /**
   * Ask the gateway for a task at once and poll it here, rather than holding
   * the upload request open (the gateway holds it for up to three minutes).
   */
  readonly background?: boolean
  /** Ask for segment timings (`verbose_json`). The gateway does not return them yet; see the module notes. */
  readonly timestamps?: boolean
}

/** One timed piece of a transcript, in seconds from the start of the file. */
export interface TranscribeSegment {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** A finished transcription. */
export interface TranscribeResult {
  /** The model that transcribed. */
  readonly model: string
  /** The whole transcript, trimmed. */
  readonly text: string
  /** The language asked for. */
  readonly language: string
  /** The file name the audio was sent as. */
  readonly name: string
  /** Length of the audio: the gateway's figure, else the WAV header's. */
  readonly seconds?: number
  /**
   * Segment timings, only when the gateway returned them; the gateway does not
   * do so yet, so callers needing timings must handle their absence.
   */
  readonly segments?: readonly TranscribeSegment[]
  /** The gateway task id, when the gateway made one. */
  readonly taskId?: string
  /** The estimate shown before sending, when the catalog price allowed one. */
  readonly estimatedCny?: string
  /** What the gateway charged, when its answer says. */
  readonly chargedCny?: string
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * The length of a PCM WAV file from its header.
 * @param data - the file bytes.
 * @returns seconds, or undefined when the header cannot be read.
 */
export function wavSeconds(data: Uint8Array): number | undefined {
  if (data.byteLength < 44) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let byteRate: number | undefined
  let offset = 12
  while (offset + 8 <= data.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 16 <= data.byteLength) byteRate = view.getUint32(offset + 16, true)
    if (id === 'data') return byteRate === undefined || byteRate === 0 ? undefined : Math.min(size, data.byteLength - offset - 8) / byteRate
    offset += 8 + size + (size % 2)
  }
  return undefined
}

/**
 * Segment timings from a transcription answer: OpenAI's `segments` (seconds)
 * or doubao's `utterances` (milliseconds, also under `result`). Entries with
 * blank text or unusable times are dropped; nothing is inferred.
 * @param answer - the parsed answer.
 * @returns the segments, or undefined when the answer carries no timing list.
 */
export function parseSegments(answer: unknown): TranscribeSegment[] | undefined {
  const root = record(answer)
  const pick = (items: unknown, startKey: string, endKey: string, scale: number): TranscribeSegment[] | undefined => {
    if (!Array.isArray(items)) return undefined
    const segments: TranscribeSegment[] = []
    for (const item of items) {
      const entry = record(item)
      const words = text(entry?.text)?.trim()
      const start = finite(entry?.[startKey])
      const end = finite(entry?.[endKey])
      if (words === undefined || words === '' || start === undefined || end === undefined || start < 0 || end < start) continue
      segments.push({ start: start / scale, end: end / scale, text: words })
    }
    return segments
  }
  return pick(root?.segments, 'start', 'end', 1)
    ?? pick(root?.utterances, 'start_time', 'end_time', 1000)
    ?? pick(record(root?.result)?.utterances, 'start_time', 'end_time', 1000)
}

function cancelled(taskId: string | undefined): MediaError {
  return new MediaError(taskId === undefined
    ? 'The transcription was cancelled.'
    : `The transcription was cancelled; gateway task ${taskId} may still finish and be charged.`, 'ABORTED')
}

function sleep(ms: number, signal: AbortSignal, taskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled(taskId)); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = (): void => { clearTimeout(timer); reject(cancelled(taskId)) }
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** The audio of a request, from a path or link, or from the caller's bytes. */
async function audioOf(runtime: MediaRuntime, call: MediaCall, request: TranscribeRequest): Promise<LoadedMedia> {
  const file = request.file?.trim()
  if ((file === undefined || file === '') === (request.data === undefined)) {
    throw new MediaError('Give the audio either as a file or as bytes, not both or neither.', 'AUDIO_INPUT_INVALID', { field: 'file' })
  }
  if (request.data === undefined) return runtime.load(call, file as string, 'audio', MAX_BYTES)
  const data = request.data
  if (data.byteLength === 0) throw new MediaError('The audio is empty.', 'AUDIO_INPUT_INVALID', { field: 'data' })
  if (data.byteLength > MAX_BYTES) {
    throw new MediaError(`The audio is ${(data.byteLength / 1e6).toFixed(1)} MB; the limit is 20 MB. Split it first.`, 'MEDIA_TOO_LARGE', { field: 'data' })
  }
  const named = request.name?.trim() ?? ''
  const mime = (request.mimeType?.split(';')[0]?.trim().toLowerCase() || undefined) ?? sniffMime(data, named)
  const name = named === '' ? `audio.${extensionFor(mime)}` : named
  return { source: name, name, mime, data }
}

/** Whether an answer holds the finished transcript: a finished status, or (answers without a status) a text. */
function finished(answer: Json | undefined): boolean {
  const status = text(answer?.status)?.toLowerCase()
  return status === undefined ? text(answer?.text) !== undefined : DONE.has(status)
}

/**
 * Transcribe one recording: check it, confirm the spending when the setting
 * asks, send it and wait for the transcript, polling a gateway task when the
 * answer is one. Cancelling stops the wait only: a gateway task already
 * accepted runs on and is charged.
 * @param runtime - the media runtime.
 * @param call - the tool call or host call (signal, workspace, spending confirmation).
 * @param request - the audio and options.
 * @param toolName - the tool named in a spending confirmation.
 * @returns the transcript.
 */
export async function transcribeAudio(runtime: MediaRuntime, call: MediaCall, request: TranscribeRequest,
  toolName = 'audio_transcribe'): Promise<TranscribeResult> {
  const language = (request.language ?? 'zh').trim().toLowerCase() || 'zh'
  const model = await runtime.pickModel('transcription', 'transcription', request.model, undefined, call.signal)
  const media = await audioOf(runtime, call, request)
  if (!ACCEPTED.includes(media.mime)) {
    throw new MediaError(`"${media.source}" is ${media.mime}, not an audio file the gateway transcribes; convert it to 16 kHz mono WAV first.`, 'AUDIO_FORMAT_UNSUPPORTED', { field: 'file' })
  }
  const seconds = media.mime === 'audio/wav' ? wavSeconds(media.data) : undefined
  if (seconds !== undefined && seconds > MAX_SECONDS) {
    throw new MediaError(`"${media.source}" is ${(seconds / 60).toFixed(1)} minutes long; the limit is 10 minutes. Split it first.`, 'AUDIO_TOO_LONG', { field: 'file' })
  }
  const tier = model.pricing?.default ?? model.pricing?.tiers[0]
  const estimate = tier?.unit === 'second' && seconds !== undefined ? tier.amount * seconds : undefined
  await runtime.confirmSpending(call, toolName, {
    en: `Transcribe ${media.name} with ${model.id}${estimate === undefined ? ' (billed per minute)' : `, about ${yuan(estimate)}`}.`,
    zh: `用 ${model.id} 转写 ${media.name}${estimate === undefined ? '（按分钟计费）' : `，约 ${yuan(estimate)}`}。`,
  })
  const body = new FormData()
  body.append('file', new Blob([media.data as Uint8Array<ArrayBuffer>], { type: media.mime }), media.name)
  body.append('model', model.id)
  body.append('language', language)
  body.append('response_format', request.timestamps === true ? 'verbose_json' : 'json')
  if (request.timestamps === true) body.append('timestamp_granularities[]', 'segment')
  if (request.background === true) body.append('background', 'true')
  const key = request.idempotencyKey?.trim()
  // The transcription lane runs about two jobs at a time and answers 503 with a
  // short Retry-After beyond that; a long recording holds its slot for about
  // its own length, so wait out more busy answers than other requests do. The
  // gateway releases the key of a request it was too full to take, so the
  // retry under the same key is a fresh submission.
  const response = await runtime.http.send('/v1/audio/transcriptions', {
    method: 'POST', body, timeoutMs: 10 * 60_000, signal: call.signal, busyRetries: BUSY_RETRIES, maxBusyWaitMs: 30_000,
    ...key === undefined || key === '' ? {} : { idempotencyKey: key },
  })
  let answer = record(await response.json().catch(() => undefined))
  const started = runtime.now()
  let taskId = text(answer?.id) ?? text(answer?.task_id)
  // A queued task's answer carries an empty `text`, so the status, not the
  // presence of text, says whether the transcript is final.
  while (!finished(answer)) {
    const status = text(answer?.status)?.toLowerCase()
    if (status !== undefined && FAILED.has(status)) {
      const error = record(answer?.error)
      throw new MediaError(`The transcription failed${error === undefined ? '' : ` (${text(error.code) ?? ''}: ${text(error.message) ?? ''})`}; failed transcriptions are not charged.`, 'TRANSCRIPTION_FAILED')
    }
    if (taskId === undefined) throw new MediaError('The VibeDev gateway returned neither a transcript nor a task.', 'GATEWAY_BAD_RESPONSE')
    if (runtime.now() - started > POLL_LIMIT_MS) throw new MediaError(`The transcription task ${taskId} did not finish within 15 minutes.`, 'TRANSCRIPTION_TIMEOUT')
    await sleep(POLL_MS, call.signal, taskId)
    answer = record(await runtime.http.json(`/v1/audio/transcriptions/${encodeURIComponent(taskId)}`, { timeoutMs: 30_000, signal: call.signal }))
    taskId = text(answer?.id) ?? text(answer?.task_id) ?? taskId
  }
  const duration = finite(answer?.duration) ?? seconds
  const segments = parseSegments(answer)
  const charged = record(answer?.effective)?.charged_cny
  const chargedCny = typeof charged === 'string' && charged.trim() !== '' ? charged.trim() : finite(charged)?.toFixed(2)
  return {
    model: model.id, text: (text(answer?.text) ?? '').trim(), language, name: media.name,
    ...duration === undefined ? {} : { seconds: duration },
    ...segments === undefined ? {} : { segments },
    ...taskId === undefined ? {} : { taskId },
    ...estimate === undefined ? {} : { estimatedCny: estimate.toFixed(2) },
    ...chargedCny === undefined ? {} : { chargedCny },
  }
}

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function audioTranscribeTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'audio_transcribe',
    description: 'Transcribe speech in an audio file to text with a VibeDev transcription model. Mandarin Chinese (zh) only for now; '
      + 'at most 20 MB and 10 minutes; 16 kHz mono WAV works best. Charged per minute of audio.',
    parameters: {
      file: { type: 'string', required: true, description: `The audio file: ${SOURCE_HELP}.` },
      language: { type: 'string', description: 'Language code of the speech. Only zh is supported now (the default).' },
      model: { type: 'string', description: 'Transcription model id from media_models. Omit to use the default.' },
      save: { type: 'boolean', description: 'Also save the transcript under media/transcripts/. Long transcripts are always saved.' },
      filename: { type: 'string', description: 'File name for a saved transcript, without extension.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          text: { type: 'string', required: true },
          path: { type: 'string' },
          seconds: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const head = `Transcript (${value.model}${value.seconds === undefined ? '' : `, ${value.seconds.toFixed(1)} s of audio`})`
          + `${value.path === undefined ? '' : `, saved to ${value.path}`}:`
        const body = value.text.length > INLINE_CHARS ? `${value.text.slice(0, INLINE_CHARS)}\n… (truncated; the full text is in the saved file)` : value.text
        return [{ type: 'text', text: `${head}\n${body}` }]
      },
    },
    async execute(args, exec) {
      const result = await transcribeAudio(runtime, exec, {
        file: args.file,
        ...args.language === undefined ? {} : { language: args.language },
        ...args.model === undefined ? {} : { model: args.model },
      })
      let path: string | undefined
      if (args.save === true || result.text.length > INLINE_CHARS) {
        const file = await saveNewFile(runtime.outputFolder(exec, 'transcripts'), runtime.stem(args.filename ?? result.name, undefined), 'txt',
          new TextEncoder().encode(`${result.text}\n`))
        path = runtime.display(exec, file)
      }
      return {
        model: result.model, text: result.text,
        ...path === undefined ? {} : { path },
        ...result.seconds === undefined ? {} : { seconds: result.seconds },
      }
    },
  })
}
