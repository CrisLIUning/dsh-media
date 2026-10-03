/**
 * dsh-media: image, video, music, podcast and speech-to-text generation for
 * DeepSeek Harness through the VibeDev gateway.
 *
 * The agent calls the tools on its own judgment; results are saved in the
 * workspace under `media/`. Requests are paid from the user's VibeDev balance:
 * inside the VibeDev app the app's signed-in account is used; elsewhere the
 * plugin signs in to VibeDev itself (`media_account`).
 *
 * ```yaml
 * - insert:
 *     - id: dsh-media
 *       name: dsh-media
 * ```
 * @module dsh-media
 */

import { readFileSync } from 'node:fs'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import Schema from '@deepseek-ai/schemastery'
import { CredentialChain, grantStorage } from './auth/credentials.js'
import { PluginLogin } from './auth/login.js'
import { MediaLibrary } from './gateway/assets.js'
import { GatewayHttp } from './gateway/http.js'
import { MediaRuntime } from './runtime.js'
import type { ModelSlot } from './runtime.js'
import { TaskStore } from './tasks/store.js'
import { TaskTracker } from './tasks/tracker.js'
import { mediaAccountTool } from './tools/account.js'
import { audioGenerateTool } from './tools/audio.js'
import { imageGenerateTool } from './tools/image.js'
import { mediaModelsTool } from './tools/models.js'
import { mediaTasksTool } from './tools/tasks.js'
import { audioTranscribeTool } from './tools/transcribe.js'
import { videoGenerateTool } from './tools/video.js'
import { stateDirectory } from './util/files.js'

export { MediaError } from './gateway/errors.js'
export { parseMediaCatalog } from './gateway/catalog.js'
export type { MediaModel, VideoCapabilities, VideoMode } from './gateway/catalog.js'

/** The package version, sent in the `User-Agent` the gateway attributes plugin traffic by. */
export const version: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export const name = 'dsh-media'
export const inject = ['tools']

export interface Config {
  /** Ask the user before each paid request. */
  confirmSpending: Volatile<boolean>
  /** Output folder, relative to the workspace (or absolute). */
  outputDir: Volatile<string>
  /** Pinned models; empty lets the agent choose from the catalog. */
  imageModel: Volatile<string>
  videoModel: Volatile<string>
  musicModel: Volatile<string>
  podcastModel: Volatile<string>
  transcriptionModel: Volatile<string>
  /** Gateway origin. */
  gatewayOrigin: string
  /** Environment variable holding a development key, used only while nobody is signed in. */
  apiKeyEnv: string
  /** Where tasks and the plugin's own sign-in are kept; empty for `<harness home>/dsh-media`. */
  stateDir: string
}

export const Config = Schema.object({
  confirmSpending: Schema.boolean().default(false).volatile(),
  outputDir: Schema.string().default('media').volatile(),
  imageModel: Schema.string().default('').volatile(),
  videoModel: Schema.string().default('').volatile(),
  musicModel: Schema.string().default('').volatile(),
  podcastModel: Schema.string().default('').volatile(),
  transcriptionModel: Schema.string().default('').volatile(),
  gatewayOrigin: Schema.string().default('https://vibedev.jzsaas.com'),
  apiKeyEnv: Schema.string().default('VIBEDEV_GATEWAY_API_KEY'),
  stateDir: Schema.string().default(''),
}).i18n({
  'zh-CN': {
    confirmSpending: '每次付费生成前先询问（默认关闭）',
    outputDir: '保存目录（相对于工作区）',
    imageModel: '默认生图模型（留空由 Agent 按目录选择）',
    videoModel: '默认视频模型（留空由 Agent 按目录选择）',
    musicModel: '默认音乐模型（留空自动选择）',
    podcastModel: '默认播客模型（留空自动选择）',
    transcriptionModel: '默认语音转写模型（留空自动选择）',
    gatewayOrigin: 'VibeDev 网关地址',
    apiKeyEnv: '开发用密钥所在的环境变量（仅在未登录时使用）',
    stateDir: '插件数据目录（留空为默认）',
  },
  'en-US': {
    confirmSpending: 'Ask before each paid generation (off by default)',
    outputDir: 'Output folder (relative to the workspace)',
    imageModel: 'Default image model (empty: the agent chooses from the catalog)',
    videoModel: 'Default video model (empty: the agent chooses from the catalog)',
    musicModel: 'Default music model (empty: chosen automatically)',
    podcastModel: 'Default podcast model (empty: chosen automatically)',
    transcriptionModel: 'Default transcription model (empty: chosen automatically)',
    gatewayOrigin: 'VibeDev gateway address',
    apiKeyEnv: 'Environment variable with a development key (used only while signed out)',
    stateDir: 'Plugin data folder (empty for the default)',
  },
})

const GUIDANCE = 'VibeDev media tools: image_generate, video_generate, audio_generate (music or a podcast) and audio_transcribe create and transcribe media '
  + 'with the user\'s VibeDev account; media_models lists models and prices. Use them on your own judgment whenever generated media serves the request '
  + '(illustrations, product shots, storyboard frames, short clips, background music, a podcast episode), not only when a tool is named. '
  + 'They spend the user\'s balance, so make what the request needs rather than speculative variations. Results are saved in the workspace under media/. '
  + 'Pass files the user attached in this chat as chat:1 (the most recent), chat:2, and so on. Video and audio run as background jobs: '
  + 'carry on and let the job notification report the result.'

export function apply(ctx: Context, config: Config): void {
  const origin = config.gatewayOrigin.trim().replace(/\/+$/, '')
  const stateDir = stateDirectory(config.stateDir)
  const userAgent = `vibedev-plugin/${version}`
  const warn = (message: string): void => { ctx.logger.warn(message) }

  const login = new PluginLogin({
    origin, userAgent, log: warn,
    storage: grantStorage(stateDir, () => ctx.get('credentials')),
  })
  const chain = new CredentialChain({
    origin, plugin: login,
    account: () => ctx.get('deepseekAccount'),
    apiKey: () => config.apiKeyEnv.trim() === '' ? undefined : process.env[config.apiKeyEnv.trim()]?.trim(),
  })
  const http = new GatewayHttp({
    origin, userAgent,
    resolveCredential: () => chain.resolve(),
    rejectToken: credential => chain.reject(credential),
  })
  const store = new TaskStore(stateDir)
  const tracker = new TaskTracker({ http, store, log: warn })
  const slots: Readonly<Record<ModelSlot, Volatile<string>>> = {
    image: config.imageModel, video: config.videoModel, music: config.musicModel,
    podcast: config.podcastModel, transcription: config.transcriptionModel,
  }
  const runtime = new MediaRuntime({
    http, store, tracker, stateDir,
    library: new MediaLibrary(http),
    settings: {
      outputDir: () => config.outputDir.get(),
      confirmSpending: () => config.confirmSpending.get(),
      defaultModel: slot => slots[slot].get(),
    },
    fs: () => ctx.get('fs'),
    attachments: () => ctx.get('attachments'),
    approval: () => ctx.get('approval'),
    jobs: () => ctx.get('jobs'),
    log: warn,
  })

  for (const tool of [
    mediaModelsTool(runtime), imageGenerateTool(runtime), videoGenerateTool(runtime), audioGenerateTool(runtime),
    audioTranscribeTool(runtime), mediaTasksTool(runtime), mediaAccountTool(runtime, chain, login),
  ]) ctx.tools.register(tool)

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    prompt.section({ name: 'tool:dsh-media', order: prompt.getSectionOrder('TOOL_COMPUTER_USE') + 50, text: GUIDANCE, interpolate: false })
  }

  ctx.effect(() => {
    void tracker.resume().catch((error: unknown) => { warn(`dsh-media: resuming tasks failed: ${String(error)}`) })
    const unsubscribe = login.onChange(() => { runtime.invalidateCatalog() })
    return () => {
      unsubscribe()
      tracker.dispose()
      login.dispose()
    }
  }, 'dsh-media: tasks and sign-in')

  // Which models the credential may call changes with a sign-in, sign-out or account switch.
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    accountCtx.effect(() => {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const _view of accountCtx.deepseekAccount.watch(controller.signal)) runtime.invalidateCatalog()
        } catch {
          // The watch ends with the account service; nothing to recover.
        }
      })()
      return () => { controller.abort() }
    }, 'dsh-media: account watch')
  })
}
