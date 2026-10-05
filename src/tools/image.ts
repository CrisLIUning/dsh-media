/**
 * `image_generate`: generate images, or edit/derive from reference images,
 * save them in the workspace and show them to the model.
 * @module dsh-vibedev/tools/image
 */

import { basename } from 'node:path'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import { estimateImages, yuan } from '../pricing.js'
import type { MediaCall, MediaRuntime } from '../runtime.js'
import { extensionFor, loadMedia, sniffMime } from '../media/sources.js'
import type { LoadedMedia } from '../media/sources.js'
import { saveNewFile } from '../util/files.js'
import { SOURCE_HELP } from './common.js'

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_REFERENCES = 16
const REFERENCE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const SIZE = /^\d{2,5}x\d{2,5}$/

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

interface DecodedImage {
  readonly data: Uint8Array
  readonly mime: string
}

const noPaths = { readPath: () => Promise.reject(new MediaError('The gateway returned an unexpected image reference.', 'GATEWAY_BAD_RESPONSE')) }

/**
 * Read the images of an `/v1/images/*` answer: `b64_json`, a `data:` URL, or a link.
 * @param runtime - for authenticated downloads of gateway links.
 * @param body - the parsed answer.
 * @param signal - cancels downloads.
 * @returns the images and the revised prompt, when the model returned one.
 */
async function decodeImages(runtime: MediaRuntime, body: unknown, signal: AbortSignal): Promise<{ images: DecodedImage[]; revisedPrompt?: string }> {
  const items = record(body)?.data
  const images: DecodedImage[] = []
  let revisedPrompt: string | undefined
  for (const item of Array.isArray(items) ? items : []) {
    const entry = record(item)
    if (entry === undefined) continue
    revisedPrompt ??= text(entry.revised_prompt)
    const b64 = text(entry.b64_json)
    const url = text(entry.url)
    let data: Uint8Array | undefined
    if (b64 !== undefined) {
      data = new Uint8Array(Buffer.from(b64, 'base64'))
    } else if (url?.startsWith('data:') === true) {
      data = (await loadMedia(url, noPaths, MAX_OUTPUT_BYTES)).data
    } else if (url !== undefined && /^https?:\/\//i.test(url)) {
      const response = await runtime.http.send(url, {
        anonymous: !runtime.http.isGatewayUrl(url), headers: { accept: '*/*' }, timeoutMs: 120_000, signal,
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new MediaError('A generated image is larger than this plugin downloads.', 'OUTPUT_TOO_LARGE')
      data = bytes
    }
    if (data === undefined || data.byteLength === 0) continue
    images.push({ data, mime: sniffMime(data) === 'application/octet-stream' ? 'image/png' : sniffMime(data) })
  }
  return revisedPrompt === undefined ? { images } : { images, revisedPrompt }
}

function form(fields: Record<string, string | number | undefined>, references: readonly LoadedMedia[]): FormData {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) body.append(name, String(value))
  const field = references.length === 1 ? 'image' : 'image[]'
  for (const media of references) {
    body.append(field, new Blob([media.data as Uint8Array<ArrayBuffer>], { type: media.mime }), media.name)
  }
  return body
}

/** One image request, as the tool and host callers make it. */
export interface ImageRequest {
  readonly prompt: string
  readonly model?: string
  /** `WIDTHxHEIGHT` or `auto`. */
  readonly size?: string
  readonly quality?: string
  /** 1-4. */
  readonly n?: number
  /** Images to edit or draw from: paths, links, data URLs or `chat:` references. */
  readonly references?: readonly string[]
}

/** One saved image. */
export interface GeneratedImage {
  readonly absolutePath: string
  readonly mediaType: string
  readonly bytes: number
  readonly data: Uint8Array
}

/**
 * Generate images and save them: model choice, reference checks, the spending
 * confirmation, the gateway call and the files.
 * @param runtime - the media runtime.
 * @param call - the tool call or host call.
 * @param request - what to generate.
 * @param save - where: the folder and the file-name stem (`-2`, `-3`... for more than one).
 * @returns the model, the saved images, the estimate and a revised prompt.
 */
export async function generateImages(
  runtime: MediaRuntime,
  call: MediaCall,
  request: ImageRequest,
  save: { readonly folder: string; readonly stem: string },
): Promise<{ model: string; images: GeneratedImage[]; estimatedCny?: string; revisedPrompt?: string }> {
  const count = Math.min(4, Math.max(1, Math.trunc(request.n ?? 1)))
  const size = request.size?.trim().toLowerCase()
  if (size !== undefined && size !== '' && size !== 'auto' && !SIZE.test(size)) {
    throw new MediaError(`size "${request.size ?? ''}" is not WIDTHxHEIGHT (such as 1024x1024) or auto.`, 'IMAGE_OPTION_INVALID', { field: 'size' })
  }
  const sources = (request.references ?? []).map(source => source.trim()).filter(source => source !== '')
  if (sources.length > MAX_REFERENCES) {
    throw new MediaError(`At most ${MAX_REFERENCES} reference images can be sent; got ${sources.length}.`, 'IMAGE_OPTION_INVALID', { field: 'reference_images' })
  }
  const model = await runtime.pickModel('image', 'image', request.model, undefined, call.signal)
  const references: LoadedMedia[] = []
  for (const source of sources) {
    const media = await runtime.load(call, source, 'image', MAX_REFERENCE_BYTES)
    if (!REFERENCE_TYPES.includes(media.mime)) {
      throw new MediaError(`Reference image "${media.source}" is ${media.mime}; use PNG, JPEG or WebP.`, 'REFERENCE_MEDIA_TYPE_UNSUPPORTED', { field: 'reference_images' })
    }
    references.push(media)
  }
  const estimate = estimateImages(model, count)
  const cost = estimate === undefined ? '' : `, about ${yuan(estimate.amountCny)}`
  await runtime.confirmSpending(call, 'image_generate', {
    en: `Generate ${count} image${count === 1 ? '' : 's'} with ${model.id}${cost}.`,
    zh: `用 ${model.id} 生成 ${count} 张图片${estimate === undefined ? '' : `，约 ${yuan(estimate.amountCny)}`}。`,
  })
  const fields = { model: model.id, prompt: request.prompt, n: count, size: size === '' ? undefined : size, quality: request.quality }
  const answer = await runtime.http.json(references.length === 0 ? '/v1/images/generations' : '/v1/images/edits', {
    method: 'POST',
    ...references.length === 0
      ? { json: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
      : { body: form(fields, references) },
    timeoutMs: 120_000 + count * 90_000,
    signal: call.signal,
  })
  const { images, revisedPrompt } = await decodeImages(runtime, answer, call.signal)
  if (images.length === 0) throw new MediaError('The VibeDev gateway returned no image.', 'IMAGE_EMPTY')
  const saved: GeneratedImage[] = []
  for (const [index, image] of images.entries()) {
    const path = await saveNewFile(save.folder, images.length > 1 ? `${save.stem}-${index + 1}` : save.stem, extensionFor(image.mime, 'png'), image.data)
    saved.push({ absolutePath: path, mediaType: image.mime, bytes: image.data.byteLength, data: image.data })
  }
  return {
    model: model.id,
    images: saved,
    ...estimate === undefined ? {} : { estimatedCny: estimate.amountCny.toFixed(2) },
    ...revisedPrompt === undefined ? {} : { revisedPrompt },
  }
}

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function imageGenerateTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'image_generate',
    description: 'Generate images with a VibeDev image model and save them in the workspace (media/images/); you see the results. '
      + 'With reference_images it edits or derives from those images (style transfer, variations, putting a product into a scene). '
      + 'Costs VibeDev balance per image (about ¥0.1 for gpt-image models); use media_models for the models and prices. '
      + 'Takes about 20 seconds per image.',
    parameters: {
      prompt: {
        type: 'string', required: true,
        description: 'What to draw: subject, setting, style, composition, lighting, and any text that must appear (quote it exactly). '
          + 'With reference images, say what to keep and what to change.',
      },
      model: { type: 'string', description: 'Image model id from media_models. Omit to use the default.' },
      size: {
        type: 'string',
        description: 'WIDTHxHEIGHT: 1024x1024 (square), 1536x1024 (landscape), 1024x1536 (portrait), 2048x2048 (large); or auto. Omit for the model default.',
      },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'Rendering quality; higher is slower. Omit for the model default.' },
      n: { type: 'integer', description: 'Number of images, 1-4. Default 1.' },
      reference_images: {
        type: 'array', items: { type: 'string' },
        description: `Images to edit or draw from (PNG, JPEG or WebP, up to 20 MB each). Each is ${SOURCE_HELP}.`,
      },
      filename: { type: 'string', description: 'File name for the result, without extension. Default: a timestamp plus the start of the prompt.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          images: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                absolutePath: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                attachment: { type: 'json' },
              },
            },
          },
          estimatedCny: { type: 'string' },
          revisedPrompt: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [`Generated ${value.images.length} image${value.images.length === 1 ? '' : 's'} with ${value.model}: ${value.images.map(image => image.path).join(', ')}.`]
        if (value.estimatedCny !== undefined) lines.push(`Estimated cost ${yuan(Number(value.estimatedCny))}.`)
        if (value.revisedPrompt !== undefined) lines.push(`The model rewrote the prompt as: ${value.revisedPrompt}`)
        const blocks: ContentBlock[] = [{ type: 'text', text: lines.join(' ') }]
        for (const image of value.images) {
          if (image.attachment !== undefined && image.attachment !== null) {
            blocks.push({ type: 'image', attachment: image.attachment as unknown as ImageAttachmentRef })
          }
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const result = await generateImages(runtime, exec, {
        prompt: args.prompt,
        ...args.model === undefined ? {} : { model: args.model },
        ...args.size === undefined ? {} : { size: args.size },
        ...args.quality === undefined ? {} : { quality: args.quality },
        ...args.n === undefined ? {} : { n: args.n },
        ...args.reference_images === undefined ? {} : { references: args.reference_images },
      }, { folder: runtime.outputFolder(exec, 'images'), stem: runtime.stem(args.filename, args.prompt) })
      const attachments = runtime.options.attachments?.()
      const images = []
      for (const image of result.images) {
        let attachment: ImageAttachmentRef | undefined
        try {
          attachment = await attachments?.saveImage({ data: image.data, mediaType: image.mediaType as ImageMediaType, name: basename(image.absolutePath) })
        } catch (error) {
          runtime.log(`dsh-vibedev: could not attach ${basename(image.absolutePath)} for display: ${error instanceof Error ? error.message : String(error)}`)
        }
        images.push({
          path: runtime.display(exec, image.absolutePath), absolutePath: image.absolutePath, mediaType: image.mediaType, bytes: image.bytes,
          ...attachment === undefined ? {} : { attachment: JSON.parse(JSON.stringify(attachment)) as Record<string, string | number> },
        })
      }
      return {
        model: result.model, images,
        ...result.estimatedCny === undefined ? {} : { estimatedCny: result.estimatedCny },
        ...result.revisedPrompt === undefined ? {} : { revisedPrompt: result.revisedPrompt },
      }
    },
  })
}
