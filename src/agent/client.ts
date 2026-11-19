import { useLocalStorage } from '@vueuse/core'

export const agentUrl = useLocalStorage('ollama-gui:agent-url', 'http://127.0.0.1:3210')
export const agentToken = useLocalStorage('ollama-gui:agent-token', '')
export const agentEnabled = useLocalStorage('ollama-gui:agent-enabled', false)

export interface AgentResult {
  [key: string]: unknown
}

async function agentRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<T> {
  if (!agentToken.value.trim())
    throw new Error('Set the local companion pairing token in Settings')
  let response: Response
  try {
    response = await fetch(`${agentUrl.value.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${agentToken.value.trim()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`Cannot reach local companion at ${agentUrl.value}`)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Local companion returned HTTP ${response.status}`,
    )
  }
  return data as T
}

export const testAgent = () =>
  agentRequest<{
    ok: boolean
    version: number
    platform: string
    home: string
  }>('/v1/health')

export const inspectPath = (path: string, signal?: AbortSignal) =>
  agentRequest<AgentResult>('/v1/inspect', { path }, 'POST', signal)

export const webSearch = (query: string, signal?: AbortSignal) =>
  agentRequest<AgentResult>('/v1/web-search', { query }, 'POST', signal)

export const openUrl = (url: string, signal?: AbortSignal) =>
  agentRequest<AgentResult>('/v1/open-url', { url }, 'POST', signal)

export const stageShell = (command: string, cwd?: string, signal?: AbortSignal) =>
  agentRequest<{ id: string; command: string; cwd: string; warning: string }>(
    '/v1/actions',
    { tool: 'shell', command, cwd },
    'POST',
    signal,
  )

export async function approveShell(
  id: string,
  signal?: AbortSignal,
): Promise<AgentResult> {
  try {
    return await agentRequest<AgentResult>(
      `/v1/actions/${encodeURIComponent(id)}/approve`,
      {},
      'POST',
      signal,
    )
  } catch (error) {
    if (signal?.aborted) await cancelShell(id).catch(() => {})
    throw error
  }
}

export const cancelShell = (id: string) =>
  agentRequest<AgentResult>(
    `/v1/actions/${encodeURIComponent(id)}/cancel`,
    {},
  )
