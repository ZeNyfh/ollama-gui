#!/usr/bin/env node
/**
 * Optional local companion for Ollama GUI.
 *
 * This service intentionally has no direct "execute now" endpoint. Mutating requests
 * are staged, then consumed by a separate one-shot approval call from the UI.
 * Run as the logged-in user, never with sudo/root.
 */
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const HOST = '127.0.0.1'
const PORT = Number(process.env.OLLAMA_GUI_AGENT_PORT || 3210)
const TOKEN = process.env.OLLAMA_GUI_AGENT_TOKEN || randomBytes(32).toString('hex')
const MAX_BODY = 1024 * 1024
const MAX_OUTPUT = 256 * 1024
const COMMAND_TIMEOUT = 120_000
const pending = new Map()
const running = new Map()

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
const safeEqual = (a, b) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error('Request body too large')
  }
  return raw ? JSON.parse(raw) : {}
}
function localOrigin(origin) {
  if (!origin) return false
  try {
    const u = new URL(origin)
    return ['http:', 'https:'].includes(u.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch { return false }
}
function authorized(req) {
  const origin = req.headers.origin
  // Browser requests must originate from localhost. Non-browser CLI use has no Origin.
  if (origin && !localOrigin(origin)) return false
  const auth = req.headers.authorization || ''
  return auth.startsWith('Bearer ') && safeEqual(auth.slice(7), TOKEN)
}
function commandResult(command, cwd, signal) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/bash'
    const child = spawn(shell, ['-lc', command], {
      cwd: cwd || homedir(),
      env: { ...process.env, TERM: 'dumb' },
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    const collect = (target, chunk) => {
      const remaining = MAX_OUTPUT - Buffer.byteLength(stdout) - Buffer.byteLength(stderr)
      if (remaining <= 0) { truncated = true; return }
      const piece = chunk.toString('utf8')
      target(piece.slice(0, remaining))
      if (Buffer.byteLength(piece) > remaining) truncated = true
    }
    child.stdout.on('data', (c) => collect((s) => { stdout += s }, c))
    child.stderr.on('data', (c) => collect((s) => { stderr += s }, c))
    child.once('error', (error) => resolve({ stdout, stderr: error.message, exitCode: null, truncated }))
    child.once('close', (code, signalName) => resolve({ stdout, stderr, exitCode: code, signal: signalName, truncated }))
  })
}
function privateAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || (a === 100 && b >= 64 && b <= 127)
  }
  if (isIP(host) === 6) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') ||
      host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') ||
      host.startsWith('::ffff:') || host.startsWith('2001:db8:') || host.startsWith('ff')
  }
  return false
}
async function publicHostname(hostname) {
  if (privateAddress(hostname)) return false
  if (isIP(hostname)) return true
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true })
    return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address))
  } catch { return false }
}
async function fetchPublicText(target) {
  // Resolve once, reject the entire hostname if any answer is private, then pin the
  // connection to a vetted address so a second DNS lookup cannot rebind to localhost.
  const addresses = await lookup(target.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address)))
    throw new Error('Only public HTTP(S) destinations are allowed')
  const selected = addresses[0]
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = requestFn({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Accept: 'text/html,text/plain,application/json,application/xml' },
      timeout: 15_000,
      servername: target.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses)
        else callback(null, selected.address, selected.family)
      },
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400) {
        res.resume()
        reject(new Error('Redirects are not followed by the local webpage reader'))
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error('Web server returned HTTP ' + status))
        return
      }
      const contentType = String(res.headers['content-type'] || '')
      if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) {
        res.resume()
        reject(new Error('URL did not return readable text'))
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > 100_000) req.destroy(new Error('Webpage exceeds the 100 KiB read limit'))
        else chunks.push(chunk)
      })
      res.on('end', () => resolve({
        status,
        contentType,
        content: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('timeout', () => req.destroy(new Error('Webpage request timed out')))
    req.on('error', reject)
    req.end()
  })
}
async function handle(req, res) {
  const origin = req.headers.origin
  if (origin && localOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') {
    if (!localOrigin(origin)) return json(res, 403, { error: 'Browser origin is not allowed' })
    res.writeHead(204)
    return res.end()
  }
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized. Configure the local companion token.' })
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/v1/health')
    return json(res, 200, { ok: true, version: 1, platform: process.platform, home: homedir() })

  if (req.method === 'POST' && url.pathname === '/v1/inspect') {
    const input = await body(req)
    const target = path.resolve(input.path || homedir())
    const info = await stat(target)
    if (info.isDirectory) {
      const entries = await readdir(target, { withFileTypes: true })
      return json(res, 200, { path: target, entries: entries.slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other' })) })
    }
    if (info.isFile()) {
      if (info.size > MAX_BODY) return json(res, 413, { error: 'File exceeds 1 MiB read limit' })
      return json(res, 200, { path: target, content: await readFile(target, 'utf8') })
    }
    return json(res, 400, { error: 'Unsupported filesystem object' })
  }

  if (req.method === 'POST' && url.pathname === '/v1/actions') {
    const input = await body(req)
    if (input.tool !== 'shell' || typeof input.command !== 'string' || !input.command.trim())
      return json(res, 400, { error: 'Expected tool=shell and a non-empty command' })
    if (input.command.length > 20_000) return json(res, 413, { error: 'Command too long' })
    const cwd = path.resolve(input.cwd || homedir())
    for (const [key, value] of pending) if (Date.now() - value.createdAt > 5 * 60_000) pending.delete(key)
    if (pending.size >= 100) return json(res, 429, { error: 'Too many pending approvals' })
    const id = randomBytes(18).toString('hex')
    const item = { id, tool: 'shell', command: input.command, cwd, createdAt: Date.now(), state: 'awaiting-approval' }
    pending.set(id, item)
    return json(res, 202, { ...item, warning: 'This command has not run. Approve this exact command to execute it.' })
  }

  const approval = url.pathname.match(/^\/v1\/actions\/([a-f0-9]+)\/approve$/)
  if (req.method === 'POST' && approval) {
    const item = pending.get(approval[1])
    if (!item) return json(res, 404, { error: 'Approval request missing, expired or already consumed' })
    pending.delete(item.id) // consume before any asynchronous work: approval cannot be replayed
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Command timed out')), COMMAND_TIMEOUT)
    running.set(item.id, controller)
    try {
      item.state = 'running'
      const result = await commandResult(item.command, item.cwd, controller.signal)
      item.state = controller.signal.aborted ? 'cancelled' : 'completed'
      return json(res, 200, { ...item, ...result })
    } finally {
      clearTimeout(timeout)
      running.delete(item.id)
    }
  }

  const cancel = url.pathname.match(/^\/v1\/actions\/([a-f0-9]+)\/cancel$/)
  if (req.method === 'POST' && cancel) {
    const id = cancel[1]
    if (pending.delete(id)) return json(res, 200, { id, state: 'cancelled' })
    const controller = running.get(id)
    if (controller) { controller.abort(); return json(res, 200, { id, state: 'cancelling' }) }
    return json(res, 404, { error: 'Action not found' })
  }

  if (req.method === 'POST' && url.pathname === '/v1/web-search') {
    const input = await body(req)
    const key = process.env.BRAVE_SEARCH_API_KEY
    if (!key) return json(res, 501, { error: 'Configure BRAVE_SEARCH_API_KEY to enable web search.' })
    if (typeof input.query !== 'string' || !input.query.trim()) return json(res, 400, { error: 'query is required' })
    const response = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(input.query), {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    })
    if (!response.ok) return json(res, 502, { error: 'Search provider returned ' + response.status })
    const data = await response.json()
    return json(res, 200, { results: (data.web?.results || []).slice(0, 8).map(({ title, url, description, age }) => ({ title, url, description, age })) })
  }

  if (req.method === 'POST' && url.pathname === '/v1/open-url') {
    const input = await body(req)
    let target
    try { target = new URL(input.url) } catch { return json(res, 400, { error: 'Invalid URL' }) }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !(await publicHostname(target.hostname)))
      return json(res, 400, { error: 'Only public HTTP(S) URLs are allowed' })
    const page = await fetchPublicText(target)
    return json(res, 200, { url: target.href, contentType: page.contentType, content: page.content })
  }

  return json(res, 404, { error: 'Not found' })
}
const server = createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 500, { error: error.message }))
})
server.listen(PORT, HOST, () => {
  console.log(`Ollama GUI local companion listening on http://${HOST}:${PORT}`)
  console.log('Pairing token (keep private): ' + TOKEN)
  console.log('Run as your normal user. Do not run with sudo.')
})
