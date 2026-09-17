#!/usr/bin/env node
/**
 * workbuddy-connect CLI.
 *
 *   serve     run the loopback OpenAI-compatible endpoint (default)
 *   status    sign-in state, remaining credit, model roster
 *   refresh   re-pull the model roster from the upstream
 *   setup     write the ZCode provider entry for this endpoint
 *   doctor    check credentials, upstream reachability, and the endpoint
 *   logout    drop the plugin-owned credential copy
 *
 * @module workbuddy-connect/cli
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, defaultDesktopAuthCandidates } from './auth.js'
import { WorkBuddyCatalog } from './catalog.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { createWorkBuddyServer } from './server.js'
import {
  configureEndpoint,
  configureStateDir,
  defaultStateDir,
  endpointPath,
  loadToken,
  ownAuthPath,
  setToken,
  stateDir,
} from './config.js'

/** Fixed loopback port the endpoint listens on by default. */
export const DEFAULT_PORT = 39271

const HELP = `workbuddy-connect — use WorkBuddy desktop-app models from any OpenAI-compatible client

Usage: node bin/cli.mjs <command> [options]

Commands:
  serve                 Run the loopback OpenAI-compatible endpoint (default)
  status                Show sign-in state, remaining credit, and the model roster
  refresh               Re-pull the model roster from the upstream
  setup                 Write the ZCode provider entry for this endpoint
  doctor                Check credentials, upstream reachability, and the endpoint
  install-service       Register a logon task that keeps the endpoint running
  uninstall-service     Remove that logon task
  service-status        Report whether the task is registered and the endpoint is up
  logout                Drop the plugin-owned credential copy
  token                 Print the endpoint bearer and exit

Options:
  --port <n>            Fixed port for serve (default 39271; 0 = OS-assigned)
  --token <t>           Override the endpoint bearer
  --home <dir>          State directory (default ${defaultStateDir()})
  --auth-file <path>    Explicit WorkBuddy desktop auth-file path
  --config <path>       provider_config.json to write (setup only)
  --json                Machine-readable output
  -h, --help            This text
`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item.startsWith('--')) {
      const [flag, inline] = item.slice(2).split('=')
      const key = flag.replace(/-([a-z])/gu, (_, c) => c.toUpperCase())
      if (inline !== undefined) {
        args[key] = inline
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1]
        i += 1
      } else {
        args[key] = true
      }
    } else {
      args._.push(item)
    }
  }
  return args
}

function mask(value) {
  if (typeof value !== 'string' || value === '') return '(none)'
  return value.length <= 10 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}

function formatTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '(unknown)'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/** Load or create the persisted endpoint bearer. */
async function ensureToken(args) {
  if (typeof args.token === 'string' && args.token !== '') return args.token
  const path = endpointPath()
  try {
    const document = JSON.parse(await readFile(path, 'utf8'))
    if (typeof document['token'] === 'string' && document['token'] !== '') {
      return loadToken(document['token'])
    }
  } catch {
    // No persisted endpoint yet.
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(stateDir(), { recursive: true })
  await writeFile(path, `${JSON.stringify({ token, port: Number(args.port) || DEFAULT_PORT, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  setToken(token)
  return token
}

function buildStore(args) {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    refresh: credential => client.refreshToken(credential),
    ownPath: ownAuthPath(),
    ...(typeof args.authFile === 'string' ? { desktopPath: args.authFile } : {}),
  })
  return { store, client }
}

/** Preflight: parse the auth file and report what a user can act on. */
async function commandDoctor(args) {
  const { store, client } = buildStore(args)
  const report = { stateDir: stateDir(), desktopAuthPath: store.desktopAuthPath(), ownAuthPath: ownAuthPath(), checks: [] }

  const candidates = store.resolveDesktopCandidates()
  report['desktopCandidates'] = candidates
  const present = candidates.filter(path => existsSync(path))
  report['checks'].push({
    name: 'desktop auth file',
    ok: present.length > 0,
    detail: present.length > 0 ? present[0] : `not found; looked at ${candidates.join(' , ')}`,
  })

  const status = await store.status()
  report['authStatus'] = status
  report['checks'].push({
    name: 'signed in',
    ok: status.state === 'signed-in',
    detail: status.state === 'signed-in'
      ? `${status.nickname ?? '(unnamed)'} · uid ${mask(status.uid)} · expires ${formatTime(status.expiresAtMs)}`
      : (status.reason ?? 'no credential found; sign in once in the WorkBuddy desktop app'),
  })

  if (status.state === 'signed-in') {
    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      report['checks'].push({ name: 'catalog fetch', ok: true, detail: `${models.length} models from ${client.lastCatalog?.source}` })
      try {
        const credits = await client.fetchCredits(credential)
        report['credits'] = credits
        report['checks'].push({
          name: 'credit lookup',
          ok: true,
          detail: credits.unlimited === true ? 'unlimited cycle quota' : `total ${credits.total} across ${credits.accounts.length} package(s)`,
        })
      } catch (error) {
        report['checks'].push({ name: 'credit lookup', ok: false, detail: String(error) })
      }
    } catch (error) {
      report['checks'].push({ name: 'catalog fetch', ok: false, detail: String(error) })
    }
  }

  const token = await ensureToken(args)
  report['endpoint'] = { baseUrl: `http://127.0.0.1:${Number(args.port) || DEFAULT_PORT}/v1`, token: mask(token) }
  report['checks'].push({ name: 'endpoint bearer', ok: token !== '', detail: report['endpoint'].token })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`workbuddy-connect doctor`)
    console.log(`  state dir         ${report.stateDir}`)
    console.log(`  desktop auth      ${report.desktopAuthPath}`)
    console.log(`  own credential    ${report.ownAuthPath}`)
    console.log(`  endpoint          ${report.endpoint.baseUrl}`)
    console.log(`  bearer            ${report.endpoint.token}`)
    console.log('')
    for (const check of report['checks']) {
      console.log(`  [${check.ok ? ' OK ' : 'FAIL'}] ${check.name.padEnd(18)} ${check.detail}`)
    }
  }
  const failed = report['checks'].filter(check => !check.ok)
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function commandStatus(args) {
  const { store, client } = buildStore(args)
  const status = await store.status()
  const catalog = new WorkBuddyCatalog()
  const report = { auth: status }

  if (status.state === 'signed-in') {
    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      catalog.set(models, { source: client.lastCatalog?.source })
      report['models'] = catalog.current().map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages,
        efforts: model.reasoning?.supportedEfforts ?? (model.reasoning?.defaultEffort === undefined ? [] : [model.reasoning.defaultEffort]),
        credits: model.billing?.credits,
        free: model.billing?.free === true,
        badges: model.billing?.badges ?? [],
      }))
      try {
        report['credits'] = await client.fetchCredits(credential)
      } catch (error) {
        report['creditsError'] = String(error)
      }
    } catch (error) {
      report['catalogError'] = String(error)
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (status.state !== 'signed-in') {
    console.log(`Not signed in. ${status.reason ?? 'Sign in once in the WorkBuddy desktop app.'}`)
    return
  }
  console.log(`Signed in: ${status.nickname ?? '(unnamed)'}  (uid ${mask(status.uid)}, source ${status.source})`)
  console.log(`Token expires:     ${formatTime(status.expiresAtMs)}`)
  console.log(`Refresh expires:   ${formatTime(status.refreshExpiresAtMs)}`)
  const credits = report['credits']
  if (credits !== undefined) {
    console.log(`Remaining credit:  ${credits.unlimited === true ? 'unlimited (cycle quota)' : credits.total}${credits.cycleResetTime === undefined ? '' : ` · resets ${credits.cycleResetTime}`}`)
    for (const account of credits.accounts) {
      console.log(`                   ${account.packageName}: ${account.remain}/${account.size}`)
    }
  } else if (report['creditsError'] !== undefined) {
    console.log(`Remaining credit:  lookup failed — ${report['creditsError']}`)
  }
  const models = report['models'] ?? []
  console.log(`\nModels (${models.length}):`)
  for (const model of models) {
    const flags = [
      model.supportsImages ? 'img' : 'text-only',
      model.efforts.length === 0 ? 'no explicit efforts' : `efforts ${model.efforts.join('/')}`,
      model.free ? 'FREE' : (model.credits ?? 'rate unknown'),
      ...model.badges,
    ].join(' · ')
    console.log(`  ${model.id.padEnd(22)} ${model.name.padEnd(22)} ${String(model.contextWindow).padStart(9)} ctx  ${flags}`)
  }
}

async function commandRefresh(args) {
  const { store, client } = buildStore(args)
  const credential = await store.resolve()
  const models = await client.fetchModels(credential)
  if (args.json) {
    console.log(JSON.stringify({ source: client.lastCatalog?.source, count: models.length, ids: models.map(m => m.id) }, null, 2))
  } else {
    console.log(`Refreshed: ${models.length} models from ${client.lastCatalog?.source}`)
    console.log(models.map(model => model.id).join(', '))
  }
}

async function commandLogout(args) {
  const { store } = buildStore(args)
  await store.logout()
  console.log(`Removed ${ownAuthPath()} (the desktop app's own sign-in is untouched).`)
}

const AUTOSTART_BASENAME = 'workbuddy-connect.vbs'

/** The current user's Startup folder, or undefined off Windows. */
function startupFolder() {
  const appData = process.env['APPDATA']
  if (appData === undefined || appData === '') return undefined
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/** Path of the Startup-folder launcher, or undefined off Windows. */
function autostartPath() {
  const folder = startupFolder()
  return folder === undefined ? undefined : join(folder, AUTOSTART_BASENAME)
}

/**
 * Register the endpoint to start hidden at logon.
 *
 * The Startup folder rather than a scheduled task: creating a task needs
 * elevation on a locked-down host (it fails outright with access denied), while
 * the Startup folder is per-user and needs none. A VBS trampoline is what keeps
 * the console window from appearing — launching node.exe directly flashes a
 * console on every logon.
 */
async function commandInstallService(args) {
  const target = autostartPath()
  if (target === undefined) {
    console.error('install-service supports Windows only (no %APPDATA%).')
    process.exitCode = 1
    return
  }
  const port = Number(args.port) || DEFAULT_PORT
  const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
  const nodePath = process.execPath

  const vbs = [
    "' WorkBuddy Connect — starts the local OpenAI-compatible endpoint hidden at logon.",
    "' Remove this file to disable autostart; it writes nothing else outside the state dir.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${nodePath}"" ""${cliPath}"" serve --port ${port}", 0, False`,
    '',
  ].join('\r\n')
  await writeFile(target, vbs, 'utf8')

  if (args.json) {
    console.log(JSON.stringify({ autostart: target, nodePath, cliPath, port }, null, 2))
    return
  }
  console.log(`Registered logon autostart: ${target}`)
  console.log(`  command   "${nodePath}" "${cliPath}" serve --port ${port}`)
  console.log('')
  console.log('It starts at your next logon. To start it now without logging out:')
  console.log(`  wscript.exe "${target}"`)
}

async function commandUninstallService(args) {
  const target = autostartPath()
  if (target === undefined) {
    console.error('uninstall-service supports Windows only.')
    process.exitCode = 1
    return
  }
  const existed = existsSync(target)
  if (existed) await rm(target, { force: true })
  if (args.json) {
    console.log(JSON.stringify({ autostart: target, removed: existed }, null, 2))
    return
  }
  console.log(existed ? `Removed ${target}.` : `Nothing to remove (${target} did not exist).`)
}

/** Whether the endpoint answers on the configured port. */
async function probeEndpoint(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { up: true, healthy: false, status: response.status }
    return { up: true, healthy: true, body: await response.json() }
  } catch {
    return { up: false, healthy: false }
  }
}

async function commandServiceStatus(args) {
  const port = Number(args.port) || DEFAULT_PORT
  const token = await ensureToken(args)
  const probe = await probeEndpoint(port, token)
  const target = autostartPath()
  const registered = target !== undefined && existsSync(target)
  const report = {
    autostartPath: target,
    autostartRegistered: registered,
    endpoint: `http://127.0.0.1:${port}/v1`,
    reachable: probe.up,
    healthy: probe.healthy,
    ...(probe.body === undefined ? {} : { state: probe.body }),
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`autostart     ${registered ? `registered (${target})` : 'not registered'}`)
  console.log(`endpoint      ${report.endpoint} — ${probe.up
    ? (probe.healthy ? `up (${probe.body?.models} models)` : `answering but unhealthy (HTTP ${probe.status})`)
    : 'NOT reachable'}`)
  if (!probe.up) {
    console.log('')
    console.log(registered
      ? `Start it with: wscript.exe "${target}"`
      : 'Register it with: node bin/cli.mjs install-service')
  }
}

/** Write the ZCode provider entry pointing at this endpoint. */
async function commandSetup(args) {
  const token = await ensureToken(args)
  const port = Number(args.port) || DEFAULT_PORT
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const configPath = args.config ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.zcode', 'v2', 'provider_config.json')

  const { store, client } = buildStore(args)
  let modelIds = []
  try {
    const credential = await store.resolve()
    const models = await client.fetchModels(credential)
    modelIds = models.map(model => model.id)
  } catch (error) {
    console.warn(`warning: could not fetch the live roster (${String(error)}); falling back to the static list`)
    modelIds = new WorkBuddyCatalog().fallback().map(model => model.id)
  }

  let document
  try {
    document = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    document = { schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }
  }
  const config = document['config'] ??= {}
  const order = config['providerOrder'] ??= []
  const rules = config['providerConfigRules'] ??= {}
  const providerRules = rules['providerRules'] ??= []

  const providerId = 'workbuddy'
  const providerName = 'WorkBuddy'
  const rule = {
    providerId,
    providerName,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: token },
      api: { type: 'openai-chat-completions', baseUrl },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  }
  const existing = providerRules.findIndex(item => item?.providerId === providerId)
  if (existing === -1) providerRules.push(rule)
  else providerRules[existing] = rule
  if (!order.includes(providerId)) order.push(providerId)

  // Per-model window and vision flags, so ZCode plans context correctly instead
  // of assuming one window for every row.
  //
  // ONLY the keys `extractManualModelConfig` picks survive validation:
  // `contextWindow`, `inputFormat.{supportsImage,supportsVideo,supportsPdf}`,
  // and the three `supports*` flags. The rule object is strict, so ONE
  // unrecognised key fails the whole document, and ZCode's failure mode is to
  // discard the ENTIRE personal provider config and fall back to an empty one --
  // silently breaking every other provider too. `maxTokens` is not a property
  // here (output limits live in `optionSpecs`), which is precisely the mistake
  // that caused that. Do not add a key to `properties` without finding it in
  // the schema first.
  const modelRules = (config['modelConfigRules'] ??= {})
  const providerModelRules = (modelRules['providerModelRules'] ??= [])
  modelRules['manualProviderModelRules'] ??= []
  let modelCount = 0
  try {
    const credential = await store.resolve()
    const models = await client.fetchModels(credential)
    for (const model of models) {
      modelCount += 1
      const properties = { contextWindow: model.contextWindow }
      if (model.supportsImages) {
        properties['inputFormat'] = { supportsImage: true }
      }
      const entry = { modelId: model.id, providerId, config: { enabled: true, properties } }
      const index = providerModelRules.findIndex(item => item?.modelId === model.id && item?.providerId === providerId)
      if (index === -1) providerModelRules.push(entry)
      else providerModelRules[index] = entry
    }
  } catch {
    // Roster unavailable; the provider row still works, ZCode just has no
    // per-model hints until the next `setup` run.
  }

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  if (args.json) {
    console.log(JSON.stringify({ configPath, providerId, providerName, baseUrl, models: modelIds.length, modelRules: modelCount }, null, 2))
    return
  }
  console.log(`Wrote provider "${providerName}" into ${configPath}`)
  console.log(`  baseUrl   ${baseUrl}`)
  console.log(`  bearer    ${mask(token)}`)
  console.log(`  models    ${modelIds.length} (${modelCount} per-model rules)`)
}

async function commandServe(args) {
  const token = await ensureToken(args)
  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port)
  configureEndpoint({ port, token })
  const { store } = buildStore(args)

  const server = createWorkBuddyServer({ store, catalog: new WorkBuddyCatalog(), token, port })
  await server.start()

  const url = `http://127.0.0.1:${server.port()}`
  console.log(`[workbuddy-connect] listening on ${url}`)
  console.log(`[workbuddy-connect] OpenAI-compatible base: ${url}/v1`)
  console.log(`[workbuddy-connect] bearer: ${token}`)
  console.log(`[workbuddy-connect] state dir: ${stateDir()}`)

  const shutdown = async signal => {
    console.log(`\n[workbuddy-connect] ${signal} — shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Never exit on an unhandled stream error; a single failed request must not
  // take down the endpoint every model call depends on.
  process.on('uncaughtException', error => {
    console.error(`[workbuddy-connect] uncaught: ${String(error)}`)
  })
  process.on('unhandledRejection', error => {
    console.error(`[workbuddy-connect] unhandled rejection: ${String(error)}`)
  })
}

/** Run a command from argv. Exported so the bin entry stays a one-liner. */
export async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    console.log(HELP)
    return
  }
  configureStateDir(typeof args.home === 'string' ? args.home : defaultStateDir())
  configureEndpoint({ port: Number(args.port) || 0, token: typeof args.token === 'string' ? args.token : '' })

  const command = args._[0] ?? 'serve'
  switch (command) {
    case 'serve':
      await commandServe(args)
      return
    case 'status':
      await commandStatus(args)
      return
    case 'refresh':
      await commandRefresh(args)
      return
    case 'setup':
      await commandSetup(args)
      return
    case 'doctor':
      await commandDoctor(args)
      return
    case 'logout':
      await commandLogout(args)
      return
    case 'install-service':
      await commandInstallService(args)
      return
    case 'uninstall-service':
      await commandUninstallService(args)
      return
    case 'service-status':
      await commandServiceStatus(args)
      return
    case 'token':
      console.log(await ensureToken(args))
      return
    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}