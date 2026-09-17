#!/usr/bin/env node
/**
 * SessionStart hook: make sure the local WorkBuddy endpoint is running.
 *
 * Contract with the rest of the plugin: the provider entry in ZCode's
 * provider_config.json points at a fixed loopback port, so something has to be
 * listening there before the first message. This hook starts it if it is not
 * already up.
 *
 * It is deliberately *self-verifying*: spawning a detached process is the part
 * most likely to be refused (a locked-down or sandboxed host can deny it
 * outright), so the hook never reports success on the strength of the spawn
 * call alone. It probes the endpoint afterwards and says plainly what happened,
 * because a hook that claims the service is up while it is not would turn a
 * visible "start it yourself" into a confusing connection error later.
 *
 * Never fails the session: every path exits 0.
 *
 * @module workbuddy-connect/hooks/service-ensure
 */

import { spawn } from 'node:child_process'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(pluginRoot, 'bin', 'cli.mjs')
const stateDir = process.env['WORKBUDDY_CONNECT_HOME'] ?? join(process.env['USERPROFILE'] ?? '.', '.workbuddy-connect')
const endpointPath = join(stateDir, 'endpoint.json')
const logPath = join(stateDir, 'service.log')
const DEFAULT_PORT = 39271

async function log(line) {
  try {
    await mkdir(stateDir, { recursive: true })
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Diagnostics are best-effort; never let logging break the hook.
  }
}

async function readEndpoint() {
  try {
    const document = JSON.parse(await readFile(endpointPath, 'utf8'))
    const token = typeof document['token'] === 'string' ? document['token'] : ''
    const port = typeof document['port'] === 'number' && document['port'] > 0 ? document['port'] : DEFAULT_PORT
    return { token, port }
  } catch {
    return { token: '', port: DEFAULT_PORT }
  }
}

/** Probe the endpoint; true only when it answers healthily. */
async function healthy(port, token, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.['ok'] === true
  } catch {
    return false
  }
}

async function waitForHealth(port, token, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (await healthy(port, token)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/** Is a process already bound to the port (someone else's, or a stale child)? */
function spawnDetached(port) {
  // `windowsHide` plus `stdio: 'ignore'` is the whole point: the endpoint must
  // not flash a console window on the user's desktop every session.
  const child = spawn(process.execPath, [cliPath, 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: pluginRoot,
  })
  child.unref()
  return child.pid
}

async function main() {
  if (!existsSync(cliPath)) {
    await log(`cli not found at ${cliPath}; skipping`)
    return
  }
  const { token, port } = await readEndpoint()

  if (await healthy(port, token)) {
    await log(`endpoint already healthy on :${port}`)
    return
  }

  let pid
  try {
    pid = spawnDetached(port)
    await log(`spawned detached pid ${pid} on :${port}`)
  } catch (error) {
    await log(`spawn refused: ${String(error)}`)
  }

  if (await waitForHealth(port, token)) {
    await log(`endpoint healthy on :${port}${pid === undefined ? '' : ` (pid ${pid})`}`)
    return
  }

  // The endpoint is not up and the hook could not bring it up. Say so, with the
  // one command that fixes it, rather than leaving the failure to surface as an
  // unexplained connection error on the first message.
  await log(`endpoint NOT healthy on :${port} after spawn attempt`)
  console.log(
    `[workbuddy-connect] The local endpoint is not running on port ${port}.`
    + ' Its models will fail until it is started. Start it in a terminal with:\n'
    + `  node "${cliPath}" serve --port ${port}\n`
    + `Diagnostics: node "${cliPath}" doctor`,
  )
}

main().catch(async error => {
  await log(`hook error: ${String(error)}`)
}).finally(() => {
  process.exit(0)
})