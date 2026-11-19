# Local companion service

The companion is an optional local process that gives the UI access to the logged-in user's machine. It is deliberately separate from the browser app.

## Run

From the repository root:

```bash
OLLAMA_GUI_AGENT_TOKEN="$(openssl rand -hex 32)" npm run agent
```

The service prints the generated token if `OLLAMA_GUI_AGENT_TOKEN` is omitted. Keep it private. It listens on `127.0.0.1:3210` only. Run it as your normal desktop user, never with sudo.

To enable web search, configure a Brave Search API key:

```bash
BRAVE_SEARCH_API_KEY="your-key" OLLAMA_GUI_AGENT_TOKEN="your-token" npm run agent
```

## API (v1)

Every request requires `Authorization: Bearer <token>`.

- `GET /v1/health` — companion status.
- `POST /v1/inspect` with `{"path":"/path"}` — inspect one directory or read a text file (up to 1 MiB).
- `POST /v1/web-search` with `{"query":"..."}` — DuckDuckGo web search (no API key).
- `POST /v1/open-url` with `{"url":"https://..."}` — fetch and extract readable public webpage text/JSON.
- `POST /v1/actions` with `{"tool":"shell","command":"...","cwd":"/path"}` — stage a shell command. This does not execute it.
- `POST /v1/actions/:id/approve` — consume the staged request and execute the exact command once.
- `POST /v1/actions/:id/cancel` — cancel a pending or running request.

The approval endpoint must only be called by a deliberate user interaction in the UI. Never wire it directly to a model tool call. Approval IDs are one-shot and are consumed before command execution.

## Implemented behaviour

The Vue chat exposes four tools when **Enable model tools** is on: `web_search`, `open_url`, `inspect_path`, and `run_shell`. Ollama's native tool-call messages and `role=tool` replies are persisted in the chat history, and generation continues for up to eight tool rounds.

- Web search uses DuckDuckGo and requires no API key.
- Webpage reading accepts public HTTP(S) text responses, rejects redirects and private/reserved destinations, and pins the HTTP connection to the public address resolved for that request. For HTML pages it removes scripts, styles, navigation, footers, forms, and other boilerplate, prefers article/main content, then caps extracted text at 40,000 characters. Source downloads are capped at 2 MiB.
- File inspection lists up to 500 directory entries or reads a text file up to 1 MiB. It is read-only.
- Shell calls are staged first. The chat UI shows an in-app confirmation dialog with the exact command and working directory. Denial returns a structured result; approval consumes the request ID once and executes as the companion process user.

Run the companion tests with `npm run test:agent`. The companion is a trusted local process, not a sandbox. Enabling tools gives the model read access to arbitrary paths and the ability to propose arbitrary shell commands. Review every command before approving it; do not run the service as root.
