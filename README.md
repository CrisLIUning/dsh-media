# @vibedev-si/dsh-vibedev · VibeDev 账号与模型

在 DeepSeek Harness 里登录 VibeDev 账号，和 DeepSeek 账号并存：

- **VibeDev 的模型**：登录后，模型选择器里会多出「VibeDev」一组（Claude、GPT 等网关提供的模型），和 DeepSeek 的模型并列，选中就能用；
- **媒体生成**：Agent 可以生成图片、视频、音乐和播客，并把语音转成文字，结果保存在工作区的 `media/` 目录下；
- **网页搜索**：提供走 VibeDev 网关的网页搜索，见下面的「网页搜索」。

费用都从你的 VibeDev 余额里扣，DeepSeek 账号照常由 DeepSeek Harness 自己管理，两边互不影响。还没有 VibeDev 账号的话，可以在 [vibedev.jzsaas.com](https://vibedev.jzsaas.com) 注册。

本插件由 `dsh-media` 改名而来，见下面的「从 dsh-media 升级」。

[English](#english)

## 安装

- **插件页**：在 DeepSeek Harness 的插件页按包名安装 `@vibedev-si/dsh-vibedev`（包名要带 `@vibedev-si/` 前缀）。也可以先装 [VibeDev 插件中心](https://github.com/VibeDev-Si/dsh-ecosystem)，在里面一键安装。
- **命令行**：

  ```bash
  dsh plugin add @vibedev-si/dsh-vibedev
  ```

- **桌面版命令行**：先完全退出桌面版，然后运行：

  ```bash
  dsh plugin --profile desktop add @vibedev-si/dsh-vibedev
  ```

- **VibeDev 应用**：已内置本插件，不用另装。VibeDev 账号就是应用的主账号：侧边栏最底下一行和设置里的第一项都是它，DeepSeek 账号作为第二个账号显示在它上方。

新版本在 npm 上发布后的 24 小时内，只写包名可能装到上一个版本（pnpm 默认不装发布未满一天的版本），想马上用新版就写明版本号，例如 `@vibedev-si/dsh-vibedev@0.2.4`。

## 登录 VibeDev

在侧边栏底部点「登录 VibeDev」，或打开「设置 → VibeDev 账号」点「登录 VibeDev」。系统浏览器会打开 VibeDev 的登录页：账号密码是在 VibeDev 自己的网页上输入的，插件拿不到你的密码。登录完成后回到应用，侧边栏底部会显示「VibeDev 已登录」，模型选择器里随即出现 VibeDev 的模型。

「设置 → VibeDev 账号」里能看到当前账号、余额和 VibeDev 模型的数量，可以充值、查看用量明细、退出登录。登录会自动续期；退出后 VibeDev 的模型会从选择器里消失，DeepSeek 账号不受影响。

0.2.3 起修复了重启后再次要求登录的问题：启动时凭据服务未就绪或临时读取失败，会在服务就绪后恢复，不把空结果永久缓存；正常关闭应用保留登录。过去写到本地备用文件的会话在宿主凭据服务可用后迁入，宿主已有记录优先，显式退出会清理备用会话。VibeDev 应用内置的插件需要随应用升级到修复版；单独安装在 DeepSeek Harness 中的插件可直接升级。

0.2.4 起在「设置 → VibeDev 账号」页尾加了「创作工具」一行：缺影视工作台或媒体预览时说明用途，都能用了就只留一个进入 VibeDev 插件中心的入口。是否显示按宿主真实的安装状态判断，已装或应用内置的组件不会再推荐安装；这里不会自动安装任何东西，装上、升级都由插件中心或插件页在你自己点击后完成。升级插件不影响已保存的剧本、分镜和作品文件，也不影响现有登录。

## VibeDev 的模型

- 模型列表来自 VibeDev 网关，按你的账号下发，所以**未登录时不显示**，登录后立即出现，不用重启。
- 模型在选择器里的「VibeDev」组；默认模型仍是 DeepSeek Harness 原来的，想用 VibeDev 的模型就在选择器里选。
- 没登录就用了 VibeDev 的模型，或登录已失效时，对话里会提示到侧边栏或设置里登录；余额不足时会提示并给出充值链接。这些提示和 DeepSeek 账号的登录、充值提示是分开的。
- 访问令牌过期时插件会自动续期并重发请求，不会重复输出。

## 网页搜索

插件注册了一个网页搜索提供方 `vibedev-gateway`，用你的 VibeDev 登录调用网关的搜索。注册不等于启用：DeepSeek Harness 默认仍用自己的搜索；想改用 VibeDev 的，在配置文件里把 `web` 一行的 `searchProvider` 设为 `vibedev-gateway`（VibeDev 应用默认就是这样）。搜索本身不收费，但余额为零时网关会拒绝所有请求，包括搜索。

## 媒体工具

| 工具 | 用途 |
| --- | --- |
| `image_generate` | 生成图片；带参考图时用来改图、换风格或把产品放进场景。生成的图片 Agent 自己能看到。 |
| `video_generate` | 生成视频，在后台运行，一般 1 到 10 分钟。完成后会通知 Agent，文件保存在 `media/videos/`。 |
| `audio_generate` | 生成音乐（可以自带歌词）或一期播客（围绕一个话题或一个网页）。 |
| `audio_transcribe` | 把语音转成文字（目前只支持普通话）。 |
| `media_models` | 列出账号可用的媒体模型和价格；视频模型还会列出每种模式接受哪些输入。 |
| `media_tasks` | 查看进行中和已完成的视频、音频任务。 |
| `media_account` | 查看用的是哪个 VibeDev 账号；登录或退出（和侧边栏、设置里的登录是同一个）。 |

### 参考素材

参考图、参考视频、参考音频、首帧和尾帧可以用下面几种方式给出：

- 工作区里的文件路径，例如 `assets/product.png`；
- http(s) 链接；
- `chat:1`：你在对话里发送的、最近一个对应类型的文件（`chat:2` 是再往前一个），也可以写明类型，例如 `chat:image:1`、`chat:video:1`。

每个视频模型支持的模式、参考素材数量、时长、画面比例和分辨率都不一样。插件会按网关下发的模型能力逐项检查：模型不支持的请求，会在上传和扣费之前就被拒绝，并说明这个模型支持什么。所有参考素材会先上传到 VibeDev 网关的素材库，网关会检查格式，并测量参考视频的时长。

## 费用

- VibeDev 的聊天模型按用量计费，价格以 VibeDev 网关为准。
- 图片按张计费，视频按秒计费（参考视频的时长也计入），音乐和播客按次计费。`media_models` 会列出当前价格。
- 视频和音频只在成功时扣费，失败不扣。视频提交后无法取消。
- 插件设置里的「每次付费生成前先询问」默认关闭。打开后，每次付费的媒体请求之前都会先弹出确认，并显示预估金额。

## 设置

在侧边栏的「插件」页打开「VibeDev 账号与模型」，可以修改下面这些设置，改完点「保存」。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 每次付费生成前先询问 | 关 | 打开后，每次媒体生成前先确认费用。 |
| 保存目录 | `media` | 相对于工作区。 |
| 默认生图 / 视频 / 音乐 / 播客 / 转写模型 | 空 | 留空时由 Agent 按模型目录选择。 |

另有几项只能在配置文件（`cordis.patch.yml` 中 `dsh-vibedev` 一行）里改：`displayName`（模型选择器里显示的组名，默认 `VibeDev`）、`preferredModels`（排在最前的 VibeDev 模型）、`openBrowserOnSignIn`（登录时是否自动打开系统浏览器，默认开）、`catalogRefreshMinutes`（模型目录刷新间隔，默认 30 分钟）、`client`（登录时报给网关的客户端名称，默认 `vibedev-plugin`）、`primary`（作为应用的主账号显示，默认关，VibeDev 应用里开）。

## 从 dsh-media 升级

- 在 VibeDev 插件中心（0.1.5 起）里点「一键切换」，或直接安装本插件、影视工作台或 AI 创作套装，都会自动切换：先装新包但不启用，再停用 `dsh-media`、启用新包，新包启用成功后才卸载旧包；新包启用失败时会把旧包重新启用。
- 手动升级：先在插件页停用 `dsh-media`，再安装 `@vibedev-si/dsh-vibedev`，然后卸载 `dsh-media`，完全退出再打开应用。两个不能同时启用：它们注册同名的工具，后加载的那个会启动失败。
- 登录状态、进行中的视频和音频任务都会保留，不用重新登录。插件页里的媒体设置（花费确认、保存目录、默认模型）会回到默认值，需要的话重新设一下。

## 隐私

提示词和参考素材会发送到 VibeDev 网关，再由网关转交给对应的模型服务商；生成结果保存在你的工作区。插件自己的登录凭据保存在 DeepSeek Harness 的凭据存储里；任务记录保存在 DeepSeek Harness 数据目录下的 `dsh-media/` 中（沿用旧名，升级时不丢）。

## 给其他插件用

插件注册了一个 `vibedevMedia` 服务，其他插件可以用它生成图片和视频，走的是同一套模型选择、参考素材检查、幂等提交和后台保存。影视工作台（[dsh-film](https://github.com/VibeDev-Si/dsh-film)）的分镜画布就是通过它生成的。调用方已经向用户显示过价格，所以不会再触发「每次付费生成前先询问」。

## 开发

```bash
npm install
npm test
npm run build
```

`npm run build` 把宿主端打包进 `lib/`：DeepSeek Harness 自己的包（`@deepseek-ai/*`）由宿主提供、不打包，pi-ai 及 Anthropic、OpenAI 的 SDK 打包进来，所以安装插件时不会运行任何依赖的安装脚本；同时生成 `THIRD-PARTY-NOTICES.txt`。`npm pack` 之前会运行 `npm run check:package` 检查包内容。

## 第三方代码

`src/llm/` 的模型线路移植自 VibeDev 应用；其中 `context.ts`、`replay.ts`、`stream.ts` 复制自 DeepSeek Harness 的 `@deepseek-ai/dsh-llm-pi-ai`（MIT）。打包进来的 pi-ai、Anthropic SDK、OpenAI SDK 等的许可文本见包内的 `THIRD-PARTY-NOTICES.txt`。

---

## English

Sign in to VibeDev in DeepSeek Harness, next to the DeepSeek account:

- **VibeDev models**: once signed in, the model picker gains a "VibeDev" group (Claude, GPT and the other models of the VibeDev gateway) next to DeepSeek's;
- **Media generation**: the agent generates images, videos, music and podcasts and transcribes speech; results are saved in the workspace under `media/`.

Everything is paid from your VibeDev balance; the DeepSeek account stays DeepSeek Harness's own, and the two do not affect each other. To create an account, register at [vibedev.jzsaas.com](https://vibedev.jzsaas.com). This plugin was renamed from `dsh-media`.

**Install**: install `@vibedev-si/dsh-vibedev` by package name on the Plugins page (the `@vibedev-si/` scope is required), or from the [VibeDev Plugin Center](https://github.com/VibeDev-Si/dsh-ecosystem); from the command line, `dsh plugin add @vibedev-si/dsh-vibedev`, or `dsh plugin --profile desktop add @vibedev-si/dsh-vibedev` for the desktop app (quit it fully first). The VibeDev app ships with the plugin built in, and there the VibeDev account is the main account (the bottom row of the sidebar and the first Settings section), with the DeepSeek account as the second one. Within 24 hours of a release, name the version (e.g. `@vibedev-si/dsh-vibedev@0.2.4`): pnpm does not install versions younger than a day by default.

**Signing in**: choose "Sign in to VibeDev" at the bottom of the sidebar or in Settings → VibeDev account. The VibeDev sign-in page opens in your system browser: you type your password on VibeDev's own page, never in the plugin. Settings → VibeDev account shows the account, the balance and how many VibeDev models are listed, and lets you top up, see usage and sign out.

**Sign-in persistence (0.2.3)**: an early empty or failed startup read is retried when storage becomes ready, and committed credential changes restore the account and model route. A late read cannot overwrite a newly saved sign-in. Normal app exit keeps the sign-in. A session saved in the local fallback is migrated into an available host store without overwriting an existing host record; signing out clears the fallback as well. A built-in copy is upgraded by updating VibeDev, while a separately installed plugin can be upgraded directly.

**Creator tools (0.2.4)**: Settings → VibeDev account ends with a Creator tools line that names the film workbench or the media viewer while one is missing, and otherwise offers the VibeDev plugin centre alone. What appears follows the Host's real inventory, so an installed or app-provided component is never offered again; nothing is installed automatically. Upgrading changes neither saved screenplays, boards and film files nor the existing sign-in.

**Models**: the list comes from the VibeDev gateway for your account, so nothing is listed before you sign in; models appear right after, without a restart. Using a VibeDev model while signed out, or after the sign-in has ended, asks you to sign in; a used-up balance says so with the top-up link. These messages are separate from the DeepSeek account's. An expired access token is renewed and the request sent again, without repeating any output.

**Web search**: the plugin registers the web search provider `vibedev-gateway`, signed in with your VibeDev account. Registering does not select it: DeepSeek Harness keeps its own search unless the profile sets `searchProvider: vibedev-gateway` on the `web` row (the VibeDev app does). Searching is free, but the gateway refuses every request, searches included, while the balance is zero.

**Media tools**: `image_generate`, `video_generate` (runs as a background job), `audio_generate` (music or a podcast), `audio_transcribe` (Mandarin only for now), `media_models`, `media_tasks` and `media_account`. Reference images, videos and audio, and first and last frames, can each be a workspace path, an http(s) link, or `chat:1` for the most recent matching file you attached. A request the model cannot serve is refused before anything is uploaded or charged.

**Cost**: chat models are billed by usage at the gateway's prices; images per image, video per second (reference video length counts), music and podcasts per request. Failed video and audio tasks are not charged, and a submitted video cannot be cancelled. "Ask before each paid generation" is off by default.

**Settings**: open "VibeDev Account & Models" on the Plugins page for the spending confirmation, the output folder and the default media models. `displayName`, `preferredModels`, `openBrowserOnSignIn`, `catalogRefreshMinutes`, `client` (the client name sent with the sign-in, default `vibedev-plugin`) and `primary` (show the account as the app's main account; off by default, on in the VibeDev app) are set in the profile's `cordis.patch.yml` row `dsh-vibedev`.

**Upgrading from dsh-media**: the VibeDev Plugin Center (0.1.5 or later) switches it over for you, from its banner or when you install this plugin, the film workbench or the AI Creator Suite: the new package is installed disabled, `dsh-media` is disabled, the new one enabled, and `dsh-media` removed only after that worked. By hand, disable `dsh-media` first, install `@vibedev-si/dsh-vibedev`, uninstall `dsh-media` and restart the app fully. The two cannot both be enabled: they register the same tool names, and whichever loads second fails to start. The sign-in and running video and audio tasks carry over; the media settings go back to their defaults.

**Privacy**: prompts and reference media are sent to the VibeDev gateway, which forwards them to the model provider. The plugin's own sign-in is kept in the DeepSeek Harness credential store, and task records under `dsh-media/` in the DeepSeek Harness data folder (the former name, kept so an upgrade loses nothing).

**For other plugins**: the `vibedevMedia` service generates images and videos through the same model choice, reference checks, idempotent submission and background saving; the film workbench ([dsh-film](https://github.com/VibeDev-Si/dsh-film)) storyboard uses it.

**Third-party code**: the model route in `src/llm/` is ported from the VibeDev app; `context.ts`, `replay.ts` and `stream.ts` are copied from DeepSeek Harness's `@deepseek-ai/dsh-llm-pi-ai` (MIT). The licences of the bundled pi-ai, Anthropic SDK, OpenAI SDK and their dependencies are in `THIRD-PARTY-NOTICES.txt`.

## Maintainer releases

Build, typecheck and test locally, pack the tested archive, tag the matching source version, and publish a GitHub Release with `vibedev-si-dsh-vibedev-<version>.tgz` attached. `.github/workflows/publish.yml` publishes that exact archive with npm OIDC; it does not rebuild the package. The job checks the source/tag/archive identities and Release asset digest, refuses an existing version with different bytes, and skips an identical already-published version. It verifies the complete npm tarball after publication. For a manual retry of an unpublished version, run the workflow on the version's tag ref.

Configure npm Trusted Publisher with GitHub owner `VibeDev-Si`, repository `dsh-vibedev`, workflow `publish.yml`, no environment, and **Allow npm publish**. Enable **Allow npm dist-tag** as well to use the manual `dist-tag` operation for `latest` or `next`. No npm token is stored in this repository. Trusted publishing does not authorize `npm deprecate`; that maintenance operation still uses interactive authentication.

## License

MIT
