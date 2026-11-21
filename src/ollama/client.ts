import { ollamaUrl } from '../composables/useSettings'

const FALLBACK_HOST = 'http://localhost:11434'

/**
 * Resolves the Ollama origin. Order: user setting → VITE_OLLAMA_URL → same origin in dev
 * (the Vite proxy forwards /api) → localhost:11434. A value of "/" means same origin, used by
 * the Docker image where nginx proxies /api.
 */
export function resolveHost(
  setting = ollamaUrl.value,
  env: string | undefined = import.meta.env.VITE_OLLAMA_URL,
  dev = import.meta.env.DEV,
  origin = typeof location !== 'undefined' ? location.origin : FALLBACK_HOST,
): string {
  const pick = setting?.trim() || env?.trim() || (dev ? '/' : FALLBACK_HOST)
  if (pick === '/') return origin
  // "localhost:11434" or "192.168.1.5:11434" would otherwise be fetched as a relative path
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(pick) ? pick : `http://${pick}`
  return withScheme.replace(/\/+$/, '').replace(/\/api$/, '')
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

async function send(path: string, { method = 'GET', body, signal }: RequestOptions) {
  let response: Response
  try {
    response = await fetch(`${resolveHost()}/api/${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    const detail = error instanceof Error ? `: ${error.name}: ${error.message}` : ''
    throw new OllamaError(`Can't reach Ollama at ${resolveHost()}${detail}`, undefined, error)
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const payload = await response.text()
      if (payload) {
        try {
          const data = JSON.parse(payload)
          if (typeof data?.error === 'string') message = data.error
          else message += ` — ${payload.slice(0, 300)}`
        } catch {
          message += ` — ${payload.slice(0, 300)}`
        }
      }
    } catch {
      // Keep the HTTP status if the error response itself cannot be read.
    }
    throw new OllamaError(message, response.status)
  }
  return response
}

export async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options)
  return (await response.json()) as T
}

/** POSTs and yields each NDJSON line. Throws OllamaError on `{"error": …}` lines. */
export async function* streamJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const response = await send(path, { method: 'POST', body, signal })
  if (!response.body) throw new OllamaError('Empty response body')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      let result: ReadableStreamReadResult<string>
      try {
        result = await reader.read()
      } catch (error) {
        if (signal?.aborted) throw error
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        throw new OllamaError(
          `Ollama stream read failed (${path}): ${detail}`,
          response.status,
          error,
        )
      }
      const { done, value } = result
      if (value) buffer += value
      const lines = buffer.split('\n')
      if (done) {
        // Ollama normally terminates each NDJSON record with a newline, but process
        // the final buffered record too when a proxy/server closes without one.
        buffer = ''
      } else {
        buffer = lines.pop() ?? ''
      }
      for (const line of lines) {
        if (!line.trim()) continue
        let data: T & { error?: string }
        try {
          data = JSON.parse(line)
        } catch (error) {
          const sample = line.slice(0, 160).replace(/\s+/g, ' ')
          throw new OllamaError(
            `Invalid NDJSON from Ollama (${path}): ${error instanceof Error ? error.message : 'JSON parse failed'}. Record starts: ${sample}`,
            response.status,
            error,
          )
        }
        if (typeof data.error === 'string') throw new OllamaError(data.error)
        yield data as T
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
