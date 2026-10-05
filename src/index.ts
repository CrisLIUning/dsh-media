/**
 * dsh-vibedev (formerly dsh-media): the VibeDev account and the VibeDev
 * gateway for DeepSeek Harness — its chat models in the model pickers on their
 * own route (`vibedev-gateway`), next to the DeepSeek account's, and image,
 * video, music, podcast and speech-to-text tools for the agent.
 *
 * Everything is paid from the user's VibeDev balance: inside the VibeDev app
 * the app's signed-in account is used; elsewhere the plugin signs in to
 * VibeDev itself (the sidebar's "登录 VibeDev", Settings → VibeDev 账号, or the
 * `media_account` tool). The DeepSeek account stays the Harness's own.
 *
 * Kept from dsh-media so an upgrade carries over: the sign-in record
 * (`dsh-media/vibedev-session`), the data folder (`<harness home>/dsh-media`),
 * the `vibedevMedia` host service and the media tool names.
 *
 * ```yaml
 * - insert:
 *     - id: dsh-vibedev
 *       name: '@vibedev-si/dsh-vibedev'
 * ```
 * @module dsh-vibedev
 */

import { readFileSync } from 'node:fs'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-web'
import Schema from '@deepseek-ai/schemastery'
import { AccountService, accountRoutes } from './account/index.js'
import { CredentialChain, grantStorage } from './auth/credentials.js'
import { PluginLogin, openInBrowser } from './auth/login.js'
import { installGatewayModels } from './llm/index.js'
import type { GatewayModels } from './llm/index.js'
import { MediaLibrary } from './gateway/assets.js'
import { GatewayHttp } from './gateway/http.js'
import { MediaRuntime } from './runtime.js'
import { GatewaySearchProvider } from './search/provider.js'
import { MediaHostService } from './service.js'
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
export { MediaHostService } from './service.js'
export type { HostTarget, MediaTaskView } from './service.js'
export type { ImageRequest } from './tools/image.js'
export type { VideoRequest } from './tools/video.js'
export { parseMediaCatalog } from './gateway/catalog.js'
export type { MediaModel, VideoCapabilities, VideoMode } from './gateway/catalog.js'
export { ACCOUNT_ROUTE_PREFIX, AccountService } from './account/index.js'
export type { AccountSource, AccountView } from './account/index.js'
export { GATEWAY_SEARCH_PROVIDER_ID as SEARCH_PROVIDER_ID } from './search/provider.js'
export { INSUFFICIENT_BALANCE_CODE, SIGN_IN_REQUIRED_CODE, VIBEDEV_ROUTE } from './llm/index.js'

/** The package version, sent in the `User-Agent` the gateway attributes plugin traffic by. */
export const version: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export const name = 'dsh-vibedev'
export const inject = ['tools']

export interface Config {
  /** Name the model pickers and the Models page show for the VibeDev models. */
  displayName: string
  /** VibeDev chat models listed first, in this order, when the catalog offers them. */
  preferredModels: string[]
  /** Open the system browser when a sign-in starts (off: the page opens the link itself). */
  openBrowserOnSignIn: boolean
  /** Minutes between catalog reads while the app runs. */
  catalogRefreshMinutes: number
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
  /** Client name sent with the sign-in (`vibedev-plugin` in DeepSeek Harness; the VibeDev app sets its own). */
  client: string
  /** Environment variable holding a development key, used only while nobody is signed in. */
  apiKeyEnv: string
  /** Where tasks and the plugin's own sign-in are kept; empty for `<harness home>/dsh-media`. */
  stateDir: string
}

export const Config = Schema.object({
  displayName: Schema.string().default('VibeDev'),
  preferredModels: Schema.array(Schema.string()).default([]),
  openBrowserOnSignIn: Schema.boolean().default(true),
  catalogRefreshMinutes: Schema.number().min(1).max(1440).default(30),
  confirmSpending: Schema.boolean().default(false).volatile(),
  outputDir: Schema.string().default('media').volatile(),
  imageModel: Schema.string().default('').volatile(),
  videoModel: Schema.string().default('').volatile(),
  musicModel: Schema.string().default('').volatile(),
  podcastModel: Schema.string().default('').volatile(),
  transcriptionModel: Schema.string().default('').volatile(),
  gatewayOrigin: Schema.string().default('https://vibedev.jzsaas.com'),
  client: Schema.string().default('vibedev-plugin'),
  apiKeyEnv: Schema.string().default('VIBEDEV_GATEWAY_API_KEY'),
  stateDir: Schema.string().default(''),
}).i18n({
  'zh-CN': {
    displayName: '模型选择器里显示的名称',
    preferredModels: '排在最前的 VibeDev 模型（按顺序，留空按网关顺序）',
    openBrowserOnSignIn: '登录时自动打开系统浏览器',
    catalogRefreshMinutes: '模型目录刷新间隔（分钟）',
    confirmSpending: '每次付费生成前先询问（默认关闭）',
    outputDir: '保存目录（相对于工作区）',
    imageModel: '默认生图模型（留空由 Agent 按目录选择）',
    videoModel: '默认视频模型（留空由 Agent 按目录选择）',
    musicModel: '默认音乐模型（留空自动选择）',
    podcastModel: '默认播客模型（留空自动选择）',
    transcriptionModel: '默认语音转写模型（留空自动选择）',
    gatewayOrigin: 'VibeDev 网关地址',
    client: '登录时报给网关的客户端名称（决定用量记在哪个密钥下）',
    apiKeyEnv: '开发用密钥所在的环境变量（仅在未登录时使用）',
    stateDir: '插件数据目录（留空为默认）',
  },
  'en-US': {
    displayName: 'Name the model pickers show',
    preferredModels: 'VibeDev models listed first, in this order (empty: the gateway\'s order)',
    openBrowserOnSignIn: 'Open the system browser when signing in',
    catalogRefreshMinutes: 'Model catalog refresh interval (minutes)',
    confirmSpending: 'Ask before each paid generation (off by default)',
    outputDir: 'Output folder (relative to the workspace)',
    imageModel: 'Default image model (empty: the agent chooses from the catalog)',
    videoModel: 'Default video model (empty: the agent chooses from the catalog)',
    musicModel: 'Default music model (empty: chosen automatically)',
    podcastModel: 'Default podcast model (empty: chosen automatically)',
    transcriptionModel: 'Default transcription model (empty: chosen automatically)',
    gatewayOrigin: 'VibeDev gateway address',
    client: 'Client name reported to the gateway at sign-in (decides which key the usage is recorded under)',
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

  const storage = grantStorage(stateDir, () => ctx.get('credentials'))
  const login = new PluginLogin({
    origin, userAgent, log: warn, storage, client: config.client.trim() || 'vibedev-plugin',
    openBrowser: url => config.openBrowserOnSignIn ? openInBrowser(url) : Promise.resolve(false),
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

  // Other plugins (the film workbench) generate through the same runtime.
  ctx.effect(() => ctx.provide('vibedevMedia', new MediaHostService(runtime, version)), 'dsh-vibedev: media host service')

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    prompt.section({ name: 'tool:dsh-vibedev', order: prompt.getSectionOrder('TOOL_COMPUTER_USE') + 50, text: GUIDANCE, interpolate: false })
  }

  // The VibeDev chat models in the model pickers, next to the DeepSeek account's.
  let route: GatewayModels | undefined
  ctx.inject(['llm'], (llmCtx) => {
    route = installGatewayModels(llmCtx, {
      origin,
      displayName: config.displayName,
      resolveCredential: () => chain.resolve(),
      rejectCredential: credential => chain.reject(credential),
      deviceId: () => storage.deviceId(),
      preferredModels: () => config.preferredModels,
      onCredentialChange: listener => login.onChange(listener),
      catalogRefreshMinutes: config.catalogRefreshMinutes,
    })
    llmCtx.effect(() => () => { route = undefined }, 'dsh-vibedev: route state')
  })

  // Web search through the gateway, as the provider `vibedev-gateway`. Registering does not select it: DeepSeek
  // Harness keeps its own search unless a profile sets `web.searchProvider: vibedev-gateway` (the VibeDev app does).
  ctx.inject(['web'], (webCtx) => {
    // The web service unregisters it with this fiber.
    webCtx.web.registerSearchProvider(new GatewaySearchProvider({
      endpoint: `${origin}/v1/vibedev/web-search`,
      resolveCredential: () => chain.resolve(),
      rejectCredential: credential => chain.reject(credential),
      userAgent,
      requestTimeoutMs: 20_000,
      maxRetries: 2,
      maxRetryWaitMs: 10_000,
    }))
  })

  // The account pages' routes (sidebar status, Settings → VibeDev 账号).
  const account = new AccountService({
    origin, userAgent, chain, login,
    models: () => ({ count: route?.models().length ?? 0, ...route?.hidden() === undefined ? {} : { hidden: route.hidden() } }),
  })
  ctx.inject(['connection'], (scoped) => {
    for (const accountRoute of accountRoutes(account)) {
      scoped.effect(() => scoped.connection.fetch.register(accountRoute), `dsh-vibedev: ${accountRoute.path}`)
    }
  })

  ctx.effect(() => {
    void tracker.resume().catch((error: unknown) => { warn(`dsh-vibedev: resuming tasks failed: ${String(error)}`) })
    const unsubscribe = login.onChange(() => { runtime.invalidateCatalog() })
    return () => {
      unsubscribe()
      tracker.dispose()
      login.dispose()
    }
  }, 'dsh-vibedev: tasks and sign-in')

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
    }, 'dsh-vibedev: media catalog account watch')
  })
}
