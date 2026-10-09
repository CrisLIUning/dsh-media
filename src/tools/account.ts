/**
 * `media_account`: which VibeDev account the VibeDev models and media requests
 * use, and the plugin's own sign-in for hosts without a VibeDev account
 * (official DeepSeek Harness). People can also sign in from the sidebar or
 * Settings → VibeDev 账号; this is the agent's way to the same sign-in.
 * @module dsh-vibedev/tools/account
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CredentialChain } from '../auth/credentials.js'
import type { PluginLogin } from '../auth/login.js'
import type { MediaRuntime } from '../runtime.js'

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @param chain - the credential chain.
 * @param login - the plugin's own sign-in.
 * @returns the tool definition.
 */
export function mediaAccountTool(runtime: MediaRuntime, chain: CredentialChain, login: PluginLogin): ToolDefinition {
  return defineTool({
    name: 'media_account',
    description: 'Check or set up the VibeDev account that pays for the VibeDev models and media generation. status: which account is in use. '
      + 'sign_in: open the VibeDev sign-in page in the user\'s browser (new users can register there); it finishes in the background, '
      + 'then retry the request. Use sign_in when a media tool reports NOT_SIGNED_IN or a VibeDev model asks for a sign-in; the user can also '
      + 'sign in from the sidebar ("登录 VibeDev") or Settings → VibeDev 账号. sign_out: end this plugin\'s VibeDev sign-in.',
    parameters: {
      action: { type: 'string', enum: ['status', 'sign_in', 'sign_out'], required: true, description: 'What to do.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          signInUrl: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const credential = await chain.resolve()
      const source = credential?.kind ?? 'none'
      const user = await login.user()
      const who = user?.email ?? user?.nickname
      if (args.action === 'status') {
        const pending = login.pendingSignIn()
        const message = source === 'account'
          ? 'VibeDev models and media requests use the VibeDev account signed in to this app.'
          : source === 'plugin'
            ? `VibeDev models and media requests use this plugin's VibeDev sign-in${who === undefined ? '' : ` (${who})`}.`
            : source === 'key'
              ? 'VibeDev requests use a development key from the environment.'
              : `Nobody is signed in to VibeDev${pending === undefined ? '' : `; a sign-in is waiting in the browser: ${pending.url}`}. Use action sign_in.`
        return { source, message, ...pending === undefined ? {} : { signInUrl: pending.url } }
      }
      if (args.action === 'sign_out') {
        if (source === 'account') {
          return { source, message: 'This plugin uses the VibeDev account signed in to this app; sign out from the app\'s account settings instead.' }
        }
        await login.signOut()
        runtime.invalidateCatalog()
        return { source: 'none', message: who === undefined ? 'Signed out of VibeDev.' : `Signed out ${who} from VibeDev.` }
      }
      if (source === 'account') return { source, message: 'Already signed in: VibeDev requests use the VibeDev account signed in to this app.' }
      if (source === 'plugin') return { source, message: `Already signed in to VibeDev${who === undefined ? '' : ` as ${who}`}.` }
      const started = await login.startSignIn()
      started.done.then(() => runtime.invalidateCatalog(), () => undefined)
      const minutes = Math.max(1, Math.round((started.expiresAt - runtime.now()) / 60_000))
      return {
        source, signInUrl: started.url,
        message: `${started.opened ? 'Opened the VibeDev sign-in page in the user\'s browser.' : 'Could not open a browser.'} `
          + `If it did not appear, give the user this link: ${started.url} — `
          + `new users can register on that page (or at ${runtime.http.origin}). The sign-in completes in the background within ${minutes} minutes; `
          + 'once the user says they are done, retry the request.',
      }
    },
  })
}
