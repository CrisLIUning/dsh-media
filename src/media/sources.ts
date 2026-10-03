/**
 * Loading media inputs: a workspace path, an absolute path, an HTTP(S) link or a
 * `data:` URL. The type is read from the file's own header first, so a file
 * named `.png` that is really a JPEG is treated as a JPEG.
 * @module dsh-media/media/sources
 */

import { MediaError } from '../gateway/errors.js'

/** One loaded input. */
export interface LoadedMedia {
  /** What the caller passed. */
  readonly source: string
  /** A file name for uploads. */
  readonly name: string
  readonly mime: string
  readonly data: Uint8Array
}

/** How paths are read; the tool layer backs it with the host's filesystem service. */
export interface SourceReader {
  readPath(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; name: string }>
  readonly fetch?: typeof globalThis.fetch
}

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
}

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
}

/**
 * The file extension for a MIME type.
 * @param mime - the type.
 * @param fallback - extension when the type is unknown.
 * @returns the extension, without a dot.
 */
export function extensionFor(mime: string, fallback = 'bin'): string {
  return MIME_EXTENSION[mime.toLowerCase().split(';')[0]?.trim() ?? ''] ?? fallback
}

function ascii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.subarray(start, start + length))
}

/**
 * The MIME type a file's leading bytes identify, falling back to its name.
 * @param data - the file bytes (the first 64 suffice).
 * @param name - the file name or path, for the extension fallback.
 * @returns the type, or `application/octet-stream` when unknown.
 */
export function sniffMime(data: Uint8Array, name = ''): string {
  if (data.length >= 8 && data[0] === 0x89 && ascii(data, 1, 3) === 'PNG') return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && ascii(data, 0, 4) === 'GIF8') return 'image/gif'
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF') {
    const format = ascii(data, 8, 4)
    if (format === 'WEBP') return 'image/webp'
    if (format === 'WAVE') return 'audio/wav'
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  if (data.length >= 12 && ascii(data, 4, 4) === 'ftyp') {
    const brand = ascii(data, 8, 4)
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
    return 'video/mp4'
  }
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return /\.mkv$/i.test(name) ? 'video/x-matroska' : 'video/webm'
  }
  if (data.length >= 3 && ascii(data, 0, 3) === 'ID3') return 'audio/mpeg'
  if (data.length >= 2 && data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0 && ((data[1] ?? 0) & 0x06) !== 0) return 'audio/mpeg'
  if (data.length >= 4 && ascii(data, 0, 4) === 'OggS') return 'audio/ogg'
  if (data.length >= 4 && ascii(data, 0, 4) === 'fLaC') return 'audio/flac'
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase()
  return extension === undefined ? 'application/octet-stream' : EXTENSION_MIME[extension] ?? 'application/octet-stream'
}

function baseName(source: string): string {
  const clean = source.split(/[?#]/)[0] ?? source
  const name = clean.split(/[\\/]/).pop() ?? ''
  return name === '' ? 'media' : decodeURIComponent(name)
}

async function readCapped(response: Response, maxBytes: number, source: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaError(`"${source}" is ${(declared / 1048576).toFixed(1)} MiB; the limit is ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new MediaError(`"${source}" is larger than ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
    }
    chunks.push(value)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  return data
}

/**
 * Load one input.
 * @param source - path, URL or data URL.
 * @param reader - how paths are read, and the fetch to use for links.
 * @param maxBytes - the largest accepted size.
 * @param signal - cancels the load.
 * @returns the bytes, a name and the sniffed type.
 */
export async function loadMedia(source: string, reader: SourceReader, maxBytes: number, signal?: AbortSignal): Promise<LoadedMedia> {
  const trimmed = source.trim()
  const dataUrl = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(trimmed)
  if (dataUrl !== null) {
    const payload = dataUrl[3] ?? ''
    const base64 = (dataUrl[2] ?? '').split(';').some(parameter => parameter.trim().toLowerCase() === 'base64')
    let data: Uint8Array
    try {
      data = base64 ? new Uint8Array(Buffer.from(payload, 'base64')) : new TextEncoder().encode(decodeURIComponent(payload))
    } catch (error) {
      throw new MediaError('The inline media is not a readable data URL.', 'MEDIA_DATA_URL_INVALID', {}, { cause: error })
    }
    if (data.byteLength > maxBytes) throw new MediaError(`The inline media is larger than ${(maxBytes / 1048576).toFixed(1)} MiB.`, 'MEDIA_TOO_LARGE')
    const sniffed = sniffMime(data, '')
    const declared = dataUrl[1]?.trim().toLowerCase()
    const mime = sniffed !== 'application/octet-stream' ? sniffed : declared === undefined || declared === '' ? sniffed : declared
    return { source: 'inline data', name: `inline.${extensionFor(mime)}`, mime, data }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let response: Response
    try {
      response = await (reader.fetch ?? globalThis.fetch)(trimmed, { redirect: 'follow', ...signal === undefined ? {} : { signal } })
    } catch (error) {
      throw new MediaError(`Could not download "${trimmed}" (${error instanceof Error ? error.message : String(error)}).`, 'MEDIA_DOWNLOAD_FAILED', {}, { cause: error })
    }
    if (!response.ok) throw new MediaError(`Downloading "${trimmed}" failed with HTTP ${response.status}.`, 'MEDIA_DOWNLOAD_FAILED', { status: response.status })
    const data = await readCapped(response, maxBytes, trimmed)
    const sniffed = sniffMime(data, trimmed)
    const header = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const mime = sniffed !== 'application/octet-stream' ? sniffed : header ?? sniffed
    const name = baseName(trimmed)
    return { source: trimmed, name: /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${extensionFor(mime)}`, mime, data }
  }
  const { data, name } = await reader.readPath(trimmed, maxBytes, signal)
  return { source: trimmed, name, mime: sniffMime(data, name), data }
}
