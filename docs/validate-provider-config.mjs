/**
 * Strict validator for ZCode's `provider_config.json`.
 *
 * ZCode parses this document with zod schemas compiled into its Electron
 * bundle, and those schemas are `.strict()`: a single unrecognised key fails
 * the WHOLE document, and the app's failure mode is to discard the entire
 * personal provider set and start from an empty one — silently breaking every
 * other provider the user had configured, with no error surfaced anywhere.
 *
 * That failure mode is why `setup` writes into a temp file and this validator
 * runs before the write lands. It mirrors the shapes read out of
 * `ZCode\resources\app.asar` -> `out/host/index.js`:
 *
 *   manualProviderModelRules[].config  (the `extractManualModelConfig` shape)
 *     enabled?
 *     properties   pick: contextWindow, supportsJsonSchemaOutput,
 *                        supportsNativeWebSearch, supportsMidConversationSystem
 *                  + inputFormat pick: supportsImage, supportsVideo, supportsPdf
 *     optionSpecs  pick: reasoningLevel
 *                  + maxOutputTokens pick: max   (map is NOT accepted here)
 *
 *   providerModelRules[].config  (the full base shape, sparse)
 *     properties: requiresMfjsToolSchema, contextWindow,
 *                 inputFormat{5 flags}, outputFormat,
 *                 supportsToolCall, supportsJsonSchemaOutput,
 *                 supportsNativeWebSearch, supportsMidConversationSystem
 *     optionSpecs: reasoningLevel{values,map}, maxOutputTokens{max,map}
 *
 * Usage:  node docs/validate-provider-config.mjs [path]
 * Exit 0 = valid, 1 = invalid (with the offending path printed).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const path = process.argv[2] ?? join(homedir(), '.zcode', 'v2', 'provider_config.json')

/** Keys accepted inside `providerModelRules[].config.properties`. */
const PROPERTY_KEYS = new Set([
  'requiresMfjsToolSchema', 'contextWindow',
  'inputFormat', 'outputFormat',
  'supportsToolCall', 'supportsJsonSchemaOutput',
  'supportsNativeWebSearch', 'supportsMidConversationSystem',
])
const INPUT_FORMAT_KEYS = new Set(['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio', 'supportsPdf'])
const OUTPUT_FORMAT_KEYS = new Set(['supportsText'])
const OPTION_SPEC_KEYS = new Set(['reasoningLevel', 'maxOutputTokens'])
const MAX_OUTPUT_TOKEN_KEYS = new Set(['max', 'map'])
const REASONING_LEVEL_KEYS = new Set(['values', 'map'])

/** The manual variant accepts only a subset of each shape. */
const CONFIG_KEYS = new Set(['enabled', 'properties', 'optionSpecs'])
const MANUAL_PROPERTY_KEYS = new Set([
  'contextWindow', 'supportsJsonSchemaOutput',
  'supportsNativeWebSearch', 'supportsMidConversationSystem', 'inputFormat',
])
const MANUAL_INPUT_FORMAT_KEYS = new Set(['supportsImage', 'supportsVideo', 'supportsPdf'])
const MANUAL_OPTION_SPEC_KEYS = new Set(['reasoningLevel', 'maxOutputTokens'])
const MANUAL_MAX_OUTPUT_TOKEN_KEYS = new Set(['max'])

const RULE_KEYS = new Set(['modelId', 'providerId', 'config'])
const PROVIDER_RULE_KEYS = new Set(['providerId', 'templateId', 'providerName', 'enabled', 'config'])
const PROVIDER_CONFIG_KEYS = new Set([
  'group', 'logo', 'access', 'api', 'builtinModelIds', 'personalModelIds', 'modelOrder', 'visibility',
])
const API_TYPES = new Set(['anthropic-messages', 'openai-chat-completions', 'openai-responses'])
const MODEL_RULE_SETS = new Set([
  'providerModelRules', 'manualProviderModelRules', 'modelRules', 'modelApiRules',
  'providerSiteRules', 'templateModelRules', 'builtinProviderModelRules',
])

const problems = []
const isObj = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(obj, allowed, where) {
  if (!isObj(obj)) return
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) problems.push(`${where}: unrecognised key "${key}" (strict schema rejects the whole document)`)
  }
}

function checkPositiveInt(value, where) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value <= 0) {
    problems.push(`${where}: must be a positive integer, got ${JSON.stringify(value)}`)
  }
}

function walkConfig(config, where, { manual }) {
  if (!isObj(config)) {
    problems.push(`${where}: must be an object`)
    return
  }
  unknownKeys(config, CONFIG_KEYS, where)
  if (config['enabled'] !== undefined && typeof config['enabled'] !== 'boolean') {
    problems.push(`${where}.enabled: must be boolean`)
  }

  const properties = config['properties']
  if (properties !== undefined) {
    unknownKeys(properties, manual ? MANUAL_PROPERTY_KEYS : PROPERTY_KEYS, `${where}.properties`)
    checkPositiveInt(properties['contextWindow'], `${where}.properties.contextWindow`)
    if (properties['inputFormat'] !== undefined) {
      unknownKeys(properties['inputFormat'], manual ? MANUAL_INPUT_FORMAT_KEYS : INPUT_FORMAT_KEYS, `${where}.properties.inputFormat`)
    }
    if (properties['outputFormat'] !== undefined) {
      unknownKeys(properties['outputFormat'], OUTPUT_FORMAT_KEYS, `${where}.properties.outputFormat`)
    }
  }

  const specs = config['optionSpecs']
  if (specs === undefined) return
  unknownKeys(specs, manual ? MANUAL_OPTION_SPEC_KEYS : OPTION_SPEC_KEYS, `${where}.optionSpecs`)
  const maxOutput = specs['maxOutputTokens']
  if (maxOutput !== undefined) {
    unknownKeys(maxOutput, manual ? MANUAL_MAX_OUTPUT_TOKEN_KEYS : MAX_OUTPUT_TOKEN_KEYS, `${where}.optionSpecs.maxOutputTokens`)
    checkPositiveInt(maxOutput['max'], `${where}.optionSpecs.maxOutputTokens.max`)
  }
  const reasoning = specs['reasoningLevel']
  if (reasoning !== undefined) {
    unknownKeys(reasoning, REASONING_LEVEL_KEYS, `${where}.optionSpecs.reasoningLevel`)
  }
}

let document
try {
  document = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.error(`INVALID — ${path}`)
  console.error(`  - not readable as JSON: ${String(error)}`)
  process.exit(1)
}

if (document['schemaVersion'] !== 1) {
  problems.push(`schemaVersion: must be 1, got ${JSON.stringify(document['schemaVersion'])}`)
}
const config = document['config']
if (!isObj(config)) {
  console.error(`INVALID — ${path}`)
  console.error('  - missing config object')
  process.exit(1)
}
unknownKeys(config, new Set(['providerOrder', 'providerConfigRules', 'modelConfigRules', 'defaultModelSelection']), 'config')

const modelConfigRules = config['modelConfigRules']
if (modelConfigRules !== undefined) {
  unknownKeys(modelConfigRules, MODEL_RULE_SETS, 'config.modelConfigRules')
  for (const setName of ['providerModelRules', 'manualProviderModelRules']) {
    const rules = modelConfigRules[setName]
    if (rules === undefined) continue
    if (!Array.isArray(rules)) {
      problems.push(`config.modelConfigRules.${setName}: must be an array`)
      continue
    }
    rules.forEach((rule, index) => {
      const where = `config.modelConfigRules.${setName}[${index}]`
      unknownKeys(rule, RULE_KEYS, where)
      if (typeof rule?.['providerId'] !== 'string') problems.push(`${where}.providerId: required string`)
      if (typeof rule?.['modelId'] !== 'string') problems.push(`${where}.modelId: required string`)
      if (rule?.['config'] !== undefined) {
        walkConfig(rule['config'], `${where}.config`, { manual: setName === 'manualProviderModelRules' })
      }
    })
  }
}

const providerRules = config['providerConfigRules']?.['providerRules']
if (providerRules !== undefined) {
  if (!Array.isArray(providerRules)) {
    problems.push('config.providerConfigRules.providerRules: must be an array')
  } else {
    providerRules.forEach((rule, index) => {
      const where = `config.providerConfigRules.providerRules[${index}]`
      unknownKeys(rule, PROVIDER_RULE_KEYS, where)
      const ruleConfig = rule?.['config']
      if (ruleConfig === undefined) return
      unknownKeys(ruleConfig, PROVIDER_CONFIG_KEYS, `${where}.config`)
      const ids = ruleConfig['personalModelIds']
      if (ids !== undefined && ids !== null && !Array.isArray(ids)) {
        problems.push(`${where}.config.personalModelIds: must be an array or null`)
      }
      const modelOrder = ruleConfig['modelOrder']
      if (modelOrder !== undefined && modelOrder !== null && !Array.isArray(modelOrder)) {
        problems.push(`${where}.config.modelOrder: must be an array or null`)
      }
      const api = ruleConfig['api']
      if (isObj(api) && typeof api['type'] === 'string' && !API_TYPES.has(api['type'])) {
        problems.push(`${where}.config.api.type: unsupported "${api['type']}"`)
      }
    })
  }
}

if (problems.length === 0) {
  const ruleCount = (modelConfigRules?.['providerModelRules']?.length ?? 0)
    + (modelConfigRules?.['manualProviderModelRules']?.length ?? 0)
  console.log(`VALID — ${path}`)
  console.log(`  providers: ${Array.isArray(providerRules) ? providerRules.length : 0}, model rules: ${ruleCount}`)
  process.exit(0)
}
console.error(`INVALID — ${path}`)
for (const problem of problems) console.error(`  - ${problem}`)
process.exit(1)
