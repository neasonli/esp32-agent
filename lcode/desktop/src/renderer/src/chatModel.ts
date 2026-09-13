/**
 * W1 · block 消息模型组装器（纯函数，无 DOM/无 React）
 *
 * 依据《Agent聊天窗口设计文档》§1/§2/§3：
 * - 从持久化 chat_messages（权威有序序列）还原「用户气泡 + 助手回合（text/工具卡片组）」；
 * - 渲染层零业务逻辑：这里只做 消息/事件 → 展示模型 映射，不碰 Agent 语义（D19）。
 *
 * 降级说明（缺 typed 数据时）：
 * - 历史回放只依赖 chat_messages：`__toolcalls__` 行 → tool-call 卡，紧随的 role=tool 行
 *   按 tool_call_id 精确配对 → tool-result 态（成功绿/失败红）。不需要事件带 type/payload。
 * - 运行中：会话 running 且工具卡未收到结果 → 保持「执行中」骨架；会话停止后仍未闭合 →
 *   标失败（中断/无结果）。assistant/chunk 尚未桥接，文字流式退化为回合级出现 + 光标占位
 *   （渲染层 streaming 标记）。
 */

// ---------- 展示模型 ----------

export type ToolState = 'running' | 'success' | 'failed'

export interface ToolCallBlock {
  key: string
  name: string
  /** 参数摘要（截断 140 字，展开详情可看 JSON 原文） */
  argsPreview: string
  callId?: string
  state: ToolState
  /** 结果文本（成功=结果摘要原文；失败=错误摘要，详情可展开） */
  result?: string
  isError: boolean
  startedAt?: number
  endedAt?: number
}

export type ChatBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tools'; key: string; tools: ToolCallBlock[] }
  | { kind: 'notice'; key: string; level: 'info' | 'warn' | 'error'; text: string }

/** 助手回合：用户消息之后到下一次用户消息前的连续助手/工具消息归并（§1.3 turn 边界） */
export interface AssistantTurn {
  key: string
  streaming: boolean
  blocks: ChatBlock[]
  /** 该回合最后一条消息 id（live 收敛/滚轮定位用） */
  lastMsgId: number
}

/** 会话展示序列：user 右气泡 / assistant 左回合 交替 */
export type ChatSection =
  | { role: 'user'; key: string; text: string }
  | { role: 'assistant'; key: string; turn: AssistantTurn }

// ---------- 解析工具 ----------

const ARGS_MAX = 140
const RESULT_PREVIEW_MAX = 160

function compactArgs(args: unknown): string {
  if (args === undefined || args === null || args === '') return ''
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args)
    return s.length > ARGS_MAX ? s.slice(0, ARGS_MAX) + '…' : s
  } catch {
    return String(args)
  }
}

function previewLine(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  return first.length > RESULT_PREVIEW_MAX ? first.slice(0, RESULT_PREVIEW_MAX) + '…' : first
}

/** tool 结果是否判为错误（events-bridge 错误结果文案为 '[错误] 工具执行失败' 等） */
export function looksError(text: string): boolean {
  const t = text.trim()
  return (
    t.startsWith('[错误]') ||
    t.startsWith('[error]') ||
    t.startsWith('错误') ||
    /^error\b/i.test(t) ||
    t.includes('Command failed') ||
    t.includes('失败：')
  )
}

/** assistant 工具调用消息（tool_name='__toolcalls__'）的 JSON content */
interface ToolCallsContent {
  content?: string | null
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
}

export function parseToolCalls(raw: string): ToolCallsContent {
  try {
    const p = JSON.parse(raw) as ToolCallsContent
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

function tsToMs(ts: string): number | undefined {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? t : undefined
}

/** 普通 assistant 文本消息（非 __toolcalls__） */
function isPlainAssistant(toolName: string): boolean {
  return toolName === '' || toolName === undefined || toolName === null
}

// ---------- 组装器 ----------

export interface AssembleOptions {
  /** 会话是否运行中（未闭合工具卡保持 running；否则标 failed） */
  running: boolean
}

export interface AssembleResult {
  sections: ChatSection[]
  /** 仍有未闭合（进行中）工具卡数量（渲染层可用作进度指示） */
  inflight: number
}

type InputMessage = {
  id: number
  role: string
  content: string
  tool_name: string
  tool_call_id: string
  ts: string
}

/**
 * 把有序 chat_messages 组装成展示序列（幂等、无副作用）。
 * 消息需按时间正序（内核 get_chat_messages 已正序返回）。
 */
export function assembleChat(messages: ReadonlyArray<InputMessage>, opts: AssembleOptions): AssembleResult {
  const sections: ChatSection[] = []
  let inflight = 0
  let turnSeq = 0

  // 当前回合构建器
  let curTurn: AssistantTurn | null = null

  const closeTurn = (): void => {
    if (!curTurn) return
    // 收尾：未收到结果的工具卡 —— running 保持「执行中」，否则标失败（中断/无结果）
    for (const b of curTurn.blocks) {
      if (b.kind !== 'tools') continue
      for (const t of b.tools) {
        if (t.state !== 'running') continue
        if (opts.running) {
          inflight += 1
        } else {
          t.state = 'failed'
          t.isError = true
          t.result = t.result ?? ''
          t.endedAt = Date.now()
        }
      }
    }
    if (curTurn.blocks.length > 0) {
      sections.push({ role: 'assistant', key: curTurn.key, turn: curTurn })
    }
    curTurn = null
  }

  const newTurn = (msgId: number): AssistantTurn => {
    closeTurn()
    turnSeq += 1
    return {
      key: `turn-${turnSeq}-${msgId}`,
      streaming: opts.running,
      blocks: [],
      lastMsgId: msgId,
    }
  }

  /** 追加文本（与上一 text 块合并，避免同一回合碎成多段） */
  const pushText = (text: string): void => {
    if (!curTurn || !text) return
    const last = curTurn.blocks[curTurn.blocks.length - 1]
    if (last && last.kind === 'text') {
      last.text = last.text + (last.text.endsWith('\n') ? '' : '\n') + text
    } else {
      curTurn.blocks.push({ kind: 'text', key: `${curTurn.key}-b${curTurn.blocks.length}`, text })
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      closeTurn()
      sections.push({ role: 'user', key: `user-${m.id}`, text: m.content })
      // 用户消息之后不立刻开回合：等收到 assistant/tool 消息再建，避免空回合
      continue
    }
    // assistant / tool → 归属当前回合（无 user 打头的旧会话以首条为起点）
    const turn: AssistantTurn = curTurn ?? newTurn(m.id)
    curTurn = turn

    if (m.role === 'tool') {
      turn.lastMsgId = m.id
      const openCards = turn.blocks
        .filter((b): b is Extract<ChatBlock, { kind: 'tools' }> => b.kind === 'tools')
        .flatMap((b) => b.tools)
      // 找仍未闭合、callId 或名称匹配的工具卡 → 落结果
      const target =
        openCards.find((t) => t.state === 'running' && (t.callId ? t.callId === m.tool_call_id : t.name === m.tool_name)) ??
        openCards.find((t) => t.state === 'running')
      if (target) {
        const err = looksError(m.content)
        target.state = err ? 'failed' : 'success'
        target.isError = err
        target.result = m.content
        target.endedAt = tsToMs(m.ts) ?? Date.now()
        if (target.callId === undefined && m.tool_call_id) target.callId = m.tool_call_id
      } else {
        // 游离 tool 结果（历史兼容）→ notice 兜底，不让信息丢失
        turn.blocks.push({
          kind: 'notice',
          key: `${turn.key}-n${m.id}`,
          level: looksError(m.content) ? 'error' : 'info',
          text: m.tool_name ? `[${m.tool_name}] ${previewLine(m.content)}` : previewLine(m.content),
        })
      }
      continue
    }

    // assistant
    if (!isPlainAssistant(m.tool_name)) {
      // __toolcalls__：先文本（思路/说明），再为每个 tool_call 开「执行中」卡
      const parsed = parseToolCalls(m.content)
      const think = (parsed.content ?? '').trim()
      const calls = parsed.tool_calls ?? []
      turn.lastMsgId = m.id
      if (think) pushText(think)
      if (calls.length > 0) {
        const tools: ToolCallBlock[] = calls
          .filter((tc) => tc?.function?.name)
          .map((tc, i) => ({
            key: `${turn.key}-tc${m.id}-${tc.id ?? i}`,
            name: tc.function!.name!,
            argsPreview: compactArgs(tc.function?.arguments),
            callId: tc.id,
            state: 'running',
            isError: false,
            startedAt: tsToMs(m.ts),
          }))
        if (tools.length > 0) {
          turn.blocks.push({ kind: 'tools', key: `${turn.key}-g${m.id}`, tools })
        }
      }
      continue
    }

    // 纯文本 assistant → text 块（回合内连续消息合并）
    if (m.content) {
      turn.lastMsgId = m.id
      pushText(m.content)
    }
  }

  closeTurn()
  return { sections, inflight }
}
