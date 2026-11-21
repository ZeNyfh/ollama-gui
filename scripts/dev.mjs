import { spawn } from 'node:child_process'

const commands = [
  ['web', ['run', 'dev:web']],
  ['agent', ['run', 'agent']],
]

let shuttingDown = false
const children = commands.map(([name, args]) => {
  const child = spawn('bun', args, { stdio: 'inherit', env: process.env })
  child.on('error', (error) => {
    console.error(`[dev] Failed to start ${name}: ${error.message}`)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited (${signal || code || 'unknown'}); stopping the other process.`)
      shutdown(typeof code === 'number' ? code : 1)
    }
  })
  return child
})

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const force = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    process.exit(code)
  }, 1500)
  force.unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
