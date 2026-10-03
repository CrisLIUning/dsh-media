/**
 * Copy for the dsh-media settings page, in the two languages the client ships.
 * Keys are shared; `zh` is the reference dictionary.
 */

export const zh = {
  spending: '花费',
  confirmSpending: '每次付费生成前先询问',
  confirmSpendingHint: '开启后，生成图片、视频、音乐或播客之前会先请你确认，并显示模型和预估金额。默认关闭。',
  output: '保存位置',
  outputDir: '保存目录',
  outputDirHint: '相对当前工作区。图片、视频、音频和转写稿分别放在其中的 images、videos、audio、transcripts 子目录。清空后恢复为 media。',
  models: '默认模型',
  modelsHint: '填了模型 ID 就优先用它；留空时由 Agent 按 VibeDev 模型目录自己选。想看有哪些模型和价格，可以在对话里让 Agent 列出媒体模型。',
  imageModel: '生图',
  videoModel: '视频',
  musicModel: '音乐',
  podcastModel: '播客',
  transcriptionModel: '语音转写',
  modelPlaceholder: '留空自动选择',
  account: '账号',
  accountHint: '在 VibeDev 里直接使用应用已登录的账号。在 DeepSeek Harness 里，第一次生成时 Agent 会打开 VibeDev 登录页，新用户可以在那里注册。费用从 VibeDev 余额中扣除。',
  register: '前往 VibeDev 注册或充值',
  loading: '正在读取设置…',
  unavailable: '插件没有在运行，暂时不能修改设置。',
  readOnly: '当前的配置文件是只读的。',
  saveFailed: '没有保存成功，请重试。',
  save: '保存',
  saving: '正在保存…',
  overridden: '已修改',
  reset: '恢复默认',
  invalid: '这个值无效',
} as const

/** Keys of the settings page dictionary. */
export type MediaSettingsKey = keyof typeof zh

export const en: Record<MediaSettingsKey, string> = {
  spending: 'Spending',
  confirmSpending: 'Ask before each paid generation',
  confirmSpendingHint: 'When on, you are asked to confirm before an image, video, song or podcast is generated, with the model and the estimated price. Off by default.',
  output: 'Where results go',
  outputDir: 'Output folder',
  outputDirHint: 'Relative to the workspace. Images, videos, audio and transcripts go into its images, videos, audio and transcripts folders. Clear it to go back to media.',
  models: 'Default models',
  modelsHint: 'A model ID entered here is used first; leave it empty to let the agent choose from the VibeDev catalog. Ask the agent to list the media models to see what is available and what it costs.',
  imageModel: 'Images',
  videoModel: 'Video',
  musicModel: 'Music',
  podcastModel: 'Podcasts',
  transcriptionModel: 'Speech to text',
  modelPlaceholder: 'Empty: chosen automatically',
  account: 'Account',
  accountHint: 'In the VibeDev app, the account signed in to the app is used. In DeepSeek Harness, the agent opens the VibeDev sign-in page on first use, where new users can register. Generation is paid from the VibeDev balance.',
  register: 'Register or top up at VibeDev',
  loading: 'Loading settings…',
  unavailable: 'The plugin is not running, so its settings cannot be changed right now.',
  readOnly: 'The configuration is read-only.',
  saveFailed: 'The settings were not saved. Try again.',
  save: 'Save',
  saving: 'Saving…',
  overridden: 'Changed',
  reset: 'Reset',
  invalid: 'Not a valid value',
}
