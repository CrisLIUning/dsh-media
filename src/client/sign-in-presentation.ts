/** Localized login outcomes and strictly selected support details, never server failure text. */
import type { SignInAttempt } from './account-store.ts'
import type { MediaSettingsKey } from './locales.ts'

/** @param attempt - latest safe Host snapshot. @returns a locale key for a terminal login failure. */
export function failureKey(attempt: SignInAttempt | undefined): MediaSettingsKey | undefined {
  if (attempt?.phase === 'expired') return 'signInExpired'
  if (attempt?.phase !== 'failed') return undefined
  const keys = {
    network: 'signInNetwork', timeout: 'signInTimeout', 'gateway-refused': 'signInRefused',
    'gateway-unavailable': 'signInUnavailable', protocol: 'signInProtocol', storage: 'signInStorage', callback: 'signInCallback',
  } as const
  return attempt.errorCode !== undefined && Object.hasOwn(keys, attempt.errorCode) ? keys[attempt.errorCode] : 'signInUnknown'
}

/** @param attempt - latest snapshot. @returns support reference without query, body, credentials or raw error. */
export function safeSupportDetails(attempt: SignInAttempt | undefined): string | undefined {
  if (attempt === undefined) return undefined
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(attempt.id) ? attempt.id : undefined
  let origin: string | undefined
  try {
    const url = new URL(attempt.gatewayOrigin)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) origin = url.origin
  } catch { /* invalid diagnostic origin is omitted */ }
  const stage = ['listen', 'device', 'redeem', 'persist'].includes(attempt.stage ?? '') ? attempt.stage : undefined
  const code = ['network', 'timeout', 'gateway-refused', 'gateway-unavailable', 'protocol', 'storage', 'callback']
    .includes(attempt.errorCode ?? '') ? attempt.errorCode : undefined
  const status = Number.isInteger(attempt.httpStatus) && Number(attempt.httpStatus) >= 100 && Number(attempt.httpStatus) <= 599
    ? `HTTP ${attempt.httpStatus}` : undefined
  const network = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']
    .includes(attempt.networkCode ?? '') ? attempt.networkCode : undefined
  return [code, stage, status, network, origin, id].filter(value => value !== undefined).join(' · ')
}
