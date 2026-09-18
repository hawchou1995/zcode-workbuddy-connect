/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance.
 *
 * Ported from dsh-workbuddy-connect v0.5.4 (MIT, Corrine Hu), whose wire
 * behaviour is itself ported from Sliverkiss/workbuddy2api. Only the CN
 * variant is wired up here; the region gate is retained so an international
 * credential still routes to the right base URLs.
 *
 * Dependency-free: Node 18+ global fetch only.
 *
 * @module workbuddy-connect/upstream
 */

import { appUserAgent, resolveAppVersion } from './app-version.js'
import { chatUserAgent, fallbackChatIdentity, resolveChatIdentity } from './client-identity.js'

export const CN_CHAT_BASE = 'https://copilot.tencent.com'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** Shared CLI-form User-Agent for refresh and the CN catalog. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** Display name for the single synthetic row the enterprise endpoint produces. */
const enterprisePackageName = 'enterprise'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Reduce an upstream credits string to its language-neutral display form.
 * Some rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`); the unit word would pin the display to English.
 */
export function normalizeCredits(credits) {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/** Region for a login domain; an empty domain means CN. */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * Chat request headers, including the X-No-* conventions the official CLI uses.
 * `userAgent` carries the desktop identity; when absent the CLI-form UA applies.
 */
function chatHeaders(credential, userAgent) {
  return {
    ...commonHeaders(credential),
    ...(userAgent === undefined ? {} : { 'User-Agent': userAgent }),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...(credential.uid === '' || credential.uid === undefined
      ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' || credential.domain === undefined
      ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-Product': 'SaaS',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential) {
  const headers = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '' && credential.uid !== undefined) headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '' && credential.domain !== undefined) headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects
 * developer with HTTP 400 code 11128).
 */
function normalizeDeveloperRole(obj) {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isObject(message)) continue
    if (message['role'] === 'developer') message['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj['tools']
    delete obj['functions']
  }
  if (!('tool_choice' in obj)) return
  const choice = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (isObject(choice)) {
    const type = typeof choice['type'] === 'string' ? choice['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
      return
    }
    if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
      return
    }
    if (type === 'function') {
      const fn = isObject(choice['function']) ? choice['function'] : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof choice['name'] === 'string') name = choice['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
      return
    }
    delete obj['tool_choice']
    return
  }
  delete obj['tool_choice']
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice`, and rewrite `developer` messages as `system`.
 */
export function prepareChatBody(source) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (!isObject(body)) return source
  body['stream'] = true
  normalizeDeveloperRole(body)
  normalizeToolChoice(body)
  return JSON.stringify(body)
}

/**
 * The international gateway rejects a body whose first message is not
 * `system`. Prepended, never merged.
 */
export function prepareInternationalChatBody(source) {
  const prepared = prepareChatBody(source)
  let body
  try {
    body = JSON.parse(prepared)
  } catch {
    return prepared
  }
  if (!isObject(body)) return prepared
  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return prepared
  const first = messages[0]
  if (isObject(first) && first['role'] === 'system') return prepared
  body['messages'] = [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages]
  return JSON.stringify(body)
}

/** Parse the upstream `reasoning` object into a WorkBuddyModelReasoning. */
function resolveUpstreamReasoning(wrapped) {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts
  let defaultEffort
  let canDisableThinking = true
  if (isObject(rawReasoning)) {
    const rawEfforts = rawReasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter(value => typeof value === 'string' && EFFORT_VALUES.includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof rawReasoning['defaultEffort'] === 'string' && EFFORT_VALUES.includes(rawReasoning['defaultEffort'])) {
      defaultEffort = rawReasoning['defaultEffort']
    } else if (typeof rawReasoning['effort'] === 'string' && EFFORT_VALUES.includes(rawReasoning['effort'])) {
      defaultEffort = rawReasoning['effort']
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off".
    canDisableThinking = rawReasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      canDisableThinking,
    },
  }
}

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges = []
  const rawTags = wrapped['tags']
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string') continue
      const lowered = tag.toLowerCase()
      if (!lowered.startsWith(BADGE_PREFIX)) continue
      const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
      if (label !== '') badges.push(label)
    }
  }
  // A `x0.00` multiplier means the model is currently free.
  const free = credits !== undefined && /^x?0\.0+$/u.test(credits)
  return {
    billing: {
      ...(credits === undefined ? {} : { credits }),
      ...(badges.length === 0 ? {} : { badges }),
      free,
    },
  }
}

/** One JSON-envelope response from the upstream, already unwrapped. */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (!isObject(parsed)) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  return {
    code: typeof parsed['code'] === 'number' ? parsed['code'] : 0,
    msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : '',
    data: 'data' in parsed ? parsed['data'] : undefined,
    document: parsed,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value, model) {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isObject(item) || item['enabled'] !== true) return []
    const modelIds = item['modelIds']
    if (!Array.isArray(modelIds) || !modelIds.includes(model)) return []
    const schedule = item['schedule']
    const discount = item['discount']
    const badge = item['badge']
    if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return []
    // Only a replacement discount has an unambiguous display rule.
    if (discount['displayMode'] !== 'replace') return []
    const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : Number.NaN
    const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : Number.NaN
    const factor = discount['factor']
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return []
    return [{
      start,
      end,
      factor,
      label: typeof badge['label'] === 'string' ? badge['label'] : '',
      priority: typeof item['priority'] === 'number' && Number.isFinite(item['priority']) ? item['priority'] : 0,
    }]
  })
}

/**
 * Re-evaluate a model's promotion against the current time. Frozen at parse
 * time, a cached "Free now" would keep claiming a discount after `validUntil`
 * had passed.
 */
export function modelWithCurrentPromotion(model, now = Date.now()) {
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    // The upstream bakes the discounted value into `credits`, so a stale row
    // advertises a discount that has ended. The original price is not
    // recoverable, so stop asserting one rather than keep claiming "free".
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    return { ...model, billing: { free: false, rateUnknown: true } }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: [...(model.billing?.badges ?? []), ...(promotion.label === '' ? [] : [promotion.label])],
    },
  }
}

/** Parse a catalog document into the CLI's model roster, in upstream order. */
export function parseModelCatalog(data, international = false) {
  const rawModels = Array.isArray(data['models']) ? data['models'] : []
  const agents = Array.isArray(data['agents']) ? data['agents'] : []
  let cliIds
  for (const agent of agents) {
    if (isObject(agent) && agent['name'] === 'cli' && Array.isArray(agent['models'])) {
      cliIds = agent['models'].filter(id => typeof id === 'string')
      break
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('workbuddy model catalog lists no cli agent models')
  }
  const byId = new Map()
  for (const model of rawModels) {
    if (!isObject(model)) continue
    const id = typeof model['id'] === 'string' ? model['id'] : ''
    if (id === '' || model['disabled'] === true) continue
    const input = typeof model['maxInputTokens'] === 'number' ? model['maxInputTokens'] : 0
    const output = typeof model['maxOutputTokens'] === 'number' ? model['maxOutputTokens'] : 0
    if (input <= 0 || output <= 0) continue
    byId.set(id, {
      id,
      name: typeof model['name'] === 'string' && model['name'] !== '' ? model['name'] : id,
      // Window: `contextWindow.defaultLength` is a soft default, not a cap.
      // Live-verified 2026-09-18 against the international gateway: a
      // 312,856-token prompt was accepted, while 1,294,869 tokens was rejected
      // with "> 1048576 maximum" — so `maxInputTokens` is the honest ceiling and
      // the default understated it (deepseek-v4.1-flash read 300K, gpt-6-astra
      // 400K, hy4-preview 200K). Declaring the default made ZCode compact early
      // and waste the window. `defaultContextWindow` keeps the default for
      // display. Do not switch this back to `defaultLength`.
      contextWindow: input,
      ...(international ? {
        ...(isObject(model['contextWindow']) && positive(model['contextWindow']['defaultLength'])
          ? { defaultContextWindow: model['contextWindow']['defaultLength'] } : {}),
        maxInputTokens: input,
        supportedContextWindows: isObject(model['contextWindow']) && Array.isArray(model['contextWindow']['supportedLengths'])
          ? model['contextWindow']['supportedLengths'].filter(positive) : [],
        promotions: parsePromotions(data['modelPromotions'], id),
      } : {}),
      maxTokens: output,
      supportsImages: model['supportsImages'] === true && model['disabledMultimodal'] !== true,
      ...resolveUpstreamReasoning(model),
      ...resolveUpstreamBilling(model),
    })
  }
  const models = cliIds.map(id => byId.get(id)).filter(model => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}

/** Normalize the CN personal credits document. */
function normalizeCreditsDocument(data) {
  const rawAccounts = Array.isArray(data['Accounts']) ? data['Accounts']
    : Array.isArray(data['accounts']) ? data['accounts'] : []
  const accounts = rawAccounts.flatMap(account => {
    if (!isObject(account)) return []
    const remain = typeof account['remain'] === 'number' ? account['remain'] : 0
    const size = typeof account['size'] === 'number' ? account['size'] : 0
    const unlimited = account['unlimited'] === true
    return [{
      packageName: typeof account['packageName'] === 'string' ? account['packageName'] : enterprisePackageName,
      remain: Number.isFinite(remain) ? Math.max(remain, 0) : 0,
      size: Number.isFinite(size) ? Math.max(size, 0) : 0,
      ...(unlimited ? { unlimited: true } : {}),
    }]
  })
  return {
    total: accounts.reduce((sum, account) => sum + account.remain, 0),
    accounts,
  }
}

/**
 * Upstream HTTP client. One instance serves the whole process; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  constructor(options = {}) {
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
    this.resolveChatIdentity = options.resolveChatIdentity ?? (region => resolveChatIdentity(region))
    /** Provenance of the most recent successful catalog fetch. */
    this.lastCatalog = undefined
  }

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(credential, bodyJson, signal) {
    const region = regionOf(credential.domain)
    // Identity resolution must never block a message: any failure degrades to
    // the desktop fallback form, never to the legacy CLI UA.
    let userAgent
    try {
      userAgent = chatUserAgent(await this.resolveChatIdentity(region), region)
    } catch {
      userAgent = chatUserAgent(fallbackChatIdentity(region), region)
    }
    let response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential, userAgent), 'Authorization': `Bearer ${credential.accessToken}` },
        body: region === 'global' ? prepareInternationalChatBody(bodyJson) : bodyJson,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = isObject(envelope.data) ? envelope.data : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * GET the personal catalog.
   *
   * UA discipline per region (live-verified 2026-09-18): the international
   * gateway (`/v3/config`) REJECTS the App-shaped UA with HTTP 400 code 12403
   * ("check ua, get coding copilot version error") and requires the CLI-form
   * UA; the CN endpoint is indifferent but has always used the CLI UA. The
   * upstream plugin's assumption that `/v3/config` needs the App UA is wrong
   * on today's wire — keep this CLI UA unless a live probe says otherwise.
   */
  async fetchModels(credential, signal) {
    const international = regionOf(credential.domain) === 'global'
    const url = `${chatBase(credential)}${international ? '/v3/config' : '/console/enterprises/personal/models'}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...(international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {}),
        'User-Agent': CLIENT_UA,
      },
      signal: signal === undefined
        ? AbortSignal.timeout(JSON_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    // The CN endpoint always wraps in `{code,msg,data}`; `/v3/config` has also
    // been observed answering with the product document bare.
    const data = isObject(envelope.data) ? envelope.data
      : ('models' in envelope.document || 'agents' in envelope.document) ? envelope.document
      : {}
    const models = parseModelCatalog(data, international)
    this.lastCatalog = {
      fetchedAtMs: Date.now(),
      source: international ? 'workbuddy-ai:cli' : 'workbuddy:cli',
    }
    return models
  }

  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * CN enterprise accounts (`enterpriseId` non-empty) ask the enterprise
   * endpoint, which answers with a single cycle quota; the personal endpoint
   * serves them an empty Accounts list, which reads as "0 credit".
   */
  async fetchCredits(credential) {
    if (regionOf(credential.domain) === 'cn'
      && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      return await this.fetchEnterpriseCredits(credential)
    }
    const now = new Date()
    const format = date => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({ startTime: format(new Date(now.getFullYear(), now.getMonth(), 1)), endTime: format(now) }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    return normalizeCreditsDocument(isObject(envelope.data) ? envelope.data : {})
  }

  /** The CN enterprise cycle-quota endpoint. */
  async fetchEnterpriseCredits(credential) {
    const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = isObject(envelope.data) ? envelope.data : {}
    const limitNum = typeof data['limitNum'] === 'number' ? data['limitNum'] : 0
    // The enterprise endpoint reports one cycle quota, not the personal
    // endpoint's list of named packages.
    if (limitNum === -1) {
      return {
        total: 0,
        accounts: [{ packageName: enterprisePackageName, remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...(typeof data['cycleResetTime'] === 'string' ? { cycleResetTime: data['cycleResetTime'] } : {}),
      }
    }
    const used = typeof data['usedNum'] === 'number' ? data['usedNum'] : 0
    const remain = Math.max(limitNum - used, 0)
    return {
      total: remain,
      accounts: [{ packageName: enterprisePackageName, remain, size: Math.max(limitNum, 0) }],
      ...(typeof data['cycleResetTime'] === 'string' ? { cycleResetTime: data['cycleResetTime'] } : {}),
    }
  }
}