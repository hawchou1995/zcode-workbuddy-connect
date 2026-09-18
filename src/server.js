/**
 * Loopback OpenAI-compatible endpoint.
 *
 * A client points an `openai-chat-completions` provider at this server; the
 * server applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, desktop-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process, and a DNS-rebinding page, can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization header
 * must carry this server's configured bearer.
 *
 * @module zcode-workbuddy-connect/server
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { hostIsLoopback, originIsLoopback } from './loopback.js'
import { prepareChatBody, WorkBuddyUpstreamClient } from './upstream.js'

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const CATALOG_REFRESH_MS = 30 * 60 * 1000
/** SSE comment cadence during upstream silence, well under any read timeout. */
const HEARTBEAT_MS = 10_000

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isJsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** Constant-time bearer check; absent or mismatched bearers are rejected. */
function bearerOk(req, expected) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  const a = Buffer.from(match[1])
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Buffer an upstream SSE stream into one non-streaming completion.
 *
 * The upstream rejects `stream: false` outright, so a client that asked for a
 * single JSON answer is served by consuming the stream here and reassembling
 * it. Content, tool-call fragments and reasoning are all merged by index,
 * matching the OpenAI chunking shape.
 */
async function collectCompletion(body, model) {
  const text = await new Response(body).text()
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage
  let id = `chatcmpl-${Date.now()}`
  const toolCalls = new Map()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) usage = chunk['usage']
    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (choice === undefined) continue
    if (typeof choice['finish_reason'] === 'string' && choice['finish_reason'] !== '') {
      finishReason = choice['finish_reason']
    }
    const delta = choice['delta']
    if (typeof delta !== 'object' || delta === null) continue
    if (typeof delta['content'] === 'string') content += delta['content']
    if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content']
    if (Array.isArray(delta['tool_calls'])) mergeToolCalls(toolCalls, delta['tool_calls'])
  }

  const message = { role: 'assistant', content: content === '' ? null : content }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  if (toolCalls.size > 0) {
    message['tool_calls'] = completeToolCalls(toolCalls).map(call => ({
      id: call.id,
      type: call.type,
      function: call.function,
    }))
    if (finishReason === 'stop' || finishReason === 'function_call') finishReason = 'tool_calls'
  }
  const completion = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage !== undefined) completion['usage'] = usage
  return completion
}

/**
 * Merge upstream tool-call fragments into complete calls.
 *
 * The upstream streams arguments in ~5-character pieces and is *not*
 * idempotent about the fields around them: `id`, `type` and `function.name`
 * appear in the FIRST fragment only, and every later fragment omits them while
 * repeating `index`. A client that appends per chunk the obvious way therefore
 * ends up with a nameless, id-less call. Fragments are keyed by `index` and
 * merged here instead, so the caller sees one complete call per index.
 */
function mergeToolCalls(accumulator, fragments) {
  for (const call of fragments) {
    if (typeof call !== 'object' || call === null) continue
    const index = typeof call['index'] === 'number' ? call['index'] : 0
    const existing = accumulator.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof call['id'] === 'string' && call['id'] !== '') existing.id = call['id']
    const fn = call['function']
    if (typeof fn === 'object' && fn !== null) {
      if (typeof fn['name'] === 'string' && fn['name'] !== '') existing.name = fn['name']
      if (typeof fn['arguments'] === 'string') existing.arguments += fn['arguments']
    }
    accumulator.set(index, existing)
  }
}

function completeToolCalls(accumulator) {
  return [...accumulator.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      index,
      id: call.id === '' ? `call_${Math.random().toString(36).slice(2, 11)}` : call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
}

/**
 * Proxy an upstream SSE stream into clean OpenAI chunks.
 *
 * Content and `reasoning_content` deltas are forwarded immediately so the
 * caller streams token-by-token; tool-call fragments are buffered and emitted
 * once as complete calls (see {@link mergeToolCalls}); usage and finish
 * reasons pass through unchanged.
 *
 * Heartbeats: reasoning models can think for minutes before emitting a single
 * token, and the upstream pads that silence with SSE comment lines. Comments
 * are not forwarded (they carry nothing), but the silence must not be passed
 * on either — a client whose read timeout is shorter than the thinking time
 * would abort a request that is still working. An SSE comment is emitted
 * locally every {@link HEARTBEAT_MS} of silence instead: every SSE client
 * ignores comment lines, so this keeps intermediaries and read timers alive
 * without inventing protocol events.
 */
function createStreamNormalizer(res, fallbackModel) {
  const pending = new Map()
  let model = fallbackModel
  let id = `chatcmpl-${Date.now()}`
  let created = Math.floor(Date.now() / 1000)
  let toolCallsSent = false
  let done = false
  /**
   * Whether the terminal block has already been emitted.
   *
   * The upstream repeats the finish event — observed sending
   * `finish_reason: "tool_calls"`, then a legacy `function_call` row, then
   * `tool_calls` again for one response. Emitting the accumulated call on each
   * of those would hand the client the same tool call three times, and a client
   * that merges fragments by index would concatenate three copies of the
   * arguments into invalid JSON.
   */
  let settled = false
  let heartbeat

  const bumpHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (res.writable && !done) res.write(': heartbeat\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const write = payload => {
    if (!res.writable || done) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  bumpHeartbeat()

  const emitToolCallsAndFinish = finishReason => {
    if (settled) return
    settled = true
    const calls = completeToolCalls(pending)
    if (calls.length > 0) {
      toolCallsSent = true
      write({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: null }],
      })
    }
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })
  }

  /** Handle one parsed upstream chunk. Returns true once the stream is spent. */
  const onChunk = chunk => {
    if (typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
    if (typeof chunk['model'] === 'string' && chunk['model'] !== '') model = chunk['model']
    if (typeof chunk['created'] === 'number') created = chunk['created']

    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (choice === undefined) {
      // A usage-only chunk carries no choices; forward it as-is.
      if (chunk['usage'] !== undefined && chunk['usage'] !== null) write(chunk)
      return false
    }
    const delta = choice['delta']
    const finishReason = choice['finish_reason']

    if (typeof delta === 'object' && delta !== null) {
      if (Array.isArray(delta['tool_calls'])) mergeToolCalls(pending, delta['tool_calls'])
      const carry = {}
      if (typeof delta['content'] === 'string' && delta['content'] !== '') carry['content'] = delta['content']
      if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
        carry['reasoning_content'] = delta['reasoning_content']
      }
      if (Object.keys(carry).length > 0) {
        write({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', ...carry }, finish_reason: null }],
        })
      }
    }

    // The final chunk normally carries the usage totals; forward them so the
    // client can account for the call.
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
      write({ ...chunk, id, model })
    }

    if (typeof finishReason === 'string' && finishReason !== '') {
      // `function_call` is a legacy sibling with no id and no name of its own;
      // when the real tool_calls were already emitted it is redundant.
      emitToolCallsAndFinish(finishReason === 'function_call' && toolCallsSent ? 'tool_calls' : finishReason)
      // Stop reading on the first finish event: everything after it is the
      // upstream repeating itself, and holding the connection open while it
      // does keeps the request alive for no benefit.
      return true
    }
    return false
  }

  return {
    push(text) {
      let sawEnd = false
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          sawEnd = true
          continue
        }
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (onChunk(chunk)) sawEnd = true
      }
      return sawEnd
    },
    /** Finish the response: close any dangling tool calls, then terminate. */
    end() {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (done) return
      if (pending.size > 0) emitToolCallsAndFinish('tool_calls')
      done = true
      if (res.writable) res.end('data: [DONE]\n\n')
    },
    /** Stop the heartbeat without ending the response (client went away). */
    dispose() {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      done = true
    },
  }
}

/**
 * Start the endpoint.
 *
 * @param {object} options
 * @param {import('./auth.js').WorkBuddyCredentialStore} options.store
 * @param {import('./catalog.js').WorkBuddyCatalog} options.catalog
 * @param {string} options.token bearer this endpoint requires
 * @param {number} [options.port] fixed port; 0 (default) asks the OS
 * @param {object} [options.logger]
 */
export function createWorkBuddyServer(options) {
  const { token } = options
  const port = options.port ?? 0
  const logger = options.logger ?? console
  const client = options.client ?? new WorkBuddyUpstreamClient()
  /**
   * Variant registry. Each entry: { id, path, prefix, store, catalog }.
   *
   * The two regions share model ids (glm-5.3, hy3, deepseek-v4.1-flash…) but
   * bill against separate accounts, so one id cannot stand for both. The region
   * therefore travels in the URL path rather than in the model id: the root
   * serves the default variant and `/ai/…` the international one, which keeps
   * the ids a client displays clean. `prefix` is the legacy disambiguator, still
   * accepted on a chat request so configurations written before the split keep
   * routing correctly.
   */
  const variants = options.variants ?? [{ id: 'cn', path: '', prefix: '', store: options.store, catalog: options.catalog }]

  let lastCredits = new Map()
  let lastCatalogError = new Map()
  let lastRefreshAtMs = new Map()

  /** The variant a request path is mounted under; the longest mount wins. */
  function variantForPath(pathname) {
    let best
    for (const v of variants) {
      const mount = v.path ?? ''
      if (mount === '') continue
      if (pathname !== mount && !pathname.startsWith(`${mount}/`)) continue
      if (best === undefined || mount.length > (best.path ?? '').length) best = v
    }
    return best
  }

  /** The variant served at the root, which is what a bare `/v1` addresses. */
  function defaultVariant() {
    return variants.find(v => (v.path ?? '') === '') ?? variants[0]
  }

  /**
   * Legacy route: a model id carrying a variant's old `wbai:` prefix names its
   * region outright. Returns undefined when the id carries no known prefix.
   */
  function variantForPrefix(modelId) {
    for (const v of variants) {
      const prefix = v.prefix ?? ''
      if (prefix !== '' && modelId.startsWith(prefix)) {
        return { variant: v, modelId: modelId.slice(prefix.length) }
      }
    }
    return undefined
  }

  /**
   * Pull the live roster for every variant and gate visibility on having a
   * usable credential.
   *
   * The gate is load-bearing: a signed-out account must expose *no* models.
   * Serving the fallback roster to a signed-out user offers models that can
   * only fail, which is worse than showing nothing.
   */
  async function refreshCatalog() {
    const results = []
    for (const variant of variants) {
      const { catalog } = variant
      try {
        const credential = await variant.store.resolve()
        catalog.setVisible(true)
        const models = await client.fetchModels(credential)
        catalog.set(models, { source: client.lastCatalog?.source, fetchedAtMs: client.lastCatalog?.fetchedAtMs })
        lastCatalogError.set(variant.id, undefined)
        lastRefreshAtMs.set(variant.id, Date.now())
        logger.log(`[workbuddy] ${variant.id} catalog refreshed: ${models.length} models (${catalog.source})`)
        try {
          lastCredits.set(variant.id, await client.fetchCredits(credential))
        } catch (error) {
          logger.warn(`[workbuddy] ${variant.id} credit lookup failed: ${String(error)}`)
        }
        results.push({ variant: variant.id, ok: true, count: models.length })
      } catch (error) {
        // No credential: hide the roster rather than advertise unusable models.
        catalog.setVisible(false)
        lastCatalogError.set(variant.id, error instanceof Error ? error.message : String(error))
        logger.warn(`[workbuddy] ${variant.id} catalog unavailable: ${lastCatalogError.get(variant.id)}`)
        results.push({ variant: variant.id, ok: false, error: lastCatalogError.get(variant.id) })
      }
    }
    return { ok: results.some(r => r.ok), results }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error))
      else res.end()
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  async function handle(req, res) {
    // Every request must name the loopback host, and browser-sent origins must
    // be loopback too. A DNS-rebinding page satisfies neither.
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(req, token)) {
      writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }
    const url = (req.url ?? '/').split('?')[0]
    // A variant mount is stripped before routing, so `/ai/v1/chat/completions`
    // reaches the same handler as `/v1/chat/completions` with the AI variant
    // selected. Every route honours a mount, management routes included.
    const scoped = variantForPath(url)
    const stripped = url.slice(scoped === undefined ? 0 : (scoped.path ?? '').length)
    const path = stripped === '' ? '/' : stripped

    if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
      writeJson(res, 200, {
        ok: true,
        models: variants.reduce((sum, v) => sum + v.catalog.current().length, 0),
        variants: variants.map(v => ({ id: v.id, models: v.catalog.current().length, source: v.catalog.source, visible: v.catalog.isVisible() })),
      })
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
      // Scoped to the mount: `/ai/v1/models` answers with the international
      // roster under its own clean ids. The aggregate view lives at /healthz
      // and /v1/status, which report every variant.
      const listed = scoped === undefined ? [defaultVariant()] : [scoped]
      writeJson(res, 200, {
        object: 'list',
        data: listed.flatMap(variant => variant.catalog.current().map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: `workbuddy-${variant.id}`,
          // Non-standard extras: harmless to a strict client, and the only way
          // a caller can learn the real window and vision support before it
          // sends a message the upstream would reject.
          context_window: model.contextWindow,
          max_output_tokens: model.maxTokens,
          supports_images: model.supportsImages,
          display_name: model.name,
        }))),
      })
      return
    }
    if (req.method === 'POST' && (path === '/v1/refresh' || path === '/v1/refresh/')) {
      const result = await refreshCatalog()
      writeJson(res, result.ok ? 200 : 503, result)
      return
    }
    if (req.method === 'GET' && (path === '/v1/status' || path === '/v1/status/')) {
      const statuses = await Promise.all(variants.map(async variant => ({
        variant: variant.id,
        auth: await variant.store.status(),
        credits: lastCredits.get(variant.id),
        catalog: {
          source: variant.catalog.source,
          visible: variant.catalog.isVisible(),
          count: variant.catalog.current().length,
          fetchedAtMs: variant.catalog.fetchedAtMs,
          lastRefreshAtMs: lastRefreshAtMs.get(variant.id),
          error: lastCatalogError.get(variant.id),
        },
      })))
      writeJson(res, 200, { variants: statuses })
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
      await chatCompletions(req, res, scoped)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res, scoped) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    let wantsStream = true
    let model = 'workbuddy'
    try {
      const parsed = JSON.parse(raw)
      wantsStream = parsed?.['stream'] !== false
      if (typeof parsed?.['model'] === 'string') model = parsed['model']
    } catch {
      // prepareChatBody tolerates a non-JSON body; treat it as asking to stream.
    }

    // The region comes from the mount the request arrived on. A legacy `wbai:`
    // prefix on the id still names it outright and wins, so configurations
    // written before the split keep routing correctly. Rewriting the model
    // field textually (rather than re-serialising the parsed body) keeps every
    // other field byte-identical to what the client sent.
    const legacy = variantForPrefix(model)
    const variant = legacy === undefined ? (scoped ?? defaultVariant()) : legacy.variant
    const upstreamModel = legacy === undefined ? model : legacy.modelId
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const routed = upstreamModel === model
      ? raw
      : raw.replace(new RegExp(`("model"\\s*:\\s*")${escaped}"`), `$1${upstreamModel}"`)

    let credential
    try {
      credential = await variant.store.resolve()
    } catch (error) {
      writeOpenAIError(res, 401, 'not_signed_in', `${variant.id}: ${String(error)}`)
      return
    }
    const prepared = prepareChatBody(routed)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      const kind = KIND_STATUS[result.kind] === undefined ? 'server' : result.kind
      writeOpenAIError(
        res,
        KIND_STATUS[kind],
        result.kind,
        `workbuddy upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`,
      )
      return
    }

    if (!wantsStream) {
      // The upstream always streams; reassemble for a client that asked for one
      // JSON answer. Errors are surfaced as a real 502 rather than a 200 with an
      // empty body, because a silent empty completion is indistinguishable from
      // a model that chose to say nothing.
      try {
        const completion = await collectCompletion(result.response.body, model)
        writeJson(res, 200, completion)
      } catch (error) {
        writeOpenAIError(res, 502, 'upstream_stream_failed', String(error))
      }
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const normalizer = createStreamNormalizer(res, model)
    const decoder = new TextDecoder()
    const reader = result.response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (normalizer.push(decoder.decode(value, { stream: true }))) break
      }
      normalizer.end()
    } catch (error) {
      logger.warn(`[workbuddy] upstream stream failed mid-flight: ${String(error)}`)
      // Always close the SSE stream properly: a client left waiting for a
      // terminator that never arrives hangs the whole conversation.
      normalizer.end()
    } finally {
      normalizer.dispose()
    }
  }

  let refreshTimer

  return {
    ready,
    port: () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('workbuddy server has no listening address')
      return address.port
    },
    baseUrl: () => `http://127.0.0.1:${(() => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('workbuddy server has no listening address')
      return address.port
    })()}`,
    refreshCatalog,
    credits: () => lastCredits,
    client,
    start({ listen = true } = {}) {
      if (listen) server.listen(port, '127.0.0.1')
      void refreshCatalog().then(() => {
        refreshTimer = setInterval(() => void refreshCatalog(), CATALOG_REFRESH_MS)
        refreshTimer.unref?.()
      })
      return ready
    },
    close: () => new Promise((resolve, reject) => {
      if (refreshTimer !== undefined) clearInterval(refreshTimer)
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}