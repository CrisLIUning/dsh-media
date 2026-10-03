# dsh-media

在 DeepSeek Harness 和 VibeDev 里生成图片、视频、音乐和播客，并把语音转成文字。Agent 判断需要时会自己调用；结果保存在当前工作区的 `media/` 目录下。

所有请求走 VibeDev 网关，费用从你的 VibeDev 余额里扣。还没有账号的话，可以在 [vibedev.jzsaas.com](https://vibedev.jzsaas.com) 注册。

[English](#english)

## 安装

- **VibeDev**：在设置的插件页安装 `dsh-media`。插件直接使用 VibeDev 已登录的账号，不需要再登录。
- **DeepSeek Harness 命令行**：

  ```bash
  dsh plugin add dsh-media
  ```

- **DeepSeek Harness 桌面版**：先完全退出桌面版，然后运行：

  ```bash
  dsh plugin --profile desktop add dsh-media
  ```

在 DeepSeek Harness 里第一次使用时，Agent 会调用 `media_account` 打开 VibeDev 登录页（新用户可以在那里注册），登录完成后就能生成了。

## 能做什么

| 工具 | 用途 |
| --- | --- |
| `image_generate` | 生成图片；带参考图时用来改图、换风格或把产品放进场景。生成的图片 Agent 自己能看到。 |
| `video_generate` | 生成视频，在后台运行，一般 1 到 10 分钟。完成后会通知 Agent，文件保存在 `media/videos/`。 |
| `audio_generate` | 生成音乐（可以自带歌词）或一期播客（围绕一个话题或一个网页）。 |
| `audio_transcribe` | 把语音转成文字（目前只支持普通话）。 |
| `media_models` | 列出账号可用的模型和价格；视频模型还会列出每种模式接受哪些输入。 |
| `media_tasks` | 查看进行中和已完成的视频、音频任务。 |
| `media_account` | 查看用的是哪个 VibeDev 账号；登录或退出。 |

### 参考素材

参考图、参考视频、参考音频、首帧和尾帧可以用下面几种方式给出：

- 工作区里的文件路径，例如 `assets/product.png`；
- http(s) 链接；
- `chat:1`：你在对话里发送的、最近一个对应类型的文件（`chat:2` 是再往前一个），也可以写明类型，例如 `chat:image:1`、`chat:video:1`。

每个视频模型支持的模式、参考素材数量、时长、画面比例和分辨率都不一样。插件会按网关下发的模型能力逐项检查：模型不支持的请求，会在上传和扣费之前就被拒绝，并说明这个模型支持什么。所有参考素材会先上传到 VibeDev 网关的素材库，网关会检查格式，并测量参考视频的时长。

## 费用

- 图片按张计费，视频按秒计费（参考视频的时长也计入），音乐和播客按次计费。`media_models` 会列出当前价格。
- 视频和音频只在成功时扣费，失败不扣。视频提交后无法取消。
- 设置里的“每次付费生成前先询问”默认关闭。打开后，每次付费请求之前都会先弹出确认，并显示预估金额。

## 设置

在侧边栏的“插件”页打开“VibeDev 媒体生成”，就能在插件详情里修改下面这些设置，改完点“保存”。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 每次付费生成前先询问 | 关 | 打开后，每次生成前先确认费用。 |
| 保存目录 | `media` | 相对于工作区。 |
| 默认生图 / 视频 / 音乐 / 播客 / 转写模型 | 空 | 留空时由 Agent 按模型目录选择。 |

## 隐私

提示词和参考素材会发送到 VibeDev 网关，再由网关转交给对应的模型服务商。生成结果保存在你的工作区。插件自己的登录凭据保存在 DeepSeek Harness 的凭据存储里；任务记录保存在 DeepSeek Harness 数据目录下的 `dsh-media/` 中。

## 开发

```bash
npm install
npm test
npm run build
```

---

## English

Generate images, videos, music and podcasts, and transcribe speech, in DeepSeek Harness and VibeDev. The agent uses these tools on its own judgment, and results are saved in the workspace under `media/`. Requests go through the VibeDev gateway and are paid from your VibeDev balance. To create an account, register at [vibedev.jzsaas.com](https://vibedev.jzsaas.com).

**Install**: in VibeDev, use the plugin page in settings; the app's signed-in account is used. In DeepSeek Harness, run `dsh plugin add dsh-media`, or `dsh plugin --profile desktop add dsh-media` for the desktop app (quit the app fully first). On first use, the agent calls `media_account` to open the VibeDev sign-in page.

**Tools**: `image_generate`, `video_generate` (runs as a background job), `audio_generate` (music or a podcast), `audio_transcribe` (Mandarin only for now), `media_models`, `media_tasks` and `media_account`.

**Inputs**: reference images, videos and audio, and first and last frames, can each be a workspace path, an http(s) link, or `chat:1` for the most recent matching file you attached in the conversation. Each video model supports different modes, reference counts, durations, aspect ratios and resolutions. A request the model cannot serve is refused before anything is uploaded or charged, and the error says what the model supports.

**Cost**: images are priced per image, video per second (reference video length counts), and music and podcasts per request. Failed video and audio tasks are not charged, and a submitted video cannot be cancelled. The "ask before each paid generation" setting is off by default; when it is on, every paid request first shows its estimated price for confirmation.

**Settings**: open "VibeDev Media" on the sidebar's Plugins page to change the spending confirmation, the output folder and the default models, then save.

**Privacy**: prompts and reference media are sent to the VibeDev gateway, which forwards them to the model provider. The plugin's own sign-in is kept in the DeepSeek Harness credential store, and task records are kept under `dsh-media/` in the DeepSeek Harness data folder.

## License

MIT
