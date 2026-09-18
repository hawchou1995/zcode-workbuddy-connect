/**
 * Runtime paths shared across the service. Resolved once at startup so the
 * chat hot path never re-derives them per request.
 *
 * @module workbuddy-connect/config
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Root of everything this service owns on disk.
 *
 * Deliberately outside any harness's own home: the credential copy and the
 * version caches are this service's state, and nothing here writes into the
 * WorkBuddy desktop app's files.
 */
export function defaultStateDir() {
  const fromEnv = process.env['WORKBUDDY_CONNECT_HOME']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.workbuddy-connect')
}

const state = {
  stateDir: defaultStateDir(),
  /** Fixed loopback port; 0 asks the OS for a free port. */
  port: 0,
  /** Bearer the OpenAI-compatible endpoint requires. */
  token: '',
}

/** Point the service's state (credential copy, caches) at a directory. */
export function configureStateDir(dir) {
  if (typeof dir === 'string' && dir !== '') state.stateDir = dir
}

export function stateDir() {
  return state.stateDir
}

export function configureEndpoint({ port, token } = {}) {
  if (typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535) state.port = port
  if (typeof token === 'string' && token !== '') state.token = token
}

export function endpointConfig() {
  return { port: state.port, token: state.token }
}

/** Path of the plugin-owned CN credential copy. */
export function ownAuthPath() {
  return join(state.stateDir, '.workbuddy-auth.json')
}

/** Path of the plugin-owned international credential copy. */
export function ownAuthAiPath() {
  return join(state.stateDir, '.workbuddy-ai-auth.json')
}

/** Path of the saved App-version cache. */
export function savedVersionPath() {
  return join(state.stateDir, '.workbuddy-app-version.json')
}

/** Path of the persisted endpoint settings (port and bearer). */
export function endpointPath() {
  return join(state.stateDir, 'endpoint.json')
}

/**
 * The endpoint's bearer, generated once and persisted.
 *
 * It has to be a *stable* value rather than a per-process secret: the client
 * that points at this endpoint records its bearer in its own configuration
 * file, so a token rotating on every start would break it on restart. It is
 * stored under the state directory (mode 0600) next to the credential copy,
 * and never travels upstream — the upstream credential is resolved separately
 * from the WorkBuddy auth file.
 */
export function loadToken(fallback) {
  if (state.token !== '') return state.token
  if (typeof fallback === 'string' && fallback !== '') {
    state.token = fallback
    return state.token
  }
  return ''
}

export function setToken(token) {
  if (typeof token === 'string') state.token = token
}