/**
 * Loopback checks for the local OpenAI-compatible endpoint.
 *
 * Binding to 127.0.0.1 is not by itself a trust boundary: any local process,
 * and a DNS-rebinding page in a browser, can reach a loopback port. Every
 * request must therefore also name a loopback Host, and browser-sent Origins
 * must be loopback too, so a rebinding page is rejected on both counts.
 *
 * @module workbuddy-connect/loopback
 */

/** Hostname of a Host header value, with the port and IPv6 brackets removed. */
export function hostnameOfHost(host) {
  if (typeof host !== 'string' || host === '') return ''
  const trimmed = host.trim()
  // IPv6 literal: [::1]:1234 or [::1]
  const v6 = /^\[([^\]]+)\](?::\d+)?$/u.exec(trimmed)
  if (v6 !== null) return (v6[1] ?? '').toLowerCase()
  const colon = trimmed.lastIndexOf(':')
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase()
}

/** Whether a hostname names the loopback interface. */
export function hostIsLoopback(host) {
  const name = hostnameOfHost(host)
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
}

/** Whether an Origin header (absent counts as fine) is a loopback origin. */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === null || origin === '') return true
  if (typeof origin !== 'string') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  return hostIsLoopback(parsed.host)
}