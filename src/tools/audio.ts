/**
 * `audio_generate`: a song or a podcast episode, as a background task whose
 * results are saved in the workspace.
 * @module dsh-media/tools/audio
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import { estimateAudio, yuan } from '../pricing.js'
import type { MediaRuntime } from '../runtime.js'
import type { TaskRecord } from '../tasks/store.js'
import { UNCONFIRMED_NOTE, describeTask, excerpt, submitTask, waitForTask } from './common.js'

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function audioGenerateTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'audio_generate',
    description: 'Generate music (a song with vocals or an instrumental) or a podcast episode (a spoken conversation about a topic or a web page) '
      + 'with a VibeDev audio model. It runs as a background job (usually 1-5 minutes): this call returns once the gateway accepts the task, '
      + 'you are notified when it finishes, and the files are saved in the workspace (media/audio/). Charged per request only when it succeeds '
      + '(about ¥0.5 for music, ¥1 for a podcast; media_models lists prices). The length cannot be chosen.',
    parameters: {
      type: { type: 'string', enum: ['music', 'podcast'], required: true, description: 'What to make.' },
      prompt: {
        type: 'string',
        description: 'Music: style, mood, instruments, tempo, theme. Podcast: the topic and angle to discuss. Required for music; '
          + 'for a podcast give a prompt, a source_url, or both.',
      },
      lyrics: { type: 'string', description: 'Music only: the complete lyrics. Omit to let the model write them.' },
      genre: { type: 'string', description: 'Music only: genre, such as pop, folk, electronic.' },
      mood: { type: 'string', description: 'Music only: mood, such as happy, calm, epic.' },
      gender: { type: 'string', enum: ['male', 'female'], description: 'Music only: the singer\'s voice.' },
      source_url: { type: 'string', description: 'Podcast only: an http(s) page for the hosts to discuss.' },
      model: { type: 'string', description: 'Audio model id from media_models. Omit to use the default for the type.' },
      filename: { type: 'string', description: 'File name for the result, without extension. Default: a timestamp plus the start of the prompt.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          model: { type: 'string', required: true },
          jobId: { type: 'string' },
          estimatedCny: { type: 'string' },
          outputs: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { path: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, durationSeconds: { type: 'number' } },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const prompt = args.prompt?.trim()
      const sourceUrl = args.source_url?.trim()
      let body: Record<string, unknown>
      if (args.type === 'music') {
        if (prompt === undefined || prompt === '') throw new MediaError('Music needs a prompt describing the song.', 'AUDIO_PROMPT_REQUIRED', { field: 'prompt' })
        if (sourceUrl !== undefined && sourceUrl !== '') throw new MediaError('source_url is for podcasts; describe the song in the prompt instead.', 'AUDIO_OPTION_INVALID', { field: 'source_url' })
        body = {
          prompt,
          ...args.lyrics?.trim() ? { lyrics: args.lyrics.trim() } : {},
          ...args.genre?.trim() ? { genre: args.genre.trim() } : {},
          ...args.mood?.trim() ? { mood: args.mood.trim() } : {},
          ...args.gender === undefined ? {} : { gender: args.gender },
        }
      } else {
        if ((prompt === undefined || prompt === '') && (sourceUrl === undefined || sourceUrl === '')) {
          throw new MediaError('A podcast needs a prompt (the topic), a source_url, or both.', 'AUDIO_PROMPT_REQUIRED', { field: 'prompt' })
        }
        if (sourceUrl !== undefined && sourceUrl !== '' && !/^https?:\/\//i.test(sourceUrl)) {
          throw new MediaError('source_url must be an http(s) link.', 'AUDIO_OPTION_INVALID', { field: 'source_url' })
        }
        if (args.lyrics !== undefined || args.genre !== undefined || args.mood !== undefined || args.gender !== undefined) {
          throw new MediaError('lyrics, genre, mood and gender are for music; describe the episode in the prompt instead.', 'AUDIO_OPTION_INVALID')
        }
        body = { ...prompt ? { prompt } : {}, ...sourceUrl ? { source_url: sourceUrl } : {} }
      }
      const model = await runtime.pickModel('audio', args.type, args.model, undefined, exec.signal)
      const estimate = estimateAudio(model)
      const what = args.type === 'music' ? { en: 'a song', zh: '一首音乐' } : { en: 'a podcast episode', zh: '一期播客' }
      await runtime.confirmSpending(exec, 'audio_generate', {
        en: `Generate ${what.en} with ${model.id}${estimate === undefined ? '' : `, about ${yuan(estimate.amountCny)}`}. Charged only if it succeeds.`,
        zh: `用 ${model.id} 生成${what.zh}${estimate === undefined ? '' : `，约 ${yuan(estimate.amountCny)}`}，成功才扣费。`,
      })
      const now = runtime.now()
      const label = excerpt(prompt ?? sourceUrl)
      const draft: TaskRecord = {
        id: randomUUID(), kind: 'audio', model: model.id, label, createdAt: now, updatedAt: now,
        ...exec.agent === undefined ? {} : { owner: exec.agent.id },
        outputDir: runtime.outputFolder(exec, 'audio'), stem: runtime.stem(args.filename, prompt ?? args.type),
        endpoint: '/v1/audio/generations', body: { model: model.id, ...body }, status: 'submitting',
        ...estimate === undefined ? {} : { estimatedCny: estimate.amountCny.toFixed(2) },
      }
      const { record: accepted, jobId, unconfirmed } = await submitTask(runtime, exec, draft)
      const base = {
        taskId: accepted.id, model: model.id,
        ...accepted.estimatedCny === undefined ? {} : { estimatedCny: accepted.estimatedCny },
      }
      if (jobId !== undefined) {
        const kind = args.type === 'music' ? 'Music' : 'Podcast'
        return {
          ...base, status: accepted.status, jobId,
          message: `${unconfirmed ? `${kind} task ${accepted.id} (${model.id}): ${UNCONFIRMED_NOTE}` : `${kind} task submitted to ${model.id}.`} `
            + `Background job ${jobId} reports when it finishes; `
            + `files are saved under ${runtime.display(exec, accepted.outputDir)}. `
            + `${accepted.estimatedCny === undefined ? '' : `Estimated ${yuan(Number(accepted.estimatedCny))}, charged only if it succeeds. `}`
            + 'Carry on with other work meanwhile; there is no need to poll.',
        }
      }
      const final = await waitForTask(runtime, exec, accepted)
      return {
        ...base, status: final.status,
        ...final.outputs === undefined ? {} : {
          outputs: final.outputs.map(output => ({
            ...output.path === undefined ? {} : { path: runtime.display(exec, output.path) },
            ...output.url === undefined ? {} : { url: output.url },
            ...output.title === undefined ? {} : { title: output.title },
            ...output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds },
          })),
        },
        message: describeTask(runtime, exec, final),
      }
    },
  })
}
