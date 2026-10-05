/** A loopback stand-in for the VibeDev gateway: serves a catalog and records every model request. Ported from vibedev-app's @vibedev/dsh-llm-gateway tests. */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One recorded request. */
export interface RecordedRequest {
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown> | undefined
}

/** What the double answers to one model request. */
export interface Behavior {
  readonly status?: number
  readonly body?: string
  /** Chat Completions SSE data lines, sent when no failing status is given. */
  readonly events?: readonly string[]
}

export interface GatewayDouble {
  readonly url: string
  readonly requests: RecordedRequest[]
  readonly catalogRequests: RecordedRequest[]
}

const servers: Server[] = []

/** A minimal complete Chat Completions text reply. */
export const chatTextEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":"stop"}]}',
  '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Close every double opened since the last call; run from each spec's afterEach. */
export async function closeGatewayDoubles(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/**
 * Start a double.
 * @param catalog - the body `/v1/models` answers with.
 * @param script - behaviors for successive model requests; an exhausted script answers 500.
 * @param options - `catalogStatus`: answer `/v1/models` with this status instead of the catalog.
 * @returns the double's URL and what it recorded.
 */
export async function gatewayDouble(catalog: unknown, script: Behavior[] = [], options: { catalogStatus?: number } = {}): Promise<GatewayDouble> {
  const requests: RecordedRequest[] = []
  const catalogRequests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    request.on('end', () => {
      const recorded: RecordedRequest = {
        path: request.url ?? '',
        headers: request.headers,
        body: raw === '' ? undefined : JSON.parse(raw) as Record<string, unknown>,
      }
      if (recorded.path === '/v1/models') {
        catalogRequests.push(recorded)
        if (options.catalogStatus !== undefined) {
          response.writeHead(options.catalogStatus, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"refused"}}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(catalog))
        return
      }
      requests.push(recorded)
      const behavior = script.shift() ?? { status: 500, body: '{"error":{"message":"script exhausted"}}' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', 'x-request-id': `req-${requests.length}` })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of behavior.events ?? []) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('gateway double has no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, catalogRequests }
}

/** The gateway projection for a representative account: chat models on all three protocols, plus entries the channel must leave out. */
export const CATALOG = {
  object: 'list',
  data: [
    {
      id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', protocol: 'anthropic', currency: 'CNY',
      input_price_per_mtok: 5, output_price_per_mtok: 25, cache_read_price_per_mtok: 0.5, cache_write_price_per_mtok: 6.25,
      capabilities: {
        context_window: 1_000_000, max_output_tokens: 128_000, thinking: true, adaptive_thinking: true,
        input_modalities: ['text', 'image'], reasoning_levels: ['low', 'medium', 'high', 'max'], default_reasoning: 'high',
        allowed_endpoints: ['/v1/messages', '/v1/chat/completions'],
      },
    },
    {
      id: 'gpt-5.5', display_name: 'GPT-5.5', protocol: 'openai', currency: 'CNY',
      input_price_per_mtok: 1.25, output_price_per_mtok: 10, cache_read_price_per_mtok: 0.125, cache_write_price_per_mtok: 0,
      capabilities: {
        context_window: 400_000, max_output_tokens: 128_000, thinking: true, adaptive_thinking: false,
        input_modalities: ['text', 'image'], reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning: 'medium',
        allowed_endpoints: ['/v1/responses', '/v1/chat/completions'],
      },
    },
    {
      id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', protocol: 'openai', currency: 'CNY',
      input_price_per_mtok: 1, output_price_per_mtok: 2, cache_read_price_per_mtok: 0.02, cache_write_price_per_mtok: 0,
      capabilities: {
        context_window: 1_000_000, max_output_tokens: 384_000, thinking: true, adaptive_thinking: false,
        input_modalities: ['text', 'image'], reasoning_levels: ['none', 'low', 'high', 'max'],
        allowed_endpoints: ['/v1/chat/completions', '/v1/messages'],
      },
    },
    {
      id: 'glm-5.3', display_name: 'GLM 5.3', protocol: 'openai', currency: 'CNY',
      input_price_per_mtok: 2, output_price_per_mtok: 8, cache_read_price_per_mtok: 0.4, cache_write_price_per_mtok: 0,
      capabilities: { context_window: 200_000, max_output_tokens: 64_000, thinking: false, adaptive_thinking: false, input_modalities: ['text'] },
    },
    { id: 'kling-video-v3', display_name: 'Kling Video', protocol: 'openai', media_type: 'video', capabilities: { input_modalities: ['text', 'image'], video_generation: true } },
    { id: 'glm-4v-flash', display_name: 'Vision assist', protocol: 'openai', internal_role: 'vision_fast', capabilities: { input_modalities: ['text', 'image'] } },
    { id: 'doubao-asr-vibedev', display_name: 'ASR', protocol: 'openai', capabilities: { input_modalities: ['audio'], transcription: true } },
    { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro', protocol: 'gemini', capabilities: { input_modalities: ['text'], allowed_endpoints: ['/v1beta'] } },
    { id: 'plain-entry', type: 'model', display_name: 'plain-entry', created_at: '2024-01-01T00:00:00Z' },
  ],
}
