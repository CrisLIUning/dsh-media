/**
 * pi-ai model descriptors and the multi-protocol provider for the gateway.
 *
 * A configured pi-ai route speaks one protocol, but one gateway serves Claude
 * over Messages, GPT and Grok over Responses, and DeepSeek and the rest over Chat
 * Completions. Every pi-ai `Model` carries its own `api`, so this provider
 * dispatches each request to the protocol module its model names, and the whole
 * catalog lives on one channel.
 *
 * @module dsh-vibedev/llm/models
 */

import { createModels as createEmptyModels } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type {
  Api,
  ApiKeyAuth,
  CreateModelsOptions,
  Model,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  ProviderStreams,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import type { GatewayApi, GatewayModel, GatewayReasoningLevel } from './catalog.js'

/** Every pi-ai thinking level, in pi-ai's escalation order. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** pi-ai's lazily loaded protocol implementations, one per protocol the gateway serves. */
// Keyed by every pi-ai protocol name, so a descriptor naming one the gateway does not serve reads as absent.
const PROTOCOLS: Readonly<Partial<Record<Api, () => ProviderStreams>>> = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
}

/**
 * pi-ai's level map for the catalog's levels. pi-ai offers `low`/`medium`/`high`
 * (and `minimal`) unless mapped to null, and `xhigh`/`max` only when mapped, so
 * every level the catalog leaves out is closed explicitly. `off` stays open only
 * when the catalog offers `none`; a model that always thinks never shows "off".
 * @param levels - the catalog's levels for one model.
 * @returns the map pi-ai reads to list and spell levels.
 */
export function thinkingLevelMap(levels: readonly GatewayReasoningLevel[]): ThinkingLevelMap {
  const offered = new Set<string>(levels)
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    if (level === 'off') {
      if (!offered.has('none')) map.off = null
    } else if (offered.has(level)) {
      map[level] = level
    } else if (level !== 'xhigh' && level !== 'max') {
      map[level] = null
    }
  }
  return map
}

/** Wire compatibility the gateway needs per protocol and family; pi-ai cannot detect any of it from our URL. */
function compatOf(model: GatewayModel): Model<Api>['compat'] {
  switch (model.api) {
    case 'anthropic-messages':
      return model.adaptiveThinking ? { forceAdaptiveThinking: true } : undefined
    case 'openai-responses':
      return undefined
    case 'openai-completions': {
      const common = { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' as const }
      if (model.id.toLowerCase().startsWith('deepseek')) {
        // DeepSeek passes through the gateway as-is: `thinking:{type}` plus `reasoning_effort`,
        // and a tool-calling turn must carry its `reasoning_content` back.
        return { ...common, thinkingFormat: 'deepseek', supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true }
      }
      const thinks = model.reasoningLevels !== undefined && model.reasoningLevels.length > 0
      return thinks ? { ...common, thinkingFormat: 'openai', supportsReasoningEffort: true } : { ...common, supportsReasoningEffort: false }
    }
  }
}

/**
 * The endpoint root the protocol's SDK appends its path to: the Anthropic SDK adds
 * `/v1/messages` itself, the OpenAI SDK expects the `/v1` root.
 * @param origin - the gateway origin.
 * @param api - the model's protocol.
 * @returns the base URL for that protocol.
 */
export function baseUrlFor(origin: string, api: GatewayApi): string {
  return api === 'anthropic-messages' ? origin : `${origin}/v1`
}

/**
 * Build pi-ai's descriptor for one catalog model on the given provider route.
 * @param model - the catalog model.
 * @param provider - the route the model is registered under.
 * @param origin - the gateway origin.
 * @returns the pi-ai model.
 */
export function toPiModel(model: GatewayModel, provider: string, origin: string): Model<Api> {
  const levels = model.reasoningLevels ?? []
  // A model listing no levels gets no level control: an empty list means it thinks on its own
  // default, which is exactly what a request naming no level asks for.
  const reasoning = levels.length > 0
  const compat = compatOf(model)
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider,
    baseUrl: baseUrlFor(origin, model.api),
    reasoning,
    ...reasoning ? { thinkingLevelMap: thinkingLevelMap(levels) } : {},
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...compat === undefined ? {} : { compat },
  }
}

/**
 * Api-key auth for requests the adapter authenticates itself: the access token (or a
 * development key) arrives as the request's `apiKey` option, which pi-ai presents here.
 * @param name - status label for the resolution.
 * @returns the api-key auth.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * The provider for one catalog snapshot: each request goes to the protocol module its model names.
 * @param input - route id, display name, and the snapshot's models.
 * @param input.id - the provider route key.
 * @param input.name - the display name.
 * @param input.models - pi-ai descriptors for the snapshot's models.
 * @returns the pi-ai provider.
 */
export function gatewayProvider(input: { id: string; name: string; models: readonly Model<Api>[] }): Provider {
  const streams = new Map<Api, ProviderStreams>()
  const protocolOf = (model: Model<Api>): ProviderStreams => {
    const api = model.api
    let implementation = streams.get(api)
    if (implementation === undefined) {
      const factory = PROTOCOLS[api]
      if (factory === undefined) throw new Error(`gateway model "${model.id}" names unsupported protocol "${model.api}"`)
      implementation = factory()
      streams.set(api, implementation)
    }
    return implementation
  }
  return {
    id: input.id,
    name: input.name,
    auth: { apiKey: harnessApiKeyAuth(input.name) },
    getModels: () => input.models,
    stream: (model, context, options) => protocolOf(model).stream(model, context, options),
    streamSimple: (model, context, options) => protocolOf(model).streamSimple(model, context, options),
  }
}

/**
 * Create an empty pi-ai collection. pi-ai's main entry builds one with no
 * providers; its `providers/all` entry would pull every provider's SDK (AWS,
 * Google, Mistral…) into this plugin's bundle for nothing.
 * @param options - credential storage and ambient authentication integrations.
 * @returns a mutable collection with no registered providers.
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
  return createEmptyModels(options)
}

/**
 * Selectable levels from pi-ai's view of one model, in escalation order.
 * @param model - descriptor carrying reasoning support and wire mappings.
 * @returns the supported levels.
 */
export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}
