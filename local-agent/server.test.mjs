import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
const token = 'test-token-with-enough-entropy'
let child
let base

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

before(async () => {
  const port = await freePort()
  base = 'http://127.0.0.1:' + port
  child = spawn(process.execPath, [serverPath], {
    cwd: fileURLToPath(root),
    env: { ...process.env, OLLAMA_GUI_AGENT_PORT: String(port), OLLAMA_GUI_AGENT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  const deadline = Date.now() + 5000
  while (!output.includes('listening on') && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Companion exited: ' + output)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!output.includes('listening on')) throw new Error('Companion did not start: ' + output)
})

after(() => {
  child?.kill('SIGTERM')
})

async function request(path, { method = 'GET', body, origin = 'http://localhost:5173', auth = true } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(auth ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('allows localhost browser preflight and rejects foreign origins', async () => {
  const preflight = await fetch(base + '/v1/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')

  const foreign = await request('/v1/health', { origin: 'https://attacker.example' })
  assert.equal(foreign.status, 401)
})

test('health requires the pairing token', async () => {
  const denied = await request('/v1/health', { auth: false })
  assert.equal(denied.status, 401)
  const ok = await request('/v1/health')
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).ok, true)
})

test('shell commands are staged and can only be approved once', async () => {
  const stagedResponse = await request('/v1/actions', {
    method: 'POST',
    body: { tool: 'shell', command: 'printf assistant-tool-test' },
  })
  assert.equal(stagedResponse.status, 202)
  const staged = await stagedResponse.json()
  assert.equal(staged.state, 'awaiting-approval')
  assert.equal(staged.command, 'printf assistant-tool-test')

  const approvedResponse = await request('/v1/actions/' + staged.id + '/approve', {
    method: 'POST',
    body: {},
  })
  assert.equal(approvedResponse.status, 200)
  const result = await approvedResponse.json()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'assistant-tool-test')

  const replay = await request('/v1/actions/' + staged.id + '/approve', {
    method: 'POST',
    body: {},
  })
  assert.equal(replay.status, 404)
})

test('a staged command can be cancelled without approval', async () => {
  const stagedResponse = await request('/v1/actions', {
    method: 'POST',
    body: { tool: 'shell', command: 'printf must-not-run' },
  })
  const staged = await stagedResponse.json()
  const cancelled = await request('/v1/actions/' + staged.id + '/cancel', {
    method: 'POST',
    body: {},
  })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).state, 'cancelled')

  const replay = await request('/v1/actions/' + staged.id + '/approve', {
    method: 'POST',
    body: {},
  })
  assert.equal(replay.status, 404)
})

test('webpage reader rejects loopback targets before fetching', async () => {
  const response = await request('/v1/open-url', {
    method: 'POST',
    body: { url: 'http://127.0.0.1:3210/v1/health' },
  })
  assert.equal(response.status, 400)
})
