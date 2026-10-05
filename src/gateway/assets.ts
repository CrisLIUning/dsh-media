/**
 * The gateway media library (`/v1/media-assets`): every reference a video
 * request carries is uploaded here first, so the gateway can check its type and
 * measure its length, and the provider fetches it from the gateway instead of
 * an arbitrary link.
 *
 * Flow: `POST /uploads` (deduplicated by content digest), `PUT upload_url` with
 * the returned upload headers when an upload is needed, `POST /{id}/complete`.
 * An asset the library already holds is read back through `/refresh`, which
 * also carries its measured duration.
 * @module dsh-vibedev/gateway/assets
 */

import { createHash } from 'node:crypto'
import { MediaError } from './errors.js'
import type { GatewayHttp } from './http.js'
import type { LoadedMedia } from '../media/sources.js'

/** A media library asset a request can reference. */
export interface UploadedAsset {
  readonly assetId: string
  /** The URL to put in a generation request. */
  readonly referenceUrl: string
  readonly contentUrl?: string
  readonly contentType: string
  readonly expiresAt?: string
  /** Measured length of an audio or video, in milliseconds. */
  readonly durationMs?: number
  readonly sha256: string
  readonly bytes: number
}

/** Purposes the plugin uploads under. */
export type AssetPurpose = 'video_reference'

/** How long before expiry a cached asset is refreshed instead of reused. */
const EXPIRY_MARGIN_MS = 10 * 60_000

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const httpUrl = (value: unknown): string | undefined => {
  const url = text(value)
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}

/**
 * Read an asset answer from `uploads`, `complete` or `refresh`.
 * @param body - the parsed answer.
 * @param fallbackType - the type the upload declared.
 * @returns the asset facts, or undefined when the answer names no usable URL.
 */
export function parseAsset(body: unknown, fallbackType: string): Omit<UploadedAsset, 'sha256' | 'bytes'> | undefined {
  const raw = record(body)
  const assetId = text(raw?.asset_id)
  // Only the reference URL goes into a generation request; the content link is for downloads.
  const referenceUrl = httpUrl(raw?.reference_url)
  if (raw === undefined || assetId === undefined || referenceUrl === undefined) return undefined
  const contentUrl = httpUrl(raw.content_url)
  const expiresAt = text(raw.expires_at)
  const duration = raw.duration_ms
  return {
    assetId, referenceUrl,
    contentType: text(raw.content_type) ?? fallbackType,
    ...contentUrl === undefined ? {} : { contentUrl },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {},
  }
}

/** Uploads references and remembers them for the life of the plugin. */
export class MediaLibrary {
  private readonly cache = new Map<string, UploadedAsset>()

  /**
   * @param http - the gateway client.
   * @param now - clock, for expiry checks.
   */
  constructor(private readonly http: GatewayHttp, private readonly now: () => number = Date.now) {}

  /** Forget every remembered asset, as after an account change: assets belong to the account that uploaded them. */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Upload one loaded input, or reuse the asset the library already holds.
   * @param media - the loaded input.
   * @param purpose - the asset purpose.
   * @param signal - cancels the upload.
   * @returns the asset.
   */
  async upload(media: LoadedMedia, purpose: AssetPurpose, signal?: AbortSignal): Promise<UploadedAsset> {
    const sha256 = createHash('sha256').update(media.data).digest('hex')
    const key = `${purpose}:${sha256}`
    const cached = this.cache.get(key)
    if (cached !== undefined && !this.expiring(cached)) return cached
    if (cached !== undefined) {
      const refreshed = await this.refresh(cached, signal).catch(() => undefined)
      if (refreshed !== undefined) return this.remember(key, refreshed)
    }
    const created = record(await this.http.json('/v1/media-assets/uploads', {
      method: 'POST',
      json: { filename: media.name, content_type: media.mime, size_bytes: media.data.byteLength, sha256, purpose },
      ...signal === undefined ? {} : { signal },
    }))
    const assetId = text(created?.asset_id)
    if (created === undefined || assetId === undefined) {
      throw new MediaError(`The VibeDev gateway did not accept the upload of "${media.source}".`, 'ASSET_UPLOAD_REFUSED')
    }
    if (created.upload_required === false) {
      // Already in the library: read it back, which also carries the measured duration.
      const known = parseAsset(created, media.mime)
      const facts = await this.read(assetId, 'refresh', media.mime, signal).catch(() => undefined) ?? known
      if (facts === undefined) throw new MediaError(`The VibeDev gateway returned no address for "${media.source}".`, 'ASSET_REFERENCE_MISSING')
      return this.remember(key, { ...facts, sha256, bytes: media.data.byteLength })
    }
    const uploadUrl = httpUrl(created.upload_url) ?? (text(created.upload_url)?.startsWith('/') === true ? this.http.url(text(created.upload_url) as string) : undefined)
    if (uploadUrl === undefined) throw new MediaError(`The VibeDev gateway returned no upload address for "${media.source}".`, 'ASSET_UPLOAD_URL_MISSING')
    const headers: Record<string, string> = { 'content-type': media.mime }
    for (const [name, value] of Object.entries(record(created.upload_headers) ?? {})) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }
    await this.http.send(uploadUrl, {
      method: 'PUT', body: media.data, headers, anonymous: true, timeoutMs: 10 * 60_000, busyRetries: 1,
      ...signal === undefined ? {} : { signal },
    })
    const completed = await this.read(assetId, 'complete', media.mime, signal)
    if (completed === undefined) throw new MediaError(`The VibeDev gateway returned no address for "${media.source}" after the upload.`, 'ASSET_REFERENCE_MISSING')
    return this.remember(key, { ...completed, sha256, bytes: media.data.byteLength })
  }

  private expiring(asset: UploadedAsset): boolean {
    if (asset.expiresAt === undefined) return false
    const at = Date.parse(asset.expiresAt)
    return Number.isFinite(at) && at - this.now() < EXPIRY_MARGIN_MS
  }

  private remember(key: string, asset: UploadedAsset): UploadedAsset {
    this.cache.set(key, asset)
    return asset
  }

  private async refresh(asset: UploadedAsset, signal?: AbortSignal): Promise<UploadedAsset | undefined> {
    const facts = await this.read(asset.assetId, 'refresh', asset.contentType, signal)
    return facts === undefined ? undefined : { ...facts, sha256: asset.sha256, bytes: asset.bytes }
  }

  private async read(assetId: string, operation: 'complete' | 'refresh', fallbackType: string, signal?: AbortSignal) {
    const body = await this.http.json(`/v1/media-assets/${encodeURIComponent(assetId)}/${operation}`, {
      method: 'POST',
      ...signal === undefined ? {} : { signal },
    })
    return parseAsset(body, fallbackType)
  }
}
