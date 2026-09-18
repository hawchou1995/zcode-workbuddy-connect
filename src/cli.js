#!/usr/bin/env node
/**
 * zcode-workbuddy-connect CLI.
 *
 *   serve     run the loopback OpenAI-compatible endpoint (default)
 *   status    sign-in state, remaining credit, model roster
 *   refresh   re-pull the model roster from the upstream
 *   setup     write the ZCode provider entry for this endpoint
 *   doctor    check credentials, upstream reachability, and the endpoint
 *   logout    drop the plugin-owned credential copy
 *
 * @module zcode-workbuddy-connect/cli
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore, DESKTOP_AUTH_FILENAME, DESKTOP_AUTH_AI_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_AI_AUTH_FILE_ENV } from './auth.js'
import { WorkBuddyCatalog } from './catalog.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { createWorkBuddyServer } from './server.js'
import {
  configureEndpoint,
  configureStateDir,
  defaultStateDir,
  endpointPath,
  loadToken,
  ownAuthAiPath,
  ownAuthPath,
  setToken,
  stateDir,
} from './config.js'

/** Fixed loopback port the endpoint listens on by default. */
export const DEFAULT_PORT = 39271

const HELP = `zcode-workbuddy-connect — use WorkBuddy desktop-app models from any OpenAI-compatible client

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
  --default-context-window
                        Advertise the upstream's softer default window instead of
                        the widest one it admits (serve only; the default is the max)
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

/**
 * The two regions this service serves. Each gets its own credential store
 * (separate desktop file, separate owned copy, separate env override), its own
 * catalog, and its own URL mount: the root for CN, `/ai` for the international
 * one. The mount is what keeps the shared ids (glm-5.3, hy3…) distinct without
 * polluting the id a client displays. `prefix` is the legacy disambiguator,
 * still honoured on the wire for configurations written before the split.
 */
const VARIANTS = [
  {
    id: 'cn',
    path: '',
    prefix: '',
    appName: 'WorkBuddy',
    desktopFilename: DESKTOP_AUTH_FILENAME,
    authFileEnv: WORKBUDDY_AUTH_FILE_ENV,
    ownPath: ownAuthPath(),
  },
  {
    id: 'ai',
    path: '/ai',
    prefix: 'wbai:',
    appName: 'WorkBuddy AI',
    desktopFilename: DESKTOP_AUTH_AI_FILENAME,
    authFileEnv: WORKBUDDY_AI_AUTH_FILE_ENV,
    ownPath: ownAuthAiPath(),
  },
]

function buildStores(args) {
  const client = new WorkBuddyUpstreamClient()
  const stores = VARIANTS.map(variant => ({
    ...variant,
    store: new WorkBuddyCredentialStore({
      refresh: credential => client.refreshToken(credential),
      ownPath: variant.ownPath,
      desktopFilename: variant.desktopFilename,
      authFileEnv: variant.authFileEnv,
      appName: variant.appName,
      ...(variant.id === 'cn' && typeof args.authFile === 'string' ? { desktopPath: args.authFile } : {}),
    }),
  }))
  return { client, stores }
}

/** Preflight: parse the auth files and report what a user can act on. */
async function commandDoctor(args) {
  const { client, stores } = buildStores(args)
  const report = { stateDir: stateDir(), ownAuthPath: ownAuthPath(), ownAuthAiPath: ownAuthAiPath(), checks: [] }

  for (const { id, appName, store } of stores) {
    const candidates = store.resolveDesktopCandidates()
    const present = candidates.filter(path => existsSync(path))
    report['checks'].push({
      name: `${appName} auth file`,
      ok: present.length > 0,
      detail: present.length > 0 ? present[0] : `not found; looked at ${candidates.join(' , ')}`,
    })

    const status = await store.status()
    report[`${id}AuthStatus`] = status
    report['checks'].push({
      name: `${appName} signed in`,
      ok: status.state === 'signed-in',
      detail: status.state === 'signed-in'
        ? `${status.nickname ?? '(unnamed)'} · uid ${mask(status.uid)} · expires ${formatTime(status.expiresAtMs)}`
        : (status.reason ?? `no credential found; sign in once in the ${appName} desktop app`),
    })

    if (status.state === 'signed-in') {
      try {
        const credential = await store.resolve()
        const models = await client.fetchModels(credential)
        report['checks'].push({ name: `${appName} catalog`, ok: true, detail: `${models.length} models from ${client.lastCatalog?.source}` })
        try {
          const credits = await client.fetchCredits(credential)
          report[`${id}Credits`] = credits
          report['checks'].push({
            name: `${appName} credit`,
            ok: true,
            detail: credits.unlimited === true ? 'unlimited cycle quota' : `total ${credits.total} across ${credits.accounts.length} package(s)`,
          })
        } catch (error) {
          report['checks'].push({ name: `${appName} credit`, ok: false, detail: String(error) })
        }
      } catch (error) {
        report['checks'].push({ name: `${appName} catalog`, ok: false, detail: String(error) })
      }
    }
  }

  const token = await ensureToken(args)
  report['endpoint'] = { baseUrl: `http://127.0.0.1:${Number(args.port) || DEFAULT_PORT}/v1`, token: mask(token) }
  report['checks'].push({ name: 'endpoint bearer', ok: token !== '', detail: report['endpoint'].token })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`zcode-workbuddy-connect doctor`)
    console.log(`  dir         ${report.stateDir}`)
    console.log(`  own credential    ${report.ownAuthPath}`)
    console.log(`  own ai credential ${report.ownAuthAiPath}`)
    console.log(`  endpoint          ${report.endpoint.baseUrl}`)
    console.log(`  bearer            ${report.endpoint.token}`)
    console.log('')
    for (const check of report['checks']) {
      console.log(`  [${check.ok ? ' OK ' : 'FAIL'}] ${check.name.padEnd(24)} ${check.detail}`)
    }
  }
  const failed = report['checks'].filter(check => !check.ok)
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function commandStatus(args) {
  const { client, stores } = buildStores(args)
  const report = {}
  const modelReports = []

  for (const { id, appName, store } of stores) {
    const status = await store.status()
    const entry = { auth: status }
    if (status.state === 'signed-in') {
      try {
        const credential = await store.resolve()
        const models = await client.fetchModels(credential)
        entry['models'] = models.map(model => ({
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
          entry['credits'] = await client.fetchCredits(credential)
        } catch (error) {
          entry['creditsError'] = String(error)
        }
      } catch (error) {
        entry['catalogError'] = String(error)
      }
    }
    report[id] = entry
    modelReports.push({ id, appName, entry })
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const { id, appName, entry } of modelReports) {
    const status = entry.auth
    console.log(`\n=== ${appName} (${id}) ===`)
    if (status.state !== 'signed-in') {
      console.log(`  Not signed in. ${status.reason ?? `Sign in once in the ${appName} desktop app.`}`)
      continue
    }
    console.log(`  Signed in:       ${status.nickname ?? '(unnamed)'}  (uid ${mask(status.uid)}, source ${status.source})`)
    console.log(`  Token expires:   ${formatTime(status.expiresAtMs)}`)
    console.log(`  Refresh expires: ${formatTime(status.refreshExpiresAtMs)}`)
    const credits = entry['credits']
    if (credits !== undefined) {
      console.log(`  Remaining credit: ${credits.unlimited === true ? 'unlimited (cycle quota)' : credits.total}${credits.cycleResetTime === undefined ? '' : ` · resets ${credits.cycleResetTime}`}`)
    } else if (entry['creditsError'] !== undefined) {
      console.log(`  Remaining credit: lookup failed — ${entry['creditsError']}`)
    }
    const models = entry['models'] ?? []
    console.log(`  Models (${models.length}):`)
    for (const model of models) {
      const flags = [
        model.supportsImages ? 'img' : 'text-only',
        model.efforts.length === 0 ? 'no explicit efforts' : `efforts ${model.efforts.join('/')}`,
        model.free ? 'FREE' : (model.credits ?? 'rate unknown'),
        ...model.badges,
      ].join(' · ')
      console.log(`    ${model.id.padEnd(22)} ${model.name.padEnd(20)} ${String(model.contextWindow).padStart(9)} ctx  ${flags}`)
    }
  }
}

async function commandRefresh(args) {
  const { client, stores } = buildStores(args)
  for (const { id, appName, store } of stores) {
    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      if (args.json) {
        console.log(JSON.stringify({ variant: id, source: client.lastCatalog?.source, count: models.length, ids: models.map(m => m.id) }, null, 2))
      } else {
        console.log(`${appName}: refreshed ${models.length} models from ${client.lastCatalog?.source}`)
        console.log(`  ${models.map(model => model.id).join(', ')}`)
      }
    } catch (error) {
      if (args.json) {
        console.log(JSON.stringify({ variant: id, ok: false, error: String(error) }, null, 2))
      } else {
        console.log(`${appName}: refresh failed — ${String(error)}`)
      }
    }
  }
}

async function commandLogout(args) {
  const { stores } = buildStores(args)
  for (const { appName, store } of stores) {
    await store.logout()
    console.log(`Removed ${store.ownAuthPath()} (the ${appName} desktop app's own sign-in is untouched).`)
  }
}

const AUTOSTART_BASENAME = 'zcode-workbuddy-connect.vbs'

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
 *
 * A third policy layer can still refuse the write: some hosts block script
 * files (`.vbs`, `.cmd`, `.bat`, `.ps1`) from being created in the Startup
 * folder while allowing ordinary files beside them — verified on this machine,
 * where `.txt` writes succeed and every script extension returns EPERM. That is
 * a deliberate security control, so this command reports it and stops rather
 * than working around it. Autostart is only the fallback path anyway: the
 * plugin's `SessionStart` hook is what normally brings the endpoint up.
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
    "' ZCode WorkBuddy Connect — starts the local OpenAI-compatible endpoint hidden at logon.",
    "' Remove this file to disable autostart; it writes nothing else outside the state dir.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${nodePath}"" ""${cliPath}"" serve --port ${port}", 0, False`,
    '',
  ].join('\r\n')

  try {
    await writeFile(target, vbs, 'utf8')
  } catch (error) {
    const blocked = error?.code === 'EPERM' || error?.code === 'EACCES'
    console.error(`error: could not write ${target} (${error?.code ?? 'unknown'}).`)
    if (blocked) {
      console.error('  This host blocks script files in the Startup folder. Ordinary files can be')
      console.error('  written there, but .vbs/.cmd/.bat/.ps1 are refused — a deliberate policy, not a bug.')
    }
    console.error('')
    console.error('  Autostart is optional. The plugin\'s SessionStart hook already starts the')
    console.error('  endpoint whenever ZCode opens a session, which covers every use of these')
    console.error('  models from ZCode. Without it, the endpoint still comes up for any session')
    console.error('  begun after a logon; only a client talking to the port with ZCode closed')
    console.error('  would need autostart, and that can be started by hand:')
    console.error(`    node "${cliPath}" serve --port ${port}`)
    process.exitCode = 1
    return
  }

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

/** Write the ZCode provider entries pointing at this endpoint (one per region). */
async function commandSetup(args) {
  const token = await ensureToken(args)
  const port = Number(args.port) || DEFAULT_PORT
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const configPath = args.config ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.zcode', 'v2', 'provider_config.json')

  const { client, stores } = buildStores(args)

  let document
  try {
    document = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    // A fresh document must satisfy the same strict schema as an edited one:
    // `provider` is NOT a valid key here (it belongs to the legacy CLI registry
    // in config.json, a different document). Writing it produced a config ZCode
    // silently discarded in full — caught by docs/validate-provider-config.mjs.
    document = {
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }
  }
  const config = document['config'] ??= {}
  const order = config['providerOrder'] ??= []
  const rules = config['providerConfigRules'] ??= {}
  const providerRules = rules['providerRules'] ??= []

  // Per-model window, output ceiling and vision flags, so ZCode plans context
  // and output budget correctly instead of assuming one window for every row.
  //
  // The rule object is strict (zod `.strict()`), so ONE unrecognised key fails
  // the WHOLE document, and ZCode's failure mode is to discard the ENTIRE
  // personal provider config and fall back to an empty one -- silently breaking
  // every other provider too. The two writable paths, both verified against the
  // compiled schema in `ZCode\resources\app.asar` (`out/host/index.js`, the
  // `extractManualModelConfig` / `providerModelRules` schemas):
  //
  //   config.properties           {contextWindow, inputFormat.{supportsImage,
  //                                supportsVideo,supportsPdf}, supportsToolCall,
  //                                supportsJsonSchemaOutput,
  //                                supportsNativeWebSearch,
  //                                supportsMidConversationSystem,
  //                                requiresMfjsToolSchema}
  //   config.optionSpecs          {reasoningLevel:{values,map},
  //                                maxOutputTokens:{max,map}}
  //
  // There is NO `maxTokens` property: an output limit lives in
  // `optionSpecs.maxOutputTokens.max`, which is the ceiling on the value the
  // user may select (the CLI rejects a selection above it). Writing `maxTokens`
  // into `properties` is the mistake that caused the whole-document discard.
  // `map` is optional and deliberately omitted here: the shipped
  // `openai-chat-completions` API rule already supplies the wire mapping
  // (`{'max_completion_tokens': maxOutputTokens}`), and an expression-language
  // typo in a hand-written `map` would fail validation and take the document
  // down with it. Do not add a key without finding it in the schema first.
  const modelRules = (config['modelConfigRules'] ??= {})
  const providerModelRules = (modelRules['providerModelRules'] ??= [])
  modelRules['manualProviderModelRules'] ??= []

  /**
   * The widest window the upstream admits for a model.
   *
   * `contextWindow` is already `maxInputTokens` (the honest ceiling); the
   * international catalog additionally declares `supportedContextWindows`,
   * whose maximum is that same ceiling. Taking the max over both is therefore
   * a no-op on today's wire but keeps the intent explicit if the upstream ever
   * ships a `supportedLengths` entry above `maxInputTokens`.
   */
  const effectiveContextWindow = model => {
    const declared = Array.isArray(model.supportedContextWindows) ? model.supportedContextWindows : []
    return Math.max(model.contextWindow, ...declared, 0)
  }

  const summary = []
  for (const { id, path: mount, appName, store } of stores) {
    const providerId = id === 'cn' ? 'workbuddy' : 'workbuddy-ai'
    const providerName = appName
    let models = []
    try {
      const credential = await store.resolve()
      models = await client.fetchModels(credential)
    } catch (error) {
      // No credential for this region is a normal state (app not installed):
      // skip the provider entirely rather than register one that only fails.
      console.warn(`warning: ${appName} unavailable, skipping its provider (${String(error)})`)
      summary.push({ providerId, appName, skipped: true, reason: String(error) })
      continue
    }

    // Ids stay exactly as the region names them. The region travels in the
    // baseUrl mount below, so nothing has to be encoded into the name a user
    // reads in the picker.
    const wiredIds = models.map(model => model.id)
    const variantBaseUrl = `http://127.0.0.1:${port}${mount}/v1`

    const rule = {
      providerId,
      providerName,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: token },
        api: { type: 'openai-chat-completions', baseUrl: variantBaseUrl },
        personalModelIds: wiredIds,
        modelOrder: wiredIds,
      },
    }
    const existing = providerRules.findIndex(item => item?.providerId === providerId)
    if (existing === -1) providerRules.push(rule)
    else providerRules[existing] = rule
    if (!order.includes(providerId)) order.push(providerId)

    let modelCount = 0
    for (const model of models) {
      modelCount += 1
      const properties = { contextWindow: effectiveContextWindow(model) }
      if (model.supportsImages) {
        properties['inputFormat'] = { supportsImage: true }
      }
      const config = { enabled: true, properties }
      // Ceiling on the selectable output budget, taken from the upstream's own
      // `maxOutputTokens` rather than a per-model guess.
      if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) {
        config['optionSpecs'] = { maxOutputTokens: { max: model.maxTokens } }
      }
      const entry = { modelId: model.id, providerId, config }
      const index = providerModelRules.findIndex(item => item?.modelId === entry.modelId && item?.providerId === providerId)
      if (index === -1) providerModelRules.push(entry)
      else providerModelRules[index] = entry
    }

    summary.push({ providerId, appName, models: wiredIds.length, modelRules: modelCount, baseUrl: variantBaseUrl, modelIds: wiredIds })
  }

  // Setup has to be idempotent: it only ever adds or updates, so a rule left
  // behind by an earlier run — a renamed model, or the retired `wbai:` prefix —
  // would otherwise linger in the picker forever. Drop every rule that belongs
  // to a provider we manage but is no longer declared by it.
  const managed = new Map(stores.map(({ id }) => [id === 'cn' ? 'workbuddy' : 'workbuddy-ai', undefined]))
  for (const item of summary) {
    if (item.skipped !== true) managed.set(item.providerId, new Set(item.modelIds))
  }
  for (let index = providerModelRules.length - 1; index >= 0; index -= 1) {
    const declared = managed.get(providerModelRules[index]?.providerId)
    if (declared !== undefined && !declared.has(providerModelRules[index].modelId)) {
      providerModelRules.splice(index, 1)
    }
  }

  // Write through a temp file and validate before the real path is touched.
  //
  // ZCode's provider schema is `.strict()`, and its failure mode is to discard
  // the ENTIRE document and fall back to an empty config when any rule carries
  // an unrecognised key. The user's other providers (OpenRouter, DeepSeek, …)
  // would go with it, and nothing would say why. The validator mirrors the
  // schema, so a bad key fails loudly here instead of silently there.
  await mkdir(dirname(configPath), { recursive: true })
  const tempPath = `${configPath}.${process.pid}.tmp`
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  await writeFile(tempPath, serialized, 'utf8')
  const verdict = await validateProviderConfig(tempPath)
  if (!verdict.ok) {
    await rm(tempPath, { force: true })
    console.error(`error: refusing to write ${configPath} — the document would be rejected by ZCode's schema:`)
    for (const problem of verdict.problems) console.error(`  - ${problem}`)
    console.error('  ZCode discards the whole provider config in that case, so nothing was written.')
    process.exitCode = 1
    return
  }
  await rename(tempPath, configPath)

  if (args.json) {
    console.log(JSON.stringify({ configPath, baseUrl, providers: summary }, null, 2))
    return
  }
  console.log(`Wrote provider entries into ${configPath}`)
  console.log(`  baseUrl   ${baseUrl}`)
  console.log(`  bearer    ${mask(token)}`)
  for (const item of summary) {
    if (item.skipped) console.log(`  ${item.appName.padEnd(14)} SKIPPED — ${item.reason.slice(0, 90)}`)
    else console.log(`  ${item.appName.padEnd(14)} ${item.models} models (${item.modelRules} per-model rules) @ ${item.baseUrl}`)
  }
}

/**
 * Run the schema mirror over a candidate document.
 *
 * Delegates to `docs/validate-provider-config.mjs` rather than reimplementing
 * the shapes: that file is the one place the schema is written down, and it is
 * also runnable by hand. A validator that disagrees with itself is worse than
 * none, so this shells out to it and reads the exit code.
 *
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
async function validateProviderConfig(candidatePath) {
  const script = fileURLToPath(new URL('../docs/validate-provider-config.mjs', import.meta.url))
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [script, candidatePath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ ok: false, problems: [String(error)] }))
    child.on('close', code => {
      const problems = stderr.split('\n')
        .filter(line => line.trim().startsWith('- '))
        .map(line => line.trim().slice(2))
      resolve({ ok: code === 0, problems: problems.length > 0 ? problems : [stderr.trim() || `validator exited ${code}`] })
    })
  })
}

async function commandServe(args) {
  const token = await ensureToken(args)
  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port)
  configureEndpoint({ port, token })
  const { client, stores } = buildStores(args)

  const server = createWorkBuddyServer({
    token,
    port,
    client,
    variants: stores.map(({ id, path: mount, prefix, store }) => {
      const catalog = new WorkBuddyCatalog()
      // Report the widest window the upstream admits rather than the softer
      // `defaultLength` tier, so a client that reads `/v1/models` plans against
      // the real ceiling. Same intent as `setup`'s per-model rules; see there
      // for why this is a no-op on today's wire but explicit on purpose.
      catalog.setUseMaximumContextWindow(!args.defaultContextWindow)
      return { id, path: mount, prefix, store, catalog }
    }),
  })
  await server.start()

  const url = `http://127.0.0.1:${server.port()}`
  console.log(`[zcode-workbuddy-connect] listening on ${url}`)
  console.log(`[zcode-workbuddy-connect] OpenAI-compatible base: ${url}/v1`)
  for (const { id, path: mount } of stores) {
    console.log(`[zcode-workbuddy-connect]   ${id.padEnd(3)} mount: ${url}${mount}/v1`)
  }
  console.log(`[zcode-workbuddy-connect] bearer: ${token}`)
  console.log(`[zcode-workbuddy-connect] state dir: ${stateDir()}`)

  const shutdown = async signal => {
    console.log(`\n[zcode-workbuddy-connect] ${signal} — shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Never exit on an unhandled stream error; a single failed request must not
  // take down the endpoint every model call depends on.
  process.on('uncaughtException', error => {
    console.error(`[zcode-workbuddy-connect] uncaught: ${String(error)}`)
  })
  process.on('unhandledRejection', error => {
    console.error(`[zcode-workbuddy-connect] unhandled rejection: ${String(error)}`)
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