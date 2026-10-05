/** The gateway catalog narrows to callable chat models and picks each one's protocol and levels. */

import { describe, expect, it } from 'vitest'
import { chooseApi, parseCatalog, startingReasoning } from '../src/llm/catalog.js'
import type { GatewayModel } from '../src/llm/catalog.js'
import { getSupportedThinkingLevels, thinkingLevelMap, toPiModel } from '../src/llm/models.js'
import { CATALOG } from './llm-gateway-double.js'

const byId = (models: GatewayModel[]): Map<string, GatewayModel> => new Map(models.map(model => [model.id, model]))

describe('parseCatalog', () => {
  it('keeps only the chat models this channel can call', () => {
    expect(parseCatalog(CATALOG).map(model => model.id)).toEqual(['claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash', 'glm-5.3'])
    // A bare array, an empty body, and the plain gateway list without capabilities.
    expect(parseCatalog(CATALOG.data).map(model => model.id)).toHaveLength(4)
    expect(parseCatalog({})).toEqual([])
    expect(parseCatalog({ data: [{ id: 'gpt-5.5', type: 'model' }] })).toEqual([])
  })

  it('calls each family over its own protocol when the entry allows it', () => {
    const models = byId(parseCatalog(CATALOG))
    expect(models.get('claude-opus-5-5')?.api).toBe('anthropic-messages')
    expect(models.get('gpt-5.5')?.api).toBe('openai-responses')
    expect(models.get('deepseek-v4-flash')?.api).toBe('openai-completions')
    expect(models.get('glm-5.3')?.api).toBe('openai-completions')
  })

  it('reads capacity, modalities, levels, the default level, and prices', () => {
    const models = byId(parseCatalog(CATALOG))
    expect(models.get('claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'],
      reasoningLevels: ['low', 'medium', 'high', 'max'], defaultReasoning: 'high', adaptiveThinking: true,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    })
    expect(models.get('glm-5.3')).toMatchObject({ input: ['text'], adaptiveThinking: false })
    expect(models.get('glm-5.3')?.reasoningLevels).toBeUndefined()
  })

  it('drops a default level the model does not offer and duplicate ids', () => {
    const models = parseCatalog({ data: [
      { id: 'gpt-x', protocol: 'openai', capabilities: { input_modalities: ['text'], reasoning_levels: ['low', 'high'], default_reasoning: 'max' } },
      { id: 'gpt-x', protocol: 'openai', capabilities: { input_modalities: ['text'] } },
    ] })
    expect(models).toHaveLength(1)
    expect(models[0]?.defaultReasoning).toBeUndefined()
  })
})

describe('chooseApi', () => {
  it('prefers the family protocol, falls back to an allowed one, and refuses native-only entries', () => {
    expect(chooseApi('claude-sonnet-5', ['/v1/chat/completions'], 'anthropic')).toBe('openai-completions')
    expect(chooseApi('grok-4.6', ['/v1/responses/'], 'openai')).toBe('openai-responses')
    expect(chooseApi('kimi-k3', undefined, 'openai')).toBe('openai-completions')
    expect(chooseApi('some-model', undefined, 'anthropic')).toBe('anthropic-messages')
    expect(chooseApi('gemini-3-pro', ['/v1beta'], 'gemini')).toBeUndefined()
    expect(chooseApi('gemini-3-pro', undefined, 'gemini')).toBeUndefined()
  })
})

describe('startingReasoning', () => {
  const model = (reasoningLevels: GatewayModel['reasoningLevels'], defaultReasoning?: GatewayModel['defaultReasoning']): GatewayModel => ({
    id: 'm', name: 'm', api: 'openai-completions', contextWindow: 1, maxTokens: 1, input: ['text'], adaptiveThinking: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...reasoningLevels === undefined ? {} : { reasoningLevels },
    ...defaultReasoning === undefined ? {} : { defaultReasoning },
  })
  it('takes the catalog default, then high, then the highest level not above high', () => {
    expect(startingReasoning(model(['low', 'high', 'max'], 'max'))).toBe('max')
    expect(startingReasoning(model(['low', 'high', 'max']))).toBe('high')
    expect(startingReasoning(model(['none', 'low', 'medium', 'xhigh']))).toBe('medium')
    expect(startingReasoning(model(['xhigh', 'max']))).toBe('xhigh')
    expect(startingReasoning(model([]))).toBeUndefined()
    expect(startingReasoning(model(undefined))).toBeUndefined()
  })
})

describe('pi-ai descriptors', () => {
  it('closes every level the catalog leaves out and opens off only for none', () => {
    expect(thinkingLevelMap(['none', 'low', 'high', 'max'])).toEqual({ minimal: null, low: 'low', medium: null, high: 'high', max: 'max' })
    expect(thinkingLevelMap(['low', 'medium', 'high'])).toEqual({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' })
  })

  it('builds one descriptor per protocol with the gateway endpoint and the compat it needs', () => {
    const models = byId(parseCatalog(CATALOG))
    const origin = 'https://gateway.example'
    const claude = toPiModel(models.get('claude-opus-5-5')!, 'deepseek-account', origin)
    expect(claude).toMatchObject({ api: 'anthropic-messages', baseUrl: origin, reasoning: true, compat: { forceAdaptiveThinking: true } })
    expect(getSupportedThinkingLevels(claude)).toEqual(['low', 'medium', 'high', 'max'])
    const gpt = toPiModel(models.get('gpt-5.5')!, 'deepseek-account', origin)
    expect(gpt).toMatchObject({ api: 'openai-responses', baseUrl: `${origin}/v1`, reasoning: true })
    expect(getSupportedThinkingLevels(gpt)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    const deepseek = toPiModel(models.get('deepseek-v4-flash')!, 'deepseek-account', origin)
    expect(deepseek).toMatchObject({
      api: 'openai-completions', baseUrl: `${origin}/v1`,
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    })
    const glm = toPiModel(models.get('glm-5.3')!, 'deepseek-account', origin)
    expect(glm).toMatchObject({ reasoning: false, compat: { supportsReasoningEffort: false } })
    expect(glm.thinkingLevelMap).toBeUndefined()
  })
})
