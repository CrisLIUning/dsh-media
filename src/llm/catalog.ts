/**
 * The VibeDev gateway's model catalog (`GET /v1/models`), narrowed to the chat
 * models this channel can serve and annotated with the wire protocol each one
 * is called over.
 *
 * The gateway answers with its VibeDev projection for signed, signature-exempt,
 * and app-token requests: every entry carries `protocol`, `capabilities` (context,
 * output, thinking, `reasoning_levels`, `default_reasoning`, modalities,
 * `allowed_endpoints`), and prices. Media generators, transcription models, and
 * the models the client drives itself (`internal_role`) are not chat models and
 * never reach the picker.
 *
 * @module dsh-vibedev/llm/catalog
 */

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './limits.js'

/** The wire protocols the gateway serves chat models over, named as pi-ai names them. */
export type GatewayApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions'

/** A reasoning level as the gateway catalog spells it. */
export type GatewayReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const REASONING_LEVELS: readonly GatewayReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The endpoint each protocol is called on, as `allowed_endpoints` lists it. */
const ENDPOINT: Readonly<Record<GatewayApi, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-responses': '/v1/responses',
  'openai-completions': '/v1/chat/completions',
}

/** One chat model of the catalog with everything the adapter needs to describe and call it. */
export interface GatewayModel {
  readonly id: string
  readonly name: string
  /** The protocol requests for this model use. */
  readonly api: GatewayApi
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly ('text' | 'image')[]
  /**
   * Levels the user may pick, in escalation order; `undefined` when the catalog
   * states none (no level control), `[]` when the model thinks with no levels.
   */
  readonly reasoningLevels?: readonly GatewayReasoningLevel[]
  /** The level a new session starts on, when the catalog names one it offers. */
  readonly defaultReasoning?: GatewayReasoningLevel
  /** Claude's effort-driven thinking, as opposed to a token budget. */
  readonly adaptiveThinking: boolean
  /** Catalog prices per million tokens, in the catalog's currency (yuan). */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

const price = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/**
 * The protocol a model family is called over best, before the catalog's endpoint list has a say:
 * Claude speaks Messages natively; GPT, the o-series, Codex, and Grok keep their reasoning state
 * on Responses; everything else (DeepSeek, GLM, Kimi, Doubao, ...) passes through Chat Completions.
 * @param id - the catalog model id.
 * @returns the preferred protocol.
 */
export function preferredApi(id: string): GatewayApi {
  const family = id.toLowerCase()
  if (family.startsWith('claude')) return 'anthropic-messages'
  if (/^(?:gpt|o\d|codex|grok)/.test(family)) return 'openai-responses'
  return 'openai-completions'
}

/**
 * The protocol to call one catalog entry over: the family's preferred protocol when the
 * entry allows it, otherwise the first protocol it does allow. An entry listing no endpoint
 * this channel speaks (a native-only Gemini, say) has none.
 * @param id - the catalog model id.
 * @param allowed - the entry's `allowed_endpoints`, when it lists them.
 * @param protocol - the entry's `protocol`, used when it lists no endpoints.
 * @returns the protocol, or undefined when this channel cannot call the model.
 */
export function chooseApi(id: string, allowed: readonly string[] | undefined, protocol: string | undefined): GatewayApi | undefined {
  const preferred = preferredApi(id)
  if (allowed !== undefined && allowed.length > 0) {
    const offered = new Set(allowed.map(endpoint => endpoint.replace(/\/+$/, '')))
    const order: GatewayApi[] = [preferred, 'openai-completions', 'anthropic-messages', 'openai-responses']
    return order.find(api => offered.has(ENDPOINT[api]))
  }
  if (protocol === 'anthropic' && preferred !== 'anthropic-messages') return 'anthropic-messages'
  if (protocol !== undefined && /gemini|google/i.test(protocol)) return undefined
  return preferred
}

/** The catalog's levels, kept in escalation order and stripped of spellings this channel does not know. */
function reasoningLevelsOf(value: unknown): GatewayReasoningLevel[] | undefined {
  const listed = strings(value)
  if (listed === undefined) return undefined
  const known = new Set(listed)
  return REASONING_LEVELS.filter(level => known.has(level))
}

/**
 * Parse one `/v1/models` body into the chat models this channel serves.
 * @param body - the decoded response: `{object, data: [...]}` or a bare array.
 * @returns the chat models, in catalog order; entries that are not chat models or cannot be called are left out.
 */
export function parseCatalog(body: unknown): GatewayModel[] {
  const list = Array.isArray(body) ? body : record(body)?.data
  if (!Array.isArray(list)) return []
  const models: GatewayModel[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const entry = record(raw)
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (entry === undefined || id === '' || seen.has(id)) continue
    const capabilities = record(entry.capabilities)
    // The plain gateway list (an unsigned, non-exempt request) carries no capabilities: nothing to describe a model with.
    if (capabilities === undefined) continue
    if (typeof entry.media_type === 'string' && entry.media_type !== '') continue
    if (typeof entry.internal_role === 'string' && entry.internal_role !== '') continue
    if (capabilities.chat === false) continue
    if (capabilities.video_generation === true || capabilities.audio_generation === true
      || capabilities.transcription === true || capabilities.realtime_transcription === true) continue
    const outputs = strings(capabilities.output_modalities)
    if (outputs !== undefined && outputs.length > 0 && !outputs.includes('text')) continue
    const api = chooseApi(id, strings(capabilities.allowed_endpoints), typeof entry.protocol === 'string' ? entry.protocol : undefined)
    if (api === undefined) continue
    const levels = reasoningLevelsOf(capabilities.reasoning_levels)
    const defaultReasoning = typeof capabilities.default_reasoning === 'string'
      && levels?.includes(capabilities.default_reasoning as GatewayReasoningLevel)
      ? capabilities.default_reasoning as GatewayReasoningLevel
      : undefined
    const inputs = strings(capabilities.input_modalities) ?? []
    seen.add(id)
    models.push({
      id,
      name: typeof entry.display_name === 'string' && entry.display_name.trim() !== '' ? entry.display_name.trim() : id,
      api,
      contextWindow: positive(capabilities.context_window) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: positive(capabilities.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
      input: inputs.includes('image') ? ['text', 'image'] : ['text'],
      ...levels === undefined ? {} : { reasoningLevels: levels },
      ...defaultReasoning === undefined ? {} : { defaultReasoning },
      adaptiveThinking: capabilities.adaptive_thinking === true,
      cost: {
        input: price(entry.input_price_per_mtok),
        output: price(entry.output_price_per_mtok),
        cacheRead: price(entry.cache_read_price_per_mtok),
        cacheWrite: price(entry.cache_write_price_per_mtok),
      },
    })
  }
  return models
}

/**
 * The level a new session starts on: the catalog's default, else `high`, else the highest level
 * not above `high`, else the lowest level offered.
 * @param model - the catalog model.
 * @returns the starting level, or undefined when the model offers no levels.
 */
export function startingReasoning(model: GatewayModel): GatewayReasoningLevel | undefined {
  const levels = model.reasoningLevels
  if (levels === undefined || levels.length === 0) return undefined
  if (model.defaultReasoning !== undefined) return model.defaultReasoning
  if (levels.includes('high')) return 'high'
  const capped = levels.filter(level => level !== 'xhigh' && level !== 'max' && level !== 'none')
  return capped.at(-1) ?? levels[0]
}
