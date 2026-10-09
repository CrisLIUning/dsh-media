/** Safe host diagnostics: deliberately separate from authorization URLs and grants. */
export interface SignInAttempt {
  readonly id: string
  readonly phase: 'preparing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  readonly expiresAt: number
  readonly gatewayOrigin: string
  readonly stage?: 'listen' | 'device' | 'redeem' | 'persist'
  readonly errorCode?: 'network' | 'timeout' | 'gateway-refused' | 'gateway-unavailable' | 'protocol' | 'storage' | 'callback'
  readonly httpStatus?: number
  readonly networkCode?: string
}

export const REDEEM_PATH = '/api/v1/vibedev/link/redeem'
export type SignInFailure = Pick<SignInAttempt, 'errorCode' | 'httpStatus' | 'networkCode'>

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** Read only fixed transport codes, never error text, stack, body or arbitrary fields. */
export function transportFailure(error: unknown): SignInFailure {
  let cause = error
  let timeout = false
  let networkCode: string | undefined
  // Causes can be cyclic, or contain arbitrary application data.
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth++) {
    const value = cause as Record<string, unknown>
    if (value.name === 'TimeoutError') timeout = true
    if (typeof value.code === 'string' && NETWORK_CODES.has(value.code)) {
      networkCode ??= value.code
      if (TIMEOUT_CODES.has(value.code)) timeout = true
    }
    cause = value.cause
  }
  return { errorCode: timeout ? 'timeout' : 'network', ...networkCode === undefined ? {} : { networkCode } }
}

const EXPLANATIONS: Record<NonNullable<SignInAttempt['errorCode']>, readonly [string, string]> = {
  network: ['无法连接登录网关，请检查网络后重新登录。', 'The sign-in gateway could not be reached. Check the connection and start sign-in again.'],
  timeout: ['登录等待或网关请求已超时，请重新登录。', 'Sign-in or the gateway request timed out. Start sign-in again.'],
  'gateway-refused': ['登录网关拒绝了请求，请重新登录。', 'The gateway refused the sign-in request. Start sign-in again.'],
  'gateway-unavailable': ['登录网关暂时不可用，请稍后重新登录。', 'The sign-in gateway is temporarily unavailable. Start sign-in again later.'],
  protocol: ['登录网关返回了无效的凭据格式，请稍后重新登录。', 'The gateway returned an invalid credential response. Start sign-in again later.'],
  storage: ['无法准备或保存本地登录凭据，请检查存储权限后重新登录。', 'Local sign-in credentials could not be prepared or saved. Check storage permissions and start sign-in again.'],
  callback: ['无法启动或使用本地登录回调，请重新登录。', 'The local sign-in callback could not be started or used. Start sign-in again.'],
}
const STAGES: Record<NonNullable<SignInAttempt['stage']>, readonly [string, string]> = {
  listen: ['本地回调监听', 'Local callback listener'],
  device: ['准备本地设备标识', 'Preparing the local device identity'],
  redeem: ['交换登录凭据', 'Exchanging sign-in credentials'],
  persist: ['保存本地凭据', 'Saving local credentials'],
}

/** A fixed bilingual explanation suitable for exposed rejection messages. */
export function failureMessage(attempt: Pick<SignInAttempt, 'errorCode' | 'stage' | 'httpStatus'>): string {
  const [chinese, english] = EXPLANATIONS[attempt.errorCode ?? 'callback']
  const stage = attempt.stage === undefined ? '' : ` ${STAGES[attempt.stage].join(' / ')}; stage=${attempt.stage}.`
  const status = attempt.httpStatus === undefined ? '' : ` HTTP ${attempt.httpStatus}.`
  return `${english} ${chinese} errorCode=${attempt.errorCode ?? 'callback'}.${stage}${status}`
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)

/** Only our fixed explanation and escaped safe enum/status fields reach the browser. */
export function failurePage(attempt: SignInAttempt): string {
  return `<h1>Sign-in failed.</h1><p>${escapeHtml(failureMessage(attempt))}</p><p>请回到对话重新登录。</p>`
}

/** Explicit log allowlist; adding fields to the public attempt never expands log output. */
export function attemptLog(event: 'request' | 'phase' | 'response' | 'terminal', attempt: SignInAttempt): string {
  return `dsh-vibedev sign-in ${JSON.stringify({
    event, id: attempt.id, phase: attempt.phase, gatewayOrigin: attempt.gatewayOrigin, path: REDEEM_PATH,
    ...attempt.stage === undefined ? {} : { stage: attempt.stage },
    ...attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode },
    ...attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus },
    ...attempt.networkCode === undefined ? {} : { networkCode: attempt.networkCode },
  })}`
}
