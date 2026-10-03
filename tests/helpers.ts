/** One request a fake fetch saw. */
export interface SeenRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

type Answer = Response | ((request: SeenRequest, init: RequestInit | undefined) => Response | Promise<Response>)

/**
 * A fetch that answers from a queue and records every request.
 * @param answers - one answer per expected request, in order.
 * @returns the fetch and the requests it saw.
 */
export function fakeFetch(...answers: Answer[]): { fetch: typeof globalThis.fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...init?.headers as Record<string, string> | undefined },
      body: init?.body,
    }
    seen.push(request)
    if (init?.signal?.aborted === true) throw init.signal.reason
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected request ${request.method} ${request.url}`)
    return typeof answer === 'function' ? answer(request, init) : answer
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** The parsed JSON body of a seen request. */
export function bodyOf(request: SeenRequest | undefined): unknown {
  return typeof request?.body === 'string' ? JSON.parse(request.body) : undefined
}
