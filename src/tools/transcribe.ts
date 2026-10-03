/**
 * `audio_transcribe`: speech to text with a VibeDev transcription model.
 * Short files answer directly; long ones become a task that is polled here.
 * @module dsh-media/tools/transcribe
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import { yuan } from '../pricing.js'
import type { MediaRuntime } from '../runtime.js'
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

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new MediaError('The transcription was cancelled.', 'ABORTED')); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = (): void => { clearTimeout(timer); reject(new MediaError('The transcription was cancelled.', 'ABORTED')) }
    signal.addEventListener('abort', stop, { once: true })
  })
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
      const language = (args.language ?? 'zh').trim().toLowerCase() || 'zh'
      const model = await runtime.pickModel('transcription', 'transcription', args.model, undefined, exec.signal)
      const media = await runtime.load(exec, args.file, 'audio', MAX_BYTES)
      if (!ACCEPTED.includes(media.mime)) {
        throw new MediaError(`"${media.source}" is ${media.mime}, not an audio file the gateway transcribes; convert it to 16 kHz mono WAV first.`, 'AUDIO_FORMAT_UNSUPPORTED', { field: 'file' })
      }
      const seconds = media.mime === 'audio/wav' ? wavSeconds(media.data) : undefined
      if (seconds !== undefined && seconds > MAX_SECONDS) {
        throw new MediaError(`"${media.source}" is ${(seconds / 60).toFixed(1)} minutes long; the limit is 10 minutes. Split it first.`, 'AUDIO_TOO_LONG', { field: 'file' })
      }
      const tier = model.pricing?.default ?? model.pricing?.tiers[0]
      const estimate = tier?.unit === 'second' && seconds !== undefined ? tier.amount * seconds : undefined
      await runtime.confirmSpending(exec, 'audio_transcribe', {
        en: `Transcribe ${media.name} with ${model.id}${estimate === undefined ? ' (billed per minute)' : `, about ${yuan(estimate)}`}.`,
        zh: `用 ${model.id} 转写 ${media.name}${estimate === undefined ? '（按分钟计费）' : `，约 ${yuan(estimate)}`}。`,
      })
      const body = new FormData()
      body.append('file', new Blob([media.data as Uint8Array<ArrayBuffer>], { type: media.mime }), media.name)
      body.append('model', model.id)
      body.append('language', language)
      body.append('response_format', 'json')
      // The transcription lane runs about two jobs at a time and answers 503 with a
      // short Retry-After beyond that; a long recording holds its slot for about
      // its own length, so wait out more busy answers than other requests do.
      const response = await runtime.http.send('/v1/audio/transcriptions', {
        method: 'POST', body, timeoutMs: 10 * 60_000, signal: exec.signal, busyRetries: BUSY_RETRIES, maxBusyWaitMs: 30_000,
      })
      let answer = record(await response.json().catch(() => undefined))
      const started = runtime.now()
      while (text(answer?.text) === undefined) {
        const id = text(answer?.id) ?? text(answer?.task_id)
        const status = text(answer?.status)?.toLowerCase()
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
          const error = record(answer?.error)
          throw new MediaError(`The transcription failed${error === undefined ? '' : ` (${text(error.code) ?? ''}: ${text(error.message) ?? ''})`}; failed transcriptions are not charged.`, 'TRANSCRIPTION_FAILED')
        }
        if (id === undefined) throw new MediaError('The VibeDev gateway returned neither a transcript nor a task.', 'GATEWAY_BAD_RESPONSE')
        if (runtime.now() - started > POLL_LIMIT_MS) throw new MediaError(`The transcription task ${id} did not finish within 15 minutes.`, 'TRANSCRIPTION_TIMEOUT')
        await sleep(POLL_MS, exec.signal)
        answer = record(await runtime.http.json(`/v1/audio/transcriptions/${encodeURIComponent(id)}`, { timeoutMs: 30_000, signal: exec.signal }))
      }
      const transcript = (text(answer?.text) ?? '').trim()
      const duration = typeof answer?.duration === 'number' ? answer.duration : seconds
      let path: string | undefined
      if (args.save === true || transcript.length > INLINE_CHARS) {
        const file = await saveNewFile(runtime.outputFolder(exec, 'transcripts'), runtime.stem(args.filename ?? media.name, undefined), 'txt',
          new TextEncoder().encode(`${transcript}\n`))
        path = runtime.display(exec, file)
      }
      return {
        model: model.id, text: transcript,
        ...path === undefined ? {} : { path },
        ...duration === undefined ? {} : { seconds: duration },
      }
    },
  })
}
