import { reactive } from 'vue'
import { applyEvent, closeReasoning, textOf } from '../domain/parts'
import { resolveSettings } from '../domain/settings'
import { activePath } from '../domain/thread'
import type { Chat, MessageNode, Part } from '../domain/types'
import { uuid } from '../domain/uuid'
import { requestJson } from '../ollama/client'
import { buildChatRequest, startChat } from '../ollama/transport'
import { useChats } from './useChats'
import { useModels } from './useModels'
import { usePresets } from './usePresets'
import { autoTitle } from './useSettings'
import { errorMessage, toast } from './useToasts'
import { confirmAction } from './useConfirm'
import {
  agentEnabled,
  approveShell,
  cancelShell,
  inspectPath,
  openUrl,
  stageShell,
  webSearch,
} from '../agent/client'
import { ASSISTANT_TOOLS } from '../agent/tools'

const PERSIST_INTERVAL_MS = 500

/**
 * In-flight generations keyed by chat id; at most one per chat, any number across chats.
 * A slot is claimed synchronously before any await, so a second send/regenerate/edit can't slip
 * in while the first is still setting up, and Stop works from the very first moment.
 */
const running = reactive(new Map<string, { nodeId: string | null; abort(): void }>())
/** Slot key for a send from the unsaved new-chat draft, before its chat row exists. */
const DRAFT = '\0draft'

const chats = useChats()
const models = useModels()
const presets = usePresets()

// Deleting a chat (or all chats) stops its generation first.
chats.onBeforeDelete((chatId) => {
  if (chatId === null) for (const slot of running.values()) slot.abort()
  else stop(chatId)
})

function isGenerating(chatId: string | undefined) {
  return running.has(chatId ?? DRAFT)
}

function stop(chatId: string | undefined) {
  running.get(chatId ?? DRAFT)?.abort()
}

function claim(key: string): AbortController | null {
  if (running.has(key)) return null
  const controller = new AbortController()
  running.set(key, { nodeId: null, abort: () => controller.abort() })
  return controller
}

let lastTimestamp = 0
/** Strictly increasing timestamps: siblings are ordered by createdAt, so ties would shuffle versions. */
function nextTimestamp() {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return new Date(lastTimestamp)
}

function newNode(
  chat: Chat,
  parentId: string | null,
  role: MessageNode['role'],
  parts: Part[],
): MessageNode {
  return {
    id: uuid(),
    chatId: chat.id,
    parentId,
    role,
    parts,
    status: 'done',
    createdAt: nextTimestamp(),
  }
}

/** Sends a user message on the active chat, creating the chat for a draft. Returns false if busy. */
async function send(parts: Part[]): Promise<boolean> {
  const model = chats.activeModel.value
  if (!model) {
    toast('Select a model first', 'error')
    return false
  }
  const existing = chats.activeChat.value
  const key = existing?.id ?? DRAFT
  const controller = claim(key)
  if (!controller) return false
  let chatId = key
  try {
    const chat = existing ?? (await chats.createChat(model, draftTitle(parts)))
    if (!existing) {
      // Move the slot from the draft to the new chat
      running.set(chat.id, running.get(DRAFT)!)
      running.delete(DRAFT)
      chatId = chat.id
    }
    const parentId = chats.activePath(chat.id).at(-1)?.id ?? null
    const user = await chats.addNode(newNode(chat, parentId, 'user', parts))
    await generate(chat, user.id, controller)
  } finally {
    running.delete(chatId)
  }
  return true
}

/** Generates a new assistant reply as a sibling of `nodeId` (or below it, for a user node). */
async function regenerate(chatId: string, nodeId: string): Promise<boolean> {
  const chat = chats.getChat(chatId)
  const node = chats.getNode(chatId, nodeId)
  if (!chat || !node) return false
  const controller = claim(chatId)
  if (!controller) return false
  try {
    await generate(chat, node.role === 'assistant' ? node.parentId : node.id, controller)
  } finally {
    running.delete(chatId)
  }
  return true
}

/** Replaces a user message by adding an edited sibling, then answers it. Returns false if busy. */
async function edit(chatId: string, nodeId: string, text: string): Promise<boolean> {
  const chat = chats.getChat(chatId)
  const node = chats.getNode(chatId, nodeId)
  if (!chat || !node || node.role !== 'user') return false
  const controller = claim(chatId)
  if (!controller) return false
  try {
    const parts: Part[] = [
      ...node.parts.filter((p) => p.type === 'file'),
      { type: 'text', text },
    ]
    const edited = await chats.addNode(
      newNode(
        chat,
        node.parentId,
        'user',
        parts.map((p) => ({ ...p })),
      ),
    )
    await generate(chat, edited.id, controller)
  } finally {
    running.delete(chatId)
  }
  return true
}

/** Streams a reply below `parentId`. The caller owns the running slot and its controller. */
async function generate(
  chat: Chat,
  parentId: string | null,
  controller: AbortController,
) {
  const model = chat.model || chats.activeModel.value
  const settings = resolveSettings(
    presets.globalPreset(),
    presets.modelPreset(model),
    chat.settings,
  )
  const toolPolicy = 'Local tool-use policy: you are an advisory assistant by default. Do not call web, filesystem, or shell tools unless the user explicitly asks you in their current message to perform that specific lookup, inspection, or operation. Do not treat requests for advice, explanations, plans, or recommendations as permission to act. Never execute or stage a shell command without the user explicitly asking for an operation; even then, wait for the separate exact-command approval prompt. If tool use would help but was not requested, explain what you could check and ask first.'
  const generationSettings = agentEnabled.value
    ? {
        ...settings,
        systemPrompt: [settings.systemPrompt, toolPolicy].filter(Boolean).join('\n\n'),
      }
    : settings
  let currentParentId = parentId
  let finalNode: MessageNode | null = null
  const firstHistory = activePath(chats.chatIndex(chat.id), parentId)
  const save = (node: MessageNode) =>
    chats.getChat(chat.id) ? chats.saveNode(node) : Promise.resolve()

  try {
    const info = await models.loadInfo(model)
    controller.signal.throwIfAborted()
    // A bounded agent loop prevents a model from endlessly calling tools.
    for (let turn = 0; turn < 8; turn++) {
      controller.signal.throwIfAborted()
      const history =
        turn === 0
          ? firstHistory
          : activePath(chats.chatIndex(chat.id), currentParentId)
      const node = newNode(chat, currentParentId, 'assistant', [])
      node.status = 'streaming'
      node.meta = { model }
      await chats.addNode(node)
      finalNode = node
      const slot = running.get(chat.id)
      if (slot) slot.nodeId = node.id
      await chats.updateChat(chat.id, { activeLeafId: node.id, updatedAt: new Date() })

      const stream = startChat(
        {
          model,
          history,
          settings: generationSettings,
          supportsThinking: info?.capabilities.includes('thinking') ?? false,
          tools: agentEnabled.value ? [...ASSISTANT_TOOLS] : undefined,
        },
        controller.signal,
      )
      let lastSave = Date.now()
      for await (const event of stream.events) {
        const meta = applyEvent(node.parts, event, Date.now())
        if (meta) node.meta = { ...node.meta, ...meta }
        if (Date.now() - lastSave > PERSIST_INTERVAL_MS) {
          lastSave = Date.now()
          void save(node)
        }
      }
      node.status = 'done'
      closeReasoning(node.parts, Date.now())
      await save(node)

      const calls = node.parts.filter(
        (part): part is Extract<Part, { type: 'tool-call' }> => part.type === 'tool-call',
      )
      if (!calls.length) break
      currentParentId = node.id
      for (const call of calls) {
        controller.signal.throwIfAborted()
        call.state = 'running'
        let result: unknown
        try {
          if (!agentEnabled.value) {
            throw new Error(
              'Local assistant tools are disabled. Enable and connect the companion in Settings.',
            )
          }
          const args = (
            call.args && typeof call.args === 'object' ? call.args : {}
          ) as Record<string, unknown>
          switch (call.name) {
            case 'web_search':
              result = await webSearch(String(args.query ?? ''), controller.signal)
              break
            case 'open_url':
              result = await openUrl(String(args.url ?? ''), controller.signal)
              break
            case 'inspect_path':
              result = await inspectPath(String(args.path ?? ''), controller.signal)
              break
            case 'run_shell': {
              const command = String(args.command ?? '')
              const cwd = typeof args.cwd === 'string' ? args.cwd : undefined
              const staged = await stageShell(command, cwd, controller.signal)
              call.state = 'awaiting-approval'
              await save(node)
              const approved = await confirmAction({
                title: 'Run local shell command?',
                message:
                  'The assistant wants to run this command with your normal user permissions. It has not run yet.\n\n' +
                  'COMMAND:\n' +
                  staged.command +
                  '\n\nWORKING DIRECTORY:\n' +
                  staged.cwd,
                confirmLabel: 'Approve once',
                danger: true,
              })
              if (controller.signal.aborted) {
                await cancelShell(staged.id).catch(() => {})
                controller.signal.throwIfAborted()
              }
              if (!approved) {
                await cancelShell(staged.id).catch(() => {})
                call.state = 'denied'
                result = {
                  denied: true,
                  message: 'The user denied this command. Do not retry unless the user asks.',
                }
              } else {
                call.state = 'running'
                await save(node)
                result = await approveShell(staged.id, controller.signal)
                call.state = 'done'
              }
              break
            }
            default:
              throw new Error(`Unknown tool: ${call.name}`)
          }
          if (call.state !== 'denied') call.state = 'done'
        } catch (error) {
          if (controller.signal.aborted) throw error
          call.state = 'error'
          result = { error: errorMessage(error) }
        }
        controller.signal.throwIfAborted()
        call.result = result
        await save(node)
        const toolNode = newNode(chat, currentParentId, 'tool', [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ])
        toolNode.toolName = call.name
        await chats.addNode(toolNode)
        currentParentId = toolNode.id
        await chats.updateChat(chat.id, { activeLeafId: toolNode.id, updatedAt: new Date() })
      }
      if (turn === 7) {
        const warning = newNode(chat, currentParentId, 'assistant', [
          {
            type: 'error',
            message: 'Stopped after 8 tool rounds to prevent an unbounded tool loop.',
          },
        ])
        warning.status = 'error'
        await chats.addNode(warning)
        finalNode = warning
        await chats.updateChat(chat.id, { activeLeafId: warning.id, updatedAt: new Date() })
        break
      }
    }
  } catch (error) {
    if (finalNode) {
      const aborted = controller.signal.aborted || isAbort(error)
      finalNode.status = aborted ? 'aborted' : 'error'
      if (!aborted) finalNode.parts.push({ type: 'error', message: errorMessage(error) })
      closeReasoning(finalNode.parts, Date.now())
      await save(finalNode)
    } else if (chats.getChat(chat.id)) {
      const aborted = controller.signal.aborted || isAbort(error)
      const failure = newNode(chat, parentId, 'assistant', [])
      failure.status = aborted ? 'aborted' : 'error'
      failure.meta = { model }
      if (!aborted) failure.parts.push({ type: 'error', message: errorMessage(error) })
      await chats.addNode(failure)
      finalNode = failure
      await chats.updateChat(chat.id, { activeLeafId: failure.id, updatedAt: new Date() })
    }
  }

  const current = chats.getChat(chat.id)
  if (
    finalNode?.status === 'done' &&
    current &&
    !current.titleGenerated &&
    autoTitle.value
  ) {
    const firstUser = firstHistory.find((n) => n.role === 'user')
    if (firstUser) void generateTitle(current, firstUser, finalNode)
  }
}


function isAbort(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

function draftTitle(parts: Part[]) {
  const text = textOf(parts).replace(/\s+/g, ' ').trim()
  if (!text) return 'New chat'
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

const TITLE_PROMPT =
  'Write a short title (3 to 6 words) for the conversation below. Reply with the title only: no quotes, no punctuation at the end.'

/** Asks the chat's model for a short title. Leaves updatedAt alone so the chat doesn't jump. */
async function generateTitle(chat: Chat, user: MessageNode, reply: MessageNode) {
  const excerpt = (node: MessageNode) => textOf(node.parts).slice(0, 1500)
  const info = models.info.get(chat.model)
  const request = buildChatRequest({
    model: chat.model,
    history: [
      {
        ...user,
        parts: [
          {
            type: 'text',
            text: `${TITLE_PROMPT}\n\nUser: ${excerpt(user)}\n\nAssistant: ${excerpt(reply)}`,
          },
        ],
      },
    ],
    settings: { think: false },
    supportsThinking: info?.capabilities.includes('thinking') ?? false,
  })
  try {
    const response = await requestJson<{ message?: { content?: string } }>('chat', {
      method: 'POST',
      body: { ...request, stream: false },
    })
    const title = cleanTitle(response.message?.content ?? '')
    const current = chats.getChat(chat.id)
    if (title && current && !current.titleGenerated) {
      await chats.updateChat(chat.id, { title, titleGenerated: true })
    }
  } catch {
    // keep the draft title
  }
}

export function cleanTitle(raw: string) {
  return (
    raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/^["'*#\s]+|["'*.\s]+$/g, '')
      .replace(/^title:\s*/i, '')
      .slice(0, 60) ?? ''
  )
}

export function useGeneration() {
  return { running, isGenerating, stop, send, regenerate, edit }
}
