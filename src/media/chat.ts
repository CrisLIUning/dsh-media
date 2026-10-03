/**
 * Media the user attached in the conversation, addressed as `chat:N` (the Nth
 * most recent attachment of the kind the input needs) or `chat:<kind>:N`
 * (`chat:image:1`, `chat:video:2`, `chat:audio:1`). The model sees attached
 * images but no path to them; this is how it can pass one on as a reference.
 * @module dsh-media/media/chat
 */

import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { MediaError } from '../gateway/errors.js'
import type { LoadedMedia } from './sources.js'
import { sniffMime } from './sources.js'

/** The media kinds a chat reference can name. */
export type ChatMediaKind = 'image' | 'video' | 'audio'

/** A parsed `chat:` reference. */
export interface ChatReference {
  /** The kind named in the reference, or undefined for `chat:N`. */
  readonly kind?: ChatMediaKind
  /** 1 for the most recent. */
  readonly index: number
}

/**
 * Parse a `chat:` reference.
 * @param source - what the model passed.
 * @returns the reference, or undefined when the source is not one.
 */
export function parseChatReference(source: string): ChatReference | undefined {
  const match = /^chat:(?:(image|video|audio):)?(\d{1,3})$/i.exec(source.trim())
  if (match === null) return undefined
  const index = Number(match[2])
  if (index < 1) return undefined
  const kind = match[1]?.toLowerCase() as ChatMediaKind | undefined
  return kind === undefined ? { index } : { kind, index }
}

interface ChatItem {
  readonly kind: ChatMediaKind | 'other'
  readonly name: string
  readonly image?: ImageAttachmentRef
  readonly file?: FileAttachmentRef
}

function fileKind(name: string): ChatItem['kind'] {
  const mime = sniffMime(new Uint8Array(0), name)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

/**
 * The user's attachments, most recent first.
 * @param messages - the conversation, oldest first.
 * @returns images and files from user messages.
 */
export function chatAttachments(messages: readonly Message[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue
    const blocks: readonly ContentBlock[] = message.content
    for (const block of [...blocks].reverse()) {
      if (block.type === 'image' && block.offloaded !== true) {
        items.push({ kind: 'image', name: block.attachment.name ?? 'image', image: block.attachment })
      } else if (block.type === 'file') {
        items.push({ kind: fileKind(block.attachment.name), name: block.attachment.name, file: block.attachment })
      }
    }
  }
  return items
}

async function collect(stream: AsyncIterable<Uint8Array>, maxBytes: number, name: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new MediaError(`The attached file "${name}" is larger than ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
    }
    chunks.push(chunk)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  return data
}

/**
 * Load one `chat:` reference.
 * @param reference - the parsed reference.
 * @param want - the kind the input needs; `chat:N` counts only attachments of this kind.
 * @param messages - the conversation, oldest first.
 * @param store - the attachment store.
 * @param maxBytes - the largest accepted file.
 * @param signal - cancels the read.
 * @returns the loaded media.
 */
export async function loadChatReference(reference: ChatReference, want: ChatMediaKind, messages: readonly Message[],
  store: AttachmentStore, maxBytes: number, signal?: AbortSignal): Promise<LoadedMedia> {
  const kind = reference.kind ?? want
  const source = `chat:${reference.kind === undefined ? '' : `${reference.kind}:`}${reference.index}`
  if (kind !== want) {
    throw new MediaError(`"${source}" names a ${kind}, but this input takes a ${want}.`, 'CHAT_REFERENCE_KIND_MISMATCH')
  }
  const candidates = chatAttachments(messages).filter(item => item.kind === kind)
  const item = candidates[reference.index - 1]
  if (item === undefined) {
    throw new MediaError(`"${source}" asks for ${kind} attachment number ${reference.index} (counting back from the most recent), `
      + `but the user attached ${candidates.length === 0 ? 'no' : `only ${candidates.length}`} ${kind}${candidates.length === 1 ? '' : 's'} in this conversation.`,
    'CHAT_REFERENCE_NOT_FOUND')
  }
  if (item.image !== undefined) {
    const stored = await store.readImage(item.image, signal)
    if (stored.data.byteLength > maxBytes) {
      throw new MediaError(`The attached image "${item.name}" is larger than ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
    }
    return { source, name: item.name, mime: stored.ref.mediaType, data: stored.data }
  }
  const file = item.file as FileAttachmentRef
  if (file.bytes > maxBytes) {
    throw new MediaError(`The attached file "${item.name}" is ${(file.bytes / 1048576).toFixed(1)} MiB; the limit is ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
  }
  const data = await collect(store.readFileStream(file, signal), maxBytes, item.name)
  return { source, name: item.name, mime: sniffMime(data, item.name), data }
}
