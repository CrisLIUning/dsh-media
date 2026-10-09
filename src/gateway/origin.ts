/** Origin boundaries for accounts and durable media state. No endpoint fallback is defined here. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** The historical production gateway; unmarked pre-migration state belongs only here. */
export const DEFAULT_GATEWAY_ORIGIN = 'https://vibedev.jzsaas.com'
/** An explicit candidate, never the default or a retry destination. */
export const US_GATEWAY_ORIGIN = 'https://api.vibedev.studio'

/** Validate a bare HTTP(S) origin and canonicalize default ports, casing and trailing slash. */
export function normalizeGatewayOrigin(value: string): string {
  const url = new URL(value.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('gatewayOrigin must be a bare HTTP(S) origin, without credentials, path, query or fragment.')
  return url.origin
}

/** Stable, filesystem-safe identity; ports and schemes remain separate boundaries. */
export function gatewayId(origin: string): string {
  return createHash('sha256').update(normalizeGatewayOrigin(origin)).digest('hex')
}

/** Keep domestic legacy state in place; other gateways always get a separate empty namespace. */
export function gatewayStateDirectory(root: string, origin: string): string {
  return normalizeGatewayOrigin(origin) === DEFAULT_GATEWAY_ORIGIN ? root : join(root, 'gateways', gatewayId(origin))
}

/** The old shared development-key variable is domestic only. Desktop account mode disables it entirely. */
export function developmentKey(origin: string, name: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const key = name.trim()
  if (key === '' || key === 'VIBEDEV_GATEWAY_API_KEY' && normalizeGatewayOrigin(origin) !== DEFAULT_GATEWAY_ORIGIN) return undefined
  return env[key]?.trim() || undefined
}
