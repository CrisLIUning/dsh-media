/**
 * Request limits the gateway adapter and its copied conversion modules read.
 * The values are `@deepseek-ai/dsh-llm-pi-ai`'s defaults, so a request through
 * the gateway is sized exactly as one through the pi-ai channel.
 *
 * @module dsh-vibedev/llm/limits
 */

/** Maximum base64-encoded image payload per request before the oldest images become placeholders. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Total-pixel budget that preserves the complete 2048px normalized attachment. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Raw encoded-byte target before inline base64 expansion. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** Maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Context capacity for a catalog model that does not state one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Output capability for a catalog model that does not state one. */
export const DEFAULT_MAX_TOKENS = 32_768
