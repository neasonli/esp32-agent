/**
 * W1 数据桥 · events-bridge assistant/chunk 桥接 spike（不经内核 / 不经 HTTP / 不建真实 DSH agent）
 *
 * 直接向 cordis ctx 发 session/event（事件形状与 dsh-session publish 一致），让
 * events-bridge 自身串行链处理，验证（对照 events-bridge.ts W1 数据桥改动）：
 * 1. text-delta 按 FLUSH_CHARS=24 聚合 → 多条 assistant/chunk（payload.delta 拼接 == 全文）
 * 2. reasoning-delta / tool-call-delta 不外发
 * 3. turn/step 切换 → < 阈值残留先强制 flush（尾巴不丢）
 * 4. assistant/message 前强制 flush 残余 → chunk 事件先于 assistant/message 落库
 * 5. tool/call 与 tool/result payload 含 callId；turn/start payload 含 turn
 *
 * 运行：node --import tsx/esm scripts/spike-events-chunk.mts（cwd = DSH checkout，同既有 spike）
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { apply as eventsBridge } from '../src/plugins/events-bridge.ts'
import type { SessionRegistry } from '../src/sessions.ts'
import { SessionRegistry as RegistryImpl } from '../src/sessions.ts'

interface RecordedEvent {
  level: string
  message: string
  node: string
  event_type: string
  payload?: Record<string, unknown> | null
}
interface RecordedMessage {
  role: string
  content: string
  tool_name: string
  tool_call_id: string
}

const recordedEvents: RecordedEvent[] = []
const recordedMessages: RecordedMessage[] = []
let sessionIdValue = ''

const client = {
  addEvent: async (_t: string, level: string, message: string, node = '', eventType = '', payload?: Record<string, unknown> | null) => {
    recordedEvents.push({ level, message, node, event_type: eventType, payload: payload ?? null })
  },
  appendChatMessage: async (_s: string, role: string, content: string, toolName = '', toolCallId = '') => {
    recordedMessages.push({ role, content, tool_name: toolName, tool_call_id: toolCallId })
  },
  gitCheckpoint: async () => ({}),
} as never

const ctx = new Context()
await ctx.plugin(Timer)
const registry: SessionRegistry = new RegistryImpl()
eventsBridge(ctx, { client: client as never, registry })

// 桩会话：events-bridge 只用 session.id；避免真实 DSH surface 校验
const fakeSession = {
  id: { value: `chunk-spike-${Date.now()}`, toString() { return this.value } },
  toString() { return this.id.value },
}
sessionIdValue = String(fakeSession.id)
const emit = (type: string, data: Record<string, unknown>): void => {
  ctx.emit('session/event' as never, fakeSession, { type, data })
}

const trace = (label: string): void => console.error(`[events-chunk-spike] ${label}`)
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 60))
const chunkEv = (turn: number, step: number, chunk: Record<string, unknown>): Promise<void> =>
  emit('assistant/chunk', { turn, step, chunk })

// ---- 1+2+3. 聚合 + 不外发 + step 切换强 flush ----
await emit('turn/start', { turn: 1 })
await chunkEv(1, 1, { type: 'block-start', index: 0, blockType: 'text' })
const text = '你好，这是第一段被聚合的打字机文本，用于验证阈值与拼接。' // ~28 chars
for (const piece of text.split('')) await chunkEv(1, 1, { type: 'text-delta', index: 0, text: piece })
await chunkEv(1, 1, { type: 'reasoning-delta', index: 1, text: '这是一段思考，不应外发。' })
await chunkEv(1, 1, { type: 'tool-call-delta', index: 2, id: 'call-x', name: 'read_file', argumentsDelta: '{"p":' })
// step=2 触发切换：残留 '尾'（< 阈值）应被强制 flush
await chunkEv(1, 2, { type: 'text-delta', index: 3, text: '尾' })
// ---- 4. assistant/message 定型 ----
await emit('assistant/message', {
  message: { role: 'assistant', content: [{ type: 'text', text: text + '尾' }], source: { kind: 'plugin', plugin: 'x' } },
})
// ---- 5. tool/call + tool/result ----
await emit('tool/call', { callId: 'call-1', name: 'build', arguments: { dir: '.' } })
await emit('tool/result', {
  message: {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '→ Build ok' }], isError: false }],
    source: { kind: 'plugin', plugin: 'x' },
  },
})
await emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
await drain()

const chunkEvents = recordedEvents.filter((e) => e.event_type === 'assistant/chunk')
const joinedDelta = chunkEvents.map((e) => String((e.payload as { delta?: unknown } | null)?.delta ?? '')).join('')
trace(`assistant/chunk 条数=${chunkEvents.length} 拼接=${JSON.stringify(joinedDelta)}`)
if (chunkEvents.length < 2) throw new Error('CHUNK_FAIL 聚合后条数过少')
if (joinedDelta !== text + '尾') throw new Error(`CHUNK_FAIL 拼接不一致: ${joinedDelta}`)

const asstMsg = recordedEvents.find((e) => e.event_type === 'assistant/message')
if (asstMsg === undefined) throw new Error('CHUNK_FAIL 缺 assistant/message 事件')
const lastChunkSeq = chunkEvents.at(-1)
if (recordedEvents.indexOf(asstMsg) < recordedEvents.indexOf(lastChunkSeq!)) {
  throw new Error('CHUNK_FAIL assistant/message 未在 chunk 之后')
}

const tc = recordedEvents.find((e) => e.event_type === 'tool/call')
const tr = recordedEvents.find((e) => e.event_type === 'tool/result')
const ts = recordedEvents.find((e) => e.event_type === 'turn/start')
if ((tc?.payload as { callId?: string } | null)?.callId !== 'call-1') throw new Error('CHUNK_FAIL tool/call 缺 callId')
if ((tr?.payload as { callId?: string } | null)?.callId !== 'call-1') throw new Error('CHUNK_FAIL tool/result 缺 callId')
if ((ts?.payload as { turn?: number } | null)?.turn !== 1) throw new Error('CHUNK_FAIL turn/start 缺 turn')

const toolMsgs = recordedMessages.filter((m) => m.role === 'tool')
if (toolMsgs.length !== 1 || toolMsgs[0]!.tool_call_id !== 'call-1') throw new Error('CHUNK_FAIL tool 消息关联错')
const leakedThink = chunkEvents.some((e) => String((e.payload as { delta?: unknown } | null)?.delta ?? '').includes('思考'))
if (leakedThink) throw new Error('CHUNK_FAIL reasoning delta 被外发')
trace('CHUNK_PASS 全部断言通过')
