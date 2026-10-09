/** Origin boundaries for accounts and durable media state. No endpoint fallback is defined here. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Production API origin. Storage URLs are returned by the server, not derived from this address. */
export const DEFAULT_GATEWAY_ORIGIN = 'https://api.vibedev.studio'

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

/** Every gateway uses its own namespace; never read the unmarked historical root. */
export function gatewayStateDirectory(root: string, origin: string): string {
  return join(root, 'gateways', gatewayId(origin))
}

/** Ignore the old shared key variable; development requires an explicitly named, gateway-specific variable. */
export function developmentKey(origin: string, name: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  normalizeGatewayOrigin(origin)
  const key = name.trim()
  if (key === '' || key === 'VIBEDEV_GATEWAY_API_KEY') return undefined
  return env[key]?.trim() || undefined
}
