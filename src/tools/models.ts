/**
 * `media_models`: the media models this VibeDev account can use, with prices
 * and, for video, what each generation mode accepts.
 * @module dsh-vibedev/tools/models
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MediaModel } from '../gateway/catalog.js'
import { describePrice } from '../pricing.js'
import type { MediaRuntime, ModelSlot } from '../runtime.js'
import { describeVideoModel } from '../video/plan.js'

const KIND_LABEL: Readonly<Record<MediaModel['kind'], string>> = {
  image: 'Image models (image_generate)',
  video: 'Video models (video_generate)',
  audio: 'Music and podcast models (audio_generate)',
  transcription: 'Transcription models (audio_transcribe)',
}

function slotOf(model: MediaModel): ModelSlot {
  if (model.kind === 'audio') return model.audioKind === 'podcast' ? 'podcast' : 'music'
  return model.kind
}

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function mediaModelsTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'media_models',
    description: 'List the image, video, music/podcast and transcription models this VibeDev account can use, with prices. '
      + 'For video models it lists each generation mode and the inputs it accepts (reference images, videos and audio, first and last frames), '
      + 'durations, aspect ratios and resolutions. Use it to choose a model when a request needs particular inputs or options; '
      + 'the generation tools pick a suitable model themselves when none is named.',
    parameters: {
      kind: { type: 'string', enum: ['image', 'video', 'audio', 'transcription'], description: 'Only list models of this kind.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                produces: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'string' },
                capabilities: { type: 'string' },
                pinned: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const models = value.models ?? []
        if (models.length === 0) return [{ type: 'text', text: `No ${args.kind ?? 'media'} models are available on this VibeDev account.` }]
        const lines: string[] = []
        for (const kind of ['image', 'video', 'audio', 'transcription'] as const) {
          const group = models.filter(model => model.kind === kind)
          if (group.length === 0) continue
          lines.push(`${KIND_LABEL[kind]}:`)
          for (const model of group) {
            const facts = [
              model.name === model.id ? undefined : model.name,
              model.produces,
              model.description,
              model.price,
              model.pinned === true ? 'default in settings' : undefined,
            ].filter(part => part !== undefined && part !== '')
            lines.push(`- ${model.id}${facts.length === 0 ? '' : ` — ${facts.join('; ')}`}`)
            if (model.capabilities !== undefined) lines.push(`  ${model.capabilities}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const models = (await runtime.models(exec.signal)).filter(model => args.kind === undefined || model.kind === args.kind)
      return {
        models: models.map((model) => {
          const price = describePrice(model)
          const pinned = runtime.settings.defaultModel(slotOf(model)).trim() === model.id
          return {
            id: model.id, name: model.name, kind: model.kind,
            ...model.audioKind === undefined ? {} : { produces: model.audioKind },
            ...model.description === undefined ? {} : { description: model.description },
            ...price === undefined ? {} : { price },
            ...model.kind === 'video' ? { capabilities: describeVideoModel(model) } : {},
            ...pinned ? { pinned } : {},
          }
        }),
      }
    },
  })
}
