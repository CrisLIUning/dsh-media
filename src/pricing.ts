/**
 * Price estimates from the catalog's `media_pricing` (selling prices with the
 * account multiplier applied). The gateway estimates the same way at admission:
 * per-second video prices times billed seconds, where billed seconds are the
 * output length plus the summed reference video length, rounded up once.
 * Estimates are for the user's information; the gateway's receipt is the charge.
 * @module dsh-media/pricing
 */

import type { MediaModel, MediaPriceTier, MediaPricing } from './gateway/catalog.js'

/** One estimate. */
export interface Estimate {
  readonly amountCny: number
  /** How it was reached, such as `¥0.99/s × 5 s`. */
  readonly basis: string
}

/** Seconds the gateway bills when a request names no duration. */
const DEFAULT_BILLED_SECONDS = 8

/**
 * Format an amount in yuan.
 * @param amount - the amount.
 * @returns `¥4.95`.
 */
export function yuan(amount: number): string {
  return `¥${amount.toFixed(2)}`
}

function tierFor(pricing: MediaPricing, wanted: string | undefined): MediaPriceTier | { unit: 'generation' | 'second'; amount: number } | undefined {
  if (wanted !== undefined) {
    const match = pricing.tiers.find(tier => tier.tier.toLowerCase() === wanted.toLowerCase())
    if (match !== undefined) return match
  }
  if (pricing.default !== undefined) return pricing.default
  return pricing.tiers.length === 1 ? pricing.tiers[0] : undefined
}

/**
 * A one-line price for listings: `¥0.10 per image`, `¥0.99/s (720p)`.
 * @param model - the model.
 * @returns the price, or undefined when the catalog gives none.
 */
export function describePrice(model: MediaModel): string | undefined {
  const pricing = model.pricing
  if (pricing === undefined) return undefined
  const per = (unit: 'generation' | 'second') => unit === 'second' ? '/s' : model.kind === 'image' ? ' per image' : ' per generation'
  const parts = pricing.tiers.map(tier => `${yuan(tier.amount)}${per(tier.unit)} (${tier.tier})`)
  if (pricing.default !== undefined && (pricing.tiers.length === 0 || !pricing.tiers.some(tier => tier.amount === pricing.default?.amount && tier.unit === pricing.default.unit))) {
    parts.push(`${yuan(pricing.default.amount)}${per(pricing.default.unit)}${pricing.tiers.length === 0 ? '' : ' otherwise'}`)
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}

/**
 * Estimate an image request.
 * @param model - the image model.
 * @param count - images requested.
 * @returns the estimate, or undefined without a price.
 */
export function estimateImages(model: MediaModel, count: number): Estimate | undefined {
  const price = model.pricing === undefined ? undefined : tierFor(model.pricing, undefined)
  if (price === undefined) return undefined
  return { amountCny: price.amount * count, basis: count === 1 ? `${yuan(price.amount)} per image` : `${yuan(price.amount)} × ${count} images` }
}

/**
 * Estimate a video request.
 * @param model - the video model.
 * @param duration - the requested length in seconds, when given.
 * @param resolution - the requested resolution, when given.
 * @param referenceMs - the summed length of the reference videos.
 * @returns the estimate, or undefined without a price.
 */
export function estimateVideo(model: MediaModel, duration: number | undefined, resolution: string | undefined, referenceMs = 0): Estimate | undefined {
  if (model.pricing === undefined) return undefined
  const only = model.video?.resolutions?.length === 1 ? model.video.resolutions[0] : undefined
  const price = tierFor(model.pricing, resolution ?? only)
  if (price === undefined) return undefined
  if (price.unit === 'generation') return { amountCny: price.amount, basis: `${yuan(price.amount)} per video` }
  const output = duration ?? DEFAULT_BILLED_SECONDS
  const reference = Math.ceil(referenceMs / 1000)
  const seconds = output + reference
  return {
    amountCny: price.amount * seconds,
    basis: `${yuan(price.amount)}/s × ${reference === 0 ? `${output} s` : `(${output} s output + ${reference} s of reference video)`}`,
  }
}

/**
 * Estimate a music or podcast request.
 * @param model - the audio model.
 * @returns the estimate, or undefined without a price.
 */
export function estimateAudio(model: MediaModel): Estimate | undefined {
  const price = model.pricing === undefined ? undefined : tierFor(model.pricing, undefined)
  if (price === undefined || price.unit !== 'generation') return undefined
  return { amountCny: price.amount, basis: `${yuan(price.amount)} per request` }
}
