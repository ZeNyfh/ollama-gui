<script setup lang="ts">
import { IconDownload, IconTrash, IconUpload } from '@tabler/icons-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useChats } from '../../composables/useChats'
import { confirmAction } from '../../composables/useConfirm'
import { useModels } from '../../composables/useModels'
import {
  autoTitle,
  dateLocale,
  enableMarkdown,
  gravatarEmail,
  locale,
  ollamaUrl,
  showSystem,
  theme,
  type Theme,
} from '../../composables/useSettings'
import { errorMessage, toast } from '../../composables/useToasts'
import { agentEnabled, agentToken, agentUrl, testAgent } from '../../agent/client'
import { downloadFile, exportAll, importData } from '../../composables/useTransfer'
import { closeModal, modal } from '../../composables/useUi'
import { relativeTime, resolveLocale } from '../../domain/format'
import Modal from '../ui/Modal.vue'
import Toggle from '../ui/Toggle.vue'
import CorsHelp from './CorsHelp.vue'

const chats = useChats()
const models = useModels()
const open = computed(() => modal.value === 'settings')
const agentStatus = ref('Not connected')
const agentBusy = ref(false)
async function connectAgent() {
  agentBusy.value = true
  try {
    const info = await testAgent()
    agentStatus.value = 'Connected · ' + info.platform + ' · ' + info.home
    agentEnabled.value = true
    toast('Local assistant connected', 'success')
  } catch (error) {
    agentStatus.value = errorMessage(error)
    toast('Local assistant connection failed: ' + agentStatus.value, 'error')
  } finally {
    agentBusy.value = false
  }
}

// Connection
const urlDraft = ref(ollamaUrl.value)
watch(open, (value) => {
  if (value) urlDraft.value = ollamaUrl.value
})
async function saveUrl() {
  ollamaUrl.value = urlDraft.value.trim()
  models.info.clear()
  await models.refresh()
  if (models.connection.value === 'ok') toast(`Connected to ${models.host()}`, 'success')
}

// Appearance
const themes: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
const LOCALES = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'it-IT',
  'pt-BR',
  'nl-NL',
  'sv-SE',
  'nb-NO',
  'da-DK',
  'fi-FI',
  'pl-PL',
  'cs-CZ',
  'ru-RU',
  'uk-UA',
  'tr-TR',
  'ar',
  'he-IL',
  'hi-IN',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'zh-TW',
]
const localeChoice = ref(
  LOCALES.includes(dateLocale.value) || !dateLocale.value ? dateLocale.value : 'custom',
)
const customLocale = ref(localeChoice.value === 'custom' ? dateLocale.value : '')
// Names in English to match the UI language, e.g. "German (Germany)"
const regionNames = new Intl.DisplayNames(['en'], { type: 'language' })
const displayName = (tag: string) => {
  try {
    return regionNames.of(tag) ?? tag
  } catch {
    return tag
  }
}
const systemLocale = resolveLocale('')
watch(localeChoice, (value) => {
  dateLocale.value = value === 'custom' ? customLocale.value.trim() : value
})
watch(customLocale, (value) => {
  if (localeChoice.value === 'custom') dateLocale.value = value.trim()
})
/** Sample of every format the setting affects: date and time, relative time, numbers. */
const preview = computed(() => {
  const sample = new Date()
  sample.setHours(14, 30, 0, 0)
  const dateTime = new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(sample)
  const relative = relativeTime(new Date(Date.now() - 2 * 86400_000), locale.value)
  const number = new Intl.NumberFormat(locale.value).format(1234567.89)
  return `${dateTime} · ${relative} · ${number}`
})
const customInvalid = computed(
  () =>
    localeChoice.value === 'custom' &&
    !!customLocale.value.trim() &&
    resolveLocale(customLocale.value, '') === '',
)

// Data
const persisted = ref<boolean | null>(null)
onMounted(async () => {
  persisted.value = (await navigator.storage?.persisted?.()) ?? null
})
async function requestPersist() {
  persisted.value = (await navigator.storage?.persist?.()) ?? false
  toast(
    persisted.value
      ? 'Storage is now persistent'
      : 'The browser declined persistent storage',
    persisted.value ? 'success' : 'info',
  )
}

async function doExport() {
  const data = await exportAll()
  downloadFile(
    `ollama-gui-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(data, null, 2),
    'application/json',
  )
}

const importInput = ref<HTMLInputElement>()
async function doImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const count = await importData(JSON.parse(await file.text()))
    toast(`Imported ${count} chat${count === 1 ? '' : 's'}`, 'success')
  } catch (error) {
    toast(`Import failed: ${errorMessage(error)}`, 'error')
  }
}

async function wipe() {
  const ok = await confirmAction({
    title: 'Delete all chats?',
    message:
      'Every chat and message stored in this browser will be deleted. Export first if you want a backup.',
    confirmLabel: 'Delete everything',
    danger: true,
  })
  if (ok) {
    await chats.deleteAllChats()
    toast('All chats deleted', 'success')
  }
}

const origin = location.origin
</script>

<template>
  <Modal :open="open" title="Settings" width="560px" @close="closeModal('settings')">
    <div class="divide-border divide-y">
      <section class="space-y-2 p-4">
        <h3 class="text-text-muted text-[11px] font-semibold tracking-wide uppercase">
          Connection
        </h3>
        <label for="ollama-url" class="text-text block text-[12.5px]">Ollama URL</label>
        <form class="flex gap-2" @submit.prevent="saveUrl">
          <input
            id="ollama-url"
            v-model="urlDraft"
            :placeholder="`Default: ${models.host('')}`"
            class="border-border bg-list text-text placeholder:text-text-muted focus:border-accent min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-[12.5px] outline-none"
            data-testid="input-base-url"
          />
          <button
            type="submit"
            class="border-border hover:bg-hover rounded-lg border px-3 py-1.5 text-[12.5px]"
          >
            Save &amp; test
          </button>
        </form>
        <p
          class="text-[12px]"
          :class="models.connection.value === 'error' ? 'text-red' : 'text-text-muted'"
        >
          <template v-if="models.connection.value === 'ok'">
            Connected to {{ models.host() }} · {{ models.models.value.length }} models
          </template>
          <template v-else-if="models.connection.value === 'error'">
            {{ models.connectionError.value }}
          </template>
          <template v-else>Connecting…</template>
        </p>
        <CorsHelp v-if="models.connection.value === 'error'" />
      </section>

      <section class="space-y-3 p-4">
        <h3 class="text-text-muted text-[11px] font-semibold tracking-wide uppercase">
          Local assistant tools
        </h3>
        <p class="text-text-secondary text-[12px] leading-relaxed">
          Connect the companion running on this computer to let models search the web, read local files and request shell commands. Read-only tools run when requested. Shell commands always show an approval prompt with the exact command and working directory before execution.
        </p>
        <label for="agent-url" class="text-text block text-[12.5px]">Companion URL</label>
        <input id="agent-url" v-model="agentUrl" class="border-border bg-list text-text w-full rounded-lg border px-3 py-1.5 text-[12.5px]" />
        <label for="agent-token" class="text-text block text-[12.5px]">Pairing token</label>
        <input id="agent-token" v-model="agentToken" type="password" autocomplete="off" placeholder="Paste token printed by npm run agent" class="border-border bg-list text-text w-full rounded-lg border px-3 py-1.5 text-[12.5px]" />
        <div class="flex items-center gap-2">
          <button type="button" :disabled="agentBusy || !agentToken.trim()" class="bg-accent rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" @click="connectAgent">
            {{ agentBusy ? 'Testing…' : 'Connect & test' }}
          </button>
          <span class="text-text-muted">{{ agentStatus }}</span>
        </div>
        <Toggle
          v-model="agentEnabled"
          label="Enable model tools"
          description="Expose web search, webpage reading, local file inspection and shell access to the model"
        />
        <p class="text-text-muted text-[11px]">
          The companion runs with your logged-in user permissions. Never run it with sudo. Web search uses DuckDuckGo and does not require an API key.
        </p>
      </section>

      <section class="space-y-3 p-4">
        <h3 class="text-text-muted text-[11px] font-semibold tracking-wide uppercase">
          Local assistant tools
        </h3>
        <p class="text-text-secondary text-[12px] leading-relaxed">
          Connect the companion running on this computer to let models search the web, read
          local files and request shell commands. Read-only tools run when requested. Shell
          commands always show an approval prompt with the exact command and working directory
          before execution.
        </p>
        <label for="agent-url" class="text-text block text-[12.5px]">Companion URL</label>
        <input
          id="agent-url"
          v-model="agentUrl"
          class="border-border bg-list text-text w-full rounded-lg border px-3 py-1.5 text-[12.5px]"
        />
        <label for="agent-token" class="text-text block text-[12.5px]">Pairing token</label>
        <input
          id="agent-token"
          v-model="agentToken"
          type="password"
          autocomplete="off"
          placeholder="Paste token printed by npm run agent"
          class="border-border bg-list text-text w-full rounded-lg border px-3 py-1.5 text-[12.5px]"
        />
        <div class="flex items-center gap-2">
          <button
            type="button"
            :disabled="agentBusy || !agentToken.trim()"
            class="border-border hover:bg-hover rounded-lg border px-3 py-1.5 text-[12.5px]"
            @click="connectAgent"
          >
            {{ agentBusy ? 'Testing…' : 'Connect & test' }}
          </button>
          <span class="text-text-muted min-w-0 break-all text-[11.5px]">
            {{ agentStatus }}
          </span>
        </div>
        <Toggle
          v-model="agentEnabled"
          label="Enable model tools"
          description="Expose web search, webpage reading, local file inspection and shell access to the model"
        />
        <p class="text-text-muted text-[11px]">
          The companion runs with your logged-in user permissions. Never run it with sudo. Web
          search requires BRAVE_SEARCH_API_KEY on the companion process.
        </p>
      </section>

      <section class="space-y-3 p-4">
        <h3 class="text-text-muted text-[11px] font-semibold tracking-wide uppercase">
          Data
        </h3>
        <p class="text-text-secondary text-[12px] leading-relaxed">
          Chats are stored only in this browser, for
          <code class="bg-hover rounded px-1">{{ origin }}</code>
          . A different address, port, browser or private window starts with an empty
          history. Export to move chats between them.
        </p>
        <div
          v-if="persisted !== null"
          class="flex items-center justify-between gap-4 text-[12.5px]"
        >
          <span>
            {{
              persisted
                ? 'Persistent storage is on'
                : 'The browser may clear storage when space runs low'
            }}
          </span>
          <button
            v-if="!persisted"
            type="button"
            class="border-border hover:bg-hover rounded-lg border px-3 py-1 text-[12px]"
            @click="requestPersist"
          >
            Keep data
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="border-border hover:bg-hover flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px]"
            data-testid="export-chats"
            @click="doExport"
          >
            <IconDownload :size="15" />
            Export all
          </button>
          <button
            type="button"
            class="border-border hover:bg-hover flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px]"
            data-testid="import-chats"
            @click="importInput?.click()"
          >
            <IconUpload :size="15" />
            Import
          </button>
          <input
            ref="importInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            data-testid="import-input"
            @change="doImport"
          />
          <button
            type="button"
            class="text-red hover:bg-red/10 ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px]"
            data-testid="delete-all-chats"
            @click="wipe"
          >
            <IconTrash :size="15" />
            Delete all chats
          </button>
        </div>
      </section>
    </div>
  </Modal>
</template>
