/**
 * Files the plugin writes: its state directory, output names in the
 * workspace, and atomic writes of generated media. Content is written to a
 * temporary file first and moved into place only when complete, so a crash
 * never leaves a half-written or empty file under a final name.
 * @module dsh-vibedev/util/files
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { MediaError } from '../gateway/errors.js'

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The harness home: `$DSH_HOME` when set (VibeDev sets it to its own home),
 * else `~/.dsh`, the same rule the harness itself applies.
 * @param env - the environment.
 * @returns the absolute home directory.
 */
export function harnessHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return resolve(expandHome(configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured))
}

/**
 * The plugin's own state directory: the configured one, else `<harness home>/dsh-media`
 * (the plugin's former name, kept so an upgrade keeps its tasks and device id).
 * @param configured - the `stateDir` setting; empty for the default.
 * @param env - the environment.
 * @returns the absolute directory.
 */
export function stateDirectory(configured: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const trimmed = configured.trim()
  return trimmed === '' ? join(harnessHome(env), 'dsh-media') : resolve(expandHome(trimmed))
}

/**
 * A file-name stem from free text: characters no file system accepts are
 * dropped, whitespace becomes `-`, and the result is cut to `max` characters.
 * @param text - a prompt or a requested name.
 * @param max - the longest stem, in characters.
 * @returns the stem, possibly empty.
 */
export function safeStem(text: string, max = 40): string {
  const cleaned = text.normalize('NFC')
    // Control characters and the characters Windows reserves in file names.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const cut = [...cleaned].slice(0, max).join('').replace(/[-.]+$/g, '')
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cut) ? `${cut}-file` : cut
}

/**
 * A sortable local timestamp for file names (`20261003-165012`).
 * @param date - the moment.
 * @returns the timestamp.
 */
export function fileTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Rename, retrying the transient refusals Windows gives while a virus scanner
 * or the indexer holds the file.
 * @param from - the current path.
 * @param to - the new path; an existing file is replaced.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 6 || !TRANSIENT_RENAME.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt))
    }
  }
}

/**
 * Move a complete temporary file to the first free name `dir/stem.ext`
 * (then `stem-2.ext`, ...), never replacing an existing file.
 * @param temporary - the complete file.
 * @param dir - the destination directory, created when missing.
 * @param stem - the file-name stem.
 * @param extension - the extension, without a dot.
 * @returns the final path.
 */
export async function placeFile(temporary: string, dir: string, stem: string, extension: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  let linkable = true
  for (let attempt = 1; attempt < 1000; attempt++) {
    const path = join(dir, `${attempt === 1 ? stem : `${stem}-${attempt}`}.${extension}`)
    if (linkable) {
      try {
        // A hard link fails when the name is taken, so two writers never claim one name.
        await link(temporary, path)
        await rm(temporary, { force: true })
        return path
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        // File systems without hard links (FAT, some network shares): reserve, then rename over it.
        linkable = false
      }
    }
    try {
      const handle = await open(path, 'wx')
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    await renameWithRetry(temporary, path)
    return path
  }
  throw new MediaError(`Could not find a free file name for "${stem}.${extension}" in ${dir}.`, 'OUTPUT_NAME_EXHAUSTED')
}

/**
 * Save bytes under the first free name `dir/stem.ext`.
 * @param dir - the destination directory.
 * @param stem - the file-name stem.
 * @param extension - the extension, without a dot.
 * @param data - the content.
 * @returns the final path.
 */
export async function saveNewFile(dir: string, stem: string, extension: string, data: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `.dsh-media-${randomUUID()}.part`)
  try {
    await writeFile(temporary, data)
    return await placeFile(temporary, dir, stem, extension)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Write bytes atomically, replacing the file.
 * @param path - the final path.
 * @param data - the content.
 * @param options - `mode` for a file only its owner may read.
 */
export async function writeFileAtomic(path: string, data: Uint8Array, options: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.part`)
  try {
    await writeFile(temporary, data, options.mode === undefined ? {} : { mode: options.mode })
    await renameWithRetry(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Stream a response body into a temporary file, replacing what was there.
 * @param response - a successful response whose body is unread.
 * @param temporary - where to write; the caller moves it into place when this resolves.
 * @param maxBytes - the largest accepted body.
 * @param signal - cancels the download.
 * @returns the number of bytes written.
 */
export async function downloadTo(response: Response, temporary: string, maxBytes: number, signal?: AbortSignal): Promise<number> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new MediaError(`The generated file is ${(declared / 1048576).toFixed(1)} MiB, more than the ${(maxBytes / 1048576).toFixed(0)} MiB this plugin downloads.`, 'OUTPUT_TOO_LARGE')
  }
  await mkdir(dirname(temporary), { recursive: true })
  await rm(temporary, { force: true })
  if (response.body === null) {
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > maxBytes) throw new MediaError('The generated file is larger than this plugin downloads.', 'OUTPUT_TOO_LARGE')
    await writeFile(temporary, data)
    return data.byteLength
  }
  let total = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength
      if (total > maxBytes) callback(new MediaError('The generated file is larger than this plugin downloads.', 'OUTPUT_TOO_LARGE'))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), limit, createWriteStream(temporary),
      signal === undefined ? {} : { signal })
    return total
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
