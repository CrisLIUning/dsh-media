/**
 * What every media tool shares: the gateway client, the model catalog (cached
 * briefly), model choice, the workspace output folders, input loading
 * (workspace paths, links, data URLs and `chat:` attachments) and the optional
 * spending confirmation.
 * @module dsh-media/runtime
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { MediaKind, MediaModel } from './gateway/catalog.js'
import { parseMediaCatalog } from './gateway/catalog.js'
import { MediaError } from './gateway/errors.js'
import type { GatewayHttp } from './gateway/http.js'
import type { MediaLibrary } from './gateway/assets.js'
import { loadChatReference, parseChatReference } from './media/chat.js'
import type { ChatMediaKind } from './media/chat.js'
import { loadMedia } from './media/sources.js'
import type { LoadedMedia, SourceReader } from './media/sources.js'
import type { TaskStore } from './tasks/store.js'
import type { TaskTracker } from './tasks/tracker.js'
import { fileTimestamp, safeStem } from './util/files.js'

/** The model a setting can pin per kind of output. */
export type ModelSlot = 'image' | 'video' | 'music' | 'podcast' | 'transcription'

/** Live settings (the plugin's volatile config). */
export interface MediaSettings {
  /** Output folder, relative to the workspace (or absolute). */
  readonly outputDir: () => string
  readonly confirmSpending: () => boolean
  /** A pinned model id, or `''` to let the agent choose. */
  readonly defaultModel: (slot: ModelSlot) => string
}

/** Construction options. Optional services are read when used, since they can come and go. */
export interface RuntimeOptions {
  readonly http: GatewayHttp
  readonly library: MediaLibrary
  readonly tracker: TaskTracker
  readonly store: TaskStore
  readonly settings: MediaSettings
  readonly stateDir: string
  readonly fs?: () => FileSystem | undefined
  readonly attachments?: () => AttachmentStore | undefined
  readonly approval?: () => ApprovalService | undefined
  readonly jobs?: () => JobRegistry | undefined
  readonly now?: () => number
  readonly log?: (message: string) => void
}

const CATALOG_TTL_MS = 2 * 60_000

/** Wait for a shared promise under one caller's signal without cancelling it for the others. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new MediaError('The request was cancelled.', 'ABORTED', {}, { cause: signal.reason }))
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { reject(new MediaError('The request was cancelled.', 'ABORTED', {}, { cause: signal.reason })) }
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', stop); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
}

/** Shared state and helpers of the media tools. */
export class MediaRuntime {
  private catalog: { models: MediaModel[]; at: number } | undefined
  private fetching: Promise<MediaModel[]> | undefined
  private generation = 0
  readonly now: () => number

  /**
   * @param options - gateway client, stores, settings and host services.
   */
  constructor(readonly options: RuntimeOptions) {
    this.now = options.now ?? Date.now
  }

  get http(): GatewayHttp { return this.options.http }
  get library(): MediaLibrary { return this.options.library }
  get tracker(): TaskTracker { return this.options.tracker }
  get store(): TaskStore { return this.options.store }
  get settings(): MediaSettings { return this.options.settings }

  /**
   * The media models this account can use. Cached for two minutes; a failed
   * refresh falls back to the last list for up to an hour.
   * @param signal - cancels the request.
   * @returns the models, in catalog order.
   */
  async models(signal?: AbortSignal): Promise<MediaModel[]> {
    const cached = this.catalog
    if (cached !== undefined && this.now() - cached.at < CATALOG_TTL_MS) return cached.models
    if (this.fetching === undefined) {
      // Shared by every caller, so it does not stop when one caller is cancelled; each caller waits under its own signal.
      const generation = this.generation
      const fetching: Promise<MediaModel[]> = this.http.json('/v1/models', { timeoutMs: 30_000 })
        .then((body) => {
          const models = parseMediaCatalog(body)
          // A list fetched for an account that has since changed is not kept.
          if (generation === this.generation) this.catalog = { models, at: this.now() }
          return models
        })
        .finally(() => { if (this.fetching === fetching) this.fetching = undefined })
      fetching.catch(() => undefined)
      this.fetching = fetching
    }
    try {
      return await abortable(this.fetching, signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (cached !== undefined && this.now() - cached.at < 3_600_000 && !(error instanceof MediaError && error.code === 'NOT_SIGNED_IN')) return cached.models
      throw error
    }
  }

  /** Forget what belonged to the previous account (catalog and uploaded assets), as after a sign-in change. */
  accountChanged(): void {
    this.generation++
    this.catalog = undefined
    this.fetching = undefined
    this.library.clear()
  }

  /** Forget the cached catalog. */
  invalidateCatalog(): void {
    this.accountChanged()
  }

  /**
   * Choose the model for a request: the one asked for, else the pinned one,
   * else the first in catalog order that `accept` takes (or simply the first).
   * @param kind - the kind of output.
   * @param slot - the settings slot.
   * @param requested - the model the agent asked for, if any.
   * @param accept - whether a model can serve this request.
   * @param signal - cancels the catalog request.
   * @returns the model.
   */
  async pickModel(kind: MediaKind, slot: ModelSlot, requested: string | undefined, accept?: (model: MediaModel) => boolean,
    signal?: AbortSignal): Promise<MediaModel> {
    const models = await this.models(signal)
    const ofKind = models.filter(model => model.kind === kind
      && (slot === 'music' ? model.audioKind !== 'podcast' : slot === 'podcast' ? model.audioKind === 'podcast' : true))
    const wanted = requested?.trim()
    if (wanted !== undefined && wanted !== '') {
      const found = models.find(model => model.id === wanted) ?? models.find(model => model.id.toLowerCase() === wanted.toLowerCase())
      if (found === undefined) {
        throw new MediaError(`There is no model "${wanted}" on this VibeDev account. ${slotLabel(slot)} models: ${ofKind.map(model => model.id).join(', ') || 'none'}.`, 'MODEL_NOT_FOUND', { field: 'model' })
      }
      if (!ofKind.includes(found)) {
        throw new MediaError(`${found.id} is not a ${slotLabel(slot).toLowerCase()} model. ${slotLabel(slot)} models: ${ofKind.map(model => model.id).join(', ') || 'none'}.`, 'MODEL_KIND_MISMATCH', { field: 'model' })
      }
      return found
    }
    if (ofKind.length === 0) {
      throw new MediaError(`This VibeDev account has no ${slotLabel(slot).toLowerCase()} model available right now.`, 'NO_MODEL_AVAILABLE')
    }
    const pinned = this.settings.defaultModel(slot).trim()
    const ordered = pinned === '' ? ofKind : [...ofKind.filter(model => model.id === pinned), ...ofKind.filter(model => model.id !== pinned)]
    return (accept === undefined ? undefined : ordered.find(model => accept(model))) ?? ordered[0] as MediaModel
  }

  /**
   * The workspace of the calling session.
   * @param exec - the tool call.
   * @returns its absolute working directory, when it has one.
   */
  workspace(exec: ToolRunContext): string | undefined {
    return exec.agent?.session.header.cwd
  }

  /**
   * The absolute folder outputs of one kind are saved in: `<workspace>/<outputDir>/<sub>`.
   * Without a workspace, the plugin state directory is used.
   * @param exec - the tool call.
   * @param sub - `images`, `videos`, `audio` or `transcripts`.
   * @returns the folder (created on first write).
   */
  outputFolder(exec: ToolRunContext, sub: string): string {
    const configured = this.settings.outputDir().trim() || 'media'
    const base = isAbsolute(configured) ? configured : resolve(this.workspace(exec) ?? join(this.options.stateDir, 'outputs'), configured)
    return join(base, sub)
  }

  /**
   * A file-name stem: the requested name, else a timestamp plus the start of the prompt.
   * @param filename - the agent's requested name, without extension.
   * @param prompt - the prompt.
   * @returns the stem.
   */
  stem(filename: string | undefined, prompt: string | undefined): string {
    const requested = filename === undefined ? '' : safeStem(filename.replace(/\.[a-z0-9]{2,4}$/i, ''), 80)
    if (requested !== '') return requested
    const words = prompt === undefined ? '' : safeStem(prompt, 24)
    return `${fileTimestamp(new Date(this.now()))}${words === '' ? '' : `-${words}`}`
  }

  /**
   * A path relative to the workspace when it is inside it, for messages.
   * @param exec - the tool call.
   * @param path - an absolute path.
   * @returns the display path.
   */
  display(exec: ToolRunContext, path: string): string {
    const root = this.workspace(exec)
    if (root === undefined) return path
    const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${path.includes('\\') ? '\\' : '/'}`
    return path.startsWith(prefix) ? path.slice(prefix.length).replace(/\\/g, '/') : path
  }

  private reader(exec: ToolRunContext): SourceReader {
    const cwd = this.workspace(exec)
    return {
      readPath: async (path, maxBytes, signal) => {
        const fs = this.options.fs?.()
        if (fs !== undefined) {
          const target = await fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, ...signal === undefined ? {} : { signal } })
          const info = await fs.stat(target, signal)
          if (info === undefined) throw new MediaError(`"${path}" does not exist.`, 'MEDIA_NOT_FOUND')
          if (info.type !== 'file') throw new MediaError(`"${path}" is not a file.`, 'MEDIA_NOT_FOUND')
          if (info.size !== undefined && info.size > maxBytes) {
            throw new MediaError(`"${path}" is ${(info.size / 1048576).toFixed(1)} MiB; the limit is ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
          }
          const data = await fs.readBytes(target, signal, maxBytes).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'FS_TOO_LARGE') {
              throw new MediaError(`"${path}" is larger than ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
            }
            throw error
          })
          return { data, name: basename(fs.processPath(target)) }
        }
        const absolute = resolve(cwd ?? process.cwd(), path)
        const info = await stat(absolute).catch(() => undefined)
        if (info === undefined || !info.isFile()) throw new MediaError(`"${path}" does not exist or is not a file.`, 'MEDIA_NOT_FOUND')
        if (info.size > maxBytes) throw new MediaError(`"${path}" is ${(info.size / 1048576).toFixed(1)} MiB; the limit is ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
        return { data: new Uint8Array(await readFile(absolute)), name: basename(absolute) }
      },
    }
  }

  /**
   * Load one input: a `chat:` attachment, a data URL, a link, or a path in the workspace.
   * @param exec - the tool call.
   * @param source - what the agent passed.
   * @param want - the kind the input needs.
   * @param maxBytes - the largest accepted file.
   * @returns the loaded media.
   */
  async load(exec: ToolRunContext, source: string, want: ChatMediaKind, maxBytes: number): Promise<LoadedMedia> {
    const chat = parseChatReference(source)
    if (chat !== undefined) {
      const store = this.options.attachments?.()
      const agent = exec.agent
      if (store === undefined || agent === undefined) {
        throw new MediaError(`"${source}" refers to a chat attachment, but this host does not expose them; pass a file path instead.`, 'CHAT_REFERENCE_UNAVAILABLE')
      }
      return loadChatReference(chat, want, agent.session.deriveMessages(), store, maxBytes, exec.signal)
    }
    return loadMedia(source, this.reader(exec), maxBytes, exec.signal)
  }

  /**
   * Ask the user before spending, when the setting asks for it.
   * @param exec - the tool call.
   * @param toolName - the tool asking.
   * @param what - the request and its estimated price, in English and Chinese.
   * @throws {@link MediaError} when the user declines or nobody can answer.
   */
  async confirmSpending(exec: ToolRunContext, toolName: string, what: { en: string; zh: string }): Promise<void> {
    if (!this.settings.confirmSpending()) return
    const approval = this.options.approval?.()
    const agent = exec.agent
    if (approval === undefined || agent === undefined) {
      throw new MediaError('Spending confirmation is turned on in the dsh-media settings, but this host cannot ask the user. '
        + 'Nothing was submitted; the user can turn the setting off to generate without asking.', 'SPENDING_CONFIRMATION_UNAVAILABLE')
    }
    const outcome = await approval.request({
      agent, toolName, callId: exec.callId, signal: exec.signal,
      reason: what.en,
      displayReason: { en: what.en, zh: what.zh, 'zh-CN': what.zh },
    })
    if (outcome === 'allowed-once') return
    if (outcome === 'cancelled') throw new MediaError('The request was cancelled before it was submitted; nothing was charged.', 'ABORTED')
    throw new MediaError(outcome === 'rejected'
      ? 'The user declined the cost of this request; nothing was submitted or charged. Ask before trying again.'
      : 'Nobody could confirm the cost of this request; nothing was submitted or charged.', 'SPENDING_DECLINED')
  }

  /** The background-job registry, when the host has one. */
  jobs(): JobRegistry | undefined {
    return this.options.jobs?.()
  }

  /** Log through the host. */
  log(message: string): void {
    this.options.log?.(message)
  }
}

function slotLabel(slot: ModelSlot): string {
  return { image: 'Image', video: 'Video', music: 'Music', podcast: 'Podcast', transcription: 'Transcription' }[slot]
}
