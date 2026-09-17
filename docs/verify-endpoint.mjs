/**
 * End-to-end verification of the workbuddy-connect endpoint.
 *
 * Run against a live endpoint:   node docs/verify-endpoint.mjs
 * Requires the service to be up on :39271 (node bin/cli.mjs serve).
 *
 * Covers the four failure modes that mattered during the port: stream
 * termination (a missing [DONE] hangs the client), tool-call reassembly (the
 * upstream sends id and name only on the first fragment), non-streaming
 * fallback (the upstream rejects stream:false), and schema-valid JSON.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const stateDir = process.env['WORKBUDDY_CONNECT_HOME'] ?? join(homedir(), '.workbuddy-connect')
const token = JSON.parse(await readFile(join(stateDir, 'endpoint.json'), 'utf8')).token
const BASE = process.env['WORKBUDDY_CONNECT_BASE'] ?? 'http://127.0.0.1:39271/v1'
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

/** POST and consume the SSE stream, reporting the first-byte latency. */
async function stream(body) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  if (r.status !== 200) {
    const text = await r.text()
    return { status: r.status, error: text.slice(0, 300) }
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let firstByte = null, sawDone = false, sawHeartbeat = false
  let text = '', reasoning = '', finish = null
  const calls = []
  let usage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByte === null) firstByte = Date.now() - t0
    for (const line of dec.decode(value, { stream: true }).split('\n')) {
      const t = line.trim()
      if (t.startsWith(':') && t.toLowerCase().includes('heartbeat')) { sawHeartbeat = true; continue }
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p === '') continue
      if (p === '[DONE]') { sawDone = true; continue }
      let j; try { j = JSON.parse(p) } catch { continue }
      if (j.usage) usage = j.usage
      const ch = j.choices?.[0]
      if (!ch) continue
      if (ch.finish_reason) finish = ch.finish_reason
      const d = ch.delta
      if (!d) continue
      if (typeof d.content === 'string') text += d.content
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      if (Array.isArray(d.tool_calls)) calls.push(...d.tool_calls)
    }
  }
  // Merge tool-call fragments by index, exactly as a real OpenAI client does:
  // id and name arrive on the first fragment, arguments accumulate after.
  const byIndex = new Map()
  for (const c of calls) {
    const i = typeof c.index === 'number' ? c.index : 0
    const acc = byIndex.get(i) ?? { id: '', name: '', arguments: '' }
    if (typeof c.id === 'string' && c.id !== '') acc.id = c.id
    const fn = c.function
    if (fn) {
      if (typeof fn.name === 'string' && fn.name !== '') acc.name = fn.name
      if (typeof fn.arguments === 'string') acc.arguments += fn.arguments
    }
    byIndex.set(i, acc)
  }
  return {
    status: 200, firstByte, total: Date.now() - t0, sawDone, sawHeartbeat, text, reasoning, finish, usage,
    rawChunks: calls.length,
    calls: [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, function: { name: v.name, arguments: v.arguments } })),
  }
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string' } }, required: ['city'] },
  },
}]

console.log('=== 1. streaming text ===')
{
  const r = await stream({ model: 'hy3', stream: true, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] })
  check('HTTP 200', r.status === 200, r.status === 200 ? `firstByte ${r.firstByte}ms, total ${r.total}ms` : r.error)
  check('terminated with [DONE]', r.sawDone === true)
  check('content received', (r.text ?? '').trim().length > 0, JSON.stringify((r.text ?? '').trim().slice(0, 40)))
  check('finish_reason stop', r.finish === 'stop', JSON.stringify(r.finish))
  check('usage reported', r.usage != null, `${r.usage?.total_tokens} tokens`)
}

console.log('\n=== 2. streaming tool call (id + name must survive) ===')
{
  const r = await stream({
    model: 'hy3', stream: true, tool_choice: 'get_weather', tools: TOOLS,
    messages: [
      { role: 'system', content: 'You must call the provided tool.' },
      { role: 'user', content: 'What is the weather in Shanghai in celsius?' },
    ],
  })
  check('HTTP 200', r.status === 200, r.status === 200 ? `firstByte ${r.firstByte}ms` : r.error)
  check('finish_reason is tool_calls', r.finish === 'tool_calls', JSON.stringify(r.finish))
  check('exactly one assembled call', r.calls.length === 1, `${r.calls.length} call(s) from ${r.rawChunks} chunk(s)`)
  const c = r.calls[0]
  check('call has an upstream id', typeof c?.id === 'string' && c.id.length > 0, JSON.stringify(c?.id))
  check('call has the function name', c?.function?.name === 'get_weather', JSON.stringify(c?.function?.name))
  let args = null
  try { args = JSON.parse(c?.function?.arguments ?? '') } catch {}
  check('arguments are complete JSON', args !== null, c?.function?.arguments)
  check('arguments carry the city', args?.city === 'Shanghai', JSON.stringify(args))
}

console.log('\n=== 3. non-streaming ===')
{
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'hy3', stream: false, messages: [{ role: 'user', content: 'Reply with exactly: JSONOK' }] }),
  })
  const j = await r.json()
  check('HTTP 200', r.status === 200, r.status === 200 ? '' : JSON.stringify(j).slice(0, 200))
  check('object is chat.completion', j.object === 'chat.completion', j.object)
  check('message content present', typeof j.choices?.[0]?.message?.content === 'string' && j.choices[0].message.content.trim().length > 0,
    JSON.stringify(j.choices?.[0]?.message?.content?.trim()?.slice(0, 30)))
  check('usage reported', j.usage != null, `${j.usage?.total_tokens} tokens`)
}

console.log('\n=== 4. non-streaming tool call ===')
{
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'hy3', stream: false, tool_choice: 'get_weather', tools: TOOLS,
      messages: [
        { role: 'system', content: 'You must call the provided tool.' },
        { role: 'user', content: 'What is the weather in Beijing?' },
      ],
    }),
  })
  const j = await r.json()
  const tc = j.choices?.[0]?.message?.tool_calls
  check('tool_calls present', Array.isArray(tc) && tc.length === 1, `${tc?.length}`)
  check('tool name correct', tc?.[0]?.function?.name === 'get_weather', JSON.stringify(tc?.[0]?.function?.name))
  check('finish_reason tool_calls', j.choices?.[0]?.finish_reason === 'tool_calls', j.choices?.[0]?.finish_reason)
  let args = null
  try { args = JSON.parse(tc?.[0]?.function?.arguments ?? '') } catch {}
  check('arguments parse', args !== null, JSON.stringify(args))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1