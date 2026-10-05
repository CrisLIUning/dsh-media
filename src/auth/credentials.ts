/**
 * Which VibeDev credential a gateway request carries, in order: the host's
 * signed-in VibeDev account (the VibeDev app's account service hands out its
 * token for the gateway origin), the plugin's own sign-in, then a development
 * key named by an environment variable.
 * @module dsh-vibedev/auth/credentials
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { GatewayCredential } from '../gateway/http.js'
import { writeFileAtomic } from '../util/files.js'
import type { GrantChange, GrantStorage, PluginGrant, PluginLogin } from './login.js'

/** Where a credential came from, for status lines. */
export type CredentialSource = GatewayCredential['kind']

/** Construction options. */
export interface CredentialChainOptions {
  /** Gateway origin; the host account is asked for a token for this origin. */
  readonly origin: string
  /** The host's account service, when one is loaded. */
  readonly account: () => DeepSeekAccount | undefined
  readonly plugin?: PluginLogin
  /** The development key, when configured. */
  readonly apiKey: () => string | undefined
}

/** Resolves the credential for each request and routes rejections back to its owner. */
export class CredentialChain {
  /**
   * @param options - origin and the three sources.
   */
  constructor(private readonly options: CredentialChainOptions) {}

  /** The credential for the next request, or undefined while nobody is signed in. */
  async resolve(): Promise<GatewayCredential | undefined> {
    const account = this.options.account()
    const hosted = await account?.resolveToken(`${this.options.origin.replace(/\/+$/, '')}/v1/models`).catch(() => undefined)
    if (hosted !== undefined && hosted !== '') return { token: hosted, kind: 'account' }
    const own = await this.options.plugin?.token()
    if (own !== undefined) return { token: own, kind: 'plugin' }
    const key = this.options.apiKey()
    return key === undefined || key === '' ? undefined : { token: key, kind: 'key' }
  }

  /**
   * The gateway rejected a credential: let its owner refresh it.
   * @param credential - the rejected credential.
   */
  async reject(credential: GatewayCredential): Promise<void> {
    if (credential.kind === 'account') await this.options.account()?.rejectToken(credential.token)
    else if (credential.kind === 'plugin') await this.options.plugin?.reject(credential.token)
  }
}

// Named after the plugin's former name, dsh-media: keeping the key lets an upgrade keep the sign-in.
const GRANT_KEY = credentialKey('dsh-media', 'vibedev-session')

function isGrant(value: unknown): value is PluginGrant {
  const grant = value as PluginGrant | undefined
  return typeof grant === 'object' && grant !== null && typeof grant.accessToken === 'string' && typeof grant.refreshToken === 'string'
    && typeof grant.expiresAt === 'number' && typeof grant.refreshExpiresAt === 'number'
}

/**
 * Grant storage: the host's credential store when one is loaded (a grant
 * record the store keeps verbatim), else a private file in the state
 * directory. The device id is not a secret and lives in the state directory.
 * @param stateDir - the plugin state directory.
 * @param credentials - the host's credential store, when loaded.
 * @returns the storage.
 */
export function grantStorage(stateDir: string, credentials: () => CredentialProvider | undefined): GrantStorage {
  const sessionFile = join(stateDir, 'session.json')
  const deviceFile = join(stateDir, 'device.json')
  let device: Promise<string> | undefined
  const readFileGrant = async (): Promise<PluginGrant | undefined> => {
    const parsed: unknown = await readFile(sessionFile, 'utf8').then(text => JSON.parse(text) as unknown, () => undefined)
    return isGrant(parsed) ? parsed : undefined
  }
  // Owner-only from creation: the temporary file is written with this mode before the rename.
  const writeFileGrant = (grant: PluginGrant | undefined) =>
    writeFileAtomic(sessionFile, new TextEncoder().encode(grant === undefined ? 'null' : JSON.stringify(grant)), { mode: 0o600 })
  return {
    async read() {
      const store = credentials()
      if (store !== undefined) {
        const stored = await store.readRecord(GRANT_KEY)
        return stored?.kind === 'grant' && isGrant(stored.payload) ? stored.payload : undefined
      }
      return readFileGrant()
    },
    async write(grant) {
      const store = credentials()
      if (store !== undefined) {
        if (grant === undefined) await store.deleteRecord(GRANT_KEY)
        else await store.modifyRecord(GRANT_KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
        return
      }
      await writeFileGrant(grant)
    },
    async update(change: (current: PluginGrant | undefined) => Promise<GrantChange>) {
      const store = credentials()
      if (store !== undefined) {
        // The credential store serializes this read-modify-write across processes.
        let remove = false
        await store.modifyRecord(GRANT_KEY, async (current) => {
          const result = await change(current?.kind === 'grant' && isGrant(current.payload) ? current.payload : undefined)
          if (result.kind === 'set') return { kind: 'grant', payload: result.grant }
          remove = result.kind === 'delete'
          return undefined
        })
        if (remove) await store.deleteRecord(GRANT_KEY)
        return
      }
      // The file fallback has no cross-process lock; reading right before the change narrows the window.
      const result = await change(await readFileGrant())
      if (result.kind === 'set') await writeFileGrant(result.grant)
      else if (result.kind === 'delete') await writeFileGrant(undefined)
    },
    deviceId() {
      device ??= readFile(deviceFile, 'utf8').then((text) => {
        const id = (JSON.parse(text) as { id?: unknown }).id
        if (typeof id === 'string' && /^[\w-]{8,128}$/.test(id)) return id
        throw new Error('unreadable device id')
      }).catch(async () => {
        const id = randomUUID()
        await writeFileAtomic(deviceFile, new TextEncoder().encode(JSON.stringify({ id })))
        return id
      })
      return device
    },
  }
}
