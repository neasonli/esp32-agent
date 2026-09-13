/**
 * 事件桥插件：把 DSH 规划层的会话事件（turn/step/工具调用/goal 续跑/subagent 子会话）翻译成
 * 内核 events 表 + chat_messages 表（task_id = session_id），桌面端现有
 * 500ms 事件轮询与聊天历史展示完全不变（agent核心开发文档 §5.2 统一事件字典）。
 *
 * M1b · 子会话（DSH delegation）：监听 `subagent/start` 把子代理会话注册进
 * SessionRegistry（cwd/fullAccess 继承父会话；task_id = 子会话 id），并为其在内核
 * upsert chat_session 行 —— 子事件/子工具透传独立落子会话（已定调 = 子会话独立落库，
 * 与 DSH 一致）。沙盒/审批继承由 dsh-subagent 在子会话创建窗内落的
 * `sandbox/mode` + `approval/policy`（source:'delegation'）事件提供，本桥不重复造。
 *
 * 事件映射（与 kernel/agent/chat_agent.py 的旧循环输出口径对齐）：
 * - step/start        → INFO  node=llm   「正在请求 LLM…」
 * - assistant/chunk   → INFO  node=agent 打字机增量（仅 text-delta，按 FLUSH_CHARS 聚合，
 *                       payload {delta,turn,step}；reasoning/tool-call delta 不外发）
 * - assistant/message → INFO  node=agent 最终回复 + assistant 消息落库（落库前先 flush chunk 缓冲）
 * - tool/call         → INFO  node=<工具名>「▶ 执行工具 …」+ __toolcalls__ 消息落库（payload 带 callId）
 * - tool/result       → INFO  node=<工具名> 结果首行 + tool 消息落库（payload 带 callId）
 * - turn/start        → INFO  node=agent「开始处理（第 N 轮）」+ payload {turn}
 * - turn/end          → idle 状态同步（completed/error/aborted/blocked 分派）
 * - goal/change       → INFO  node=goal  目标续跑可见
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KernelClient } from '../kernel-client.ts'
import type { SessionRegistry } from '../sessions.ts'

export const name = 'lcode-events-bridge'

export interface Config {
  client: KernelClient
  registry: SessionRegistry
}

/** tool/call → tool/result 的 callId→name 关联（按会话）。 */
type CallNames = Map<string, string>

/** 打字机增量聚合阈值：text-delta 累计 ≥ 该字符数才写一条 assistant/chunk 内核事件。
 * 逐 token 外发会爆 events 表（真实 DeepSeek 会话数百行/条回复）；聚合后 ≈ 数百字符/条消息
 * 只产生 ~N 行，500ms 轮询下仍呈逐段打字机效果。 */
const FLUSH_CHARS = 24

/** 每会话 chunk 流缓冲（turn/step 变化即重开；assistant/message|turn/end 前强制 flush）。 */
interface ChunkStream {
  turn: number
  step: number
  parts: string[]
}

/** 从 DSH assistant/chunk 事件取出可外发的文本增量；reasoning/tool-call delta 不参与 UI 文字流。 */
function chunkDeltaOf(eventData: unknown): { turn: number; step: number; text: string } | null {
  const d = eventData as {
    turn?: number
    step?: number
    chunk?: { type?: string; text?: string }
  }
  const chunk = d?.chunk
  if (chunk?.type !== 'text-delta') return null
  const text = chunk.text
  if (typeof text !== 'string' || text === '') return null
  return { turn: d.turn ?? 0, step: d.step ?? 0, text }
}

export function apply(ctx: Context, config: Config): void {
  const { client, registry } = config
  const callNamesBySession = new Map<string, CallNames>()
  // W1 数据桥 · 打字机增量缓冲（assistant/chunk → 内核 assistant/chunk 事件）
  const chunkStreams = new Map<string, ChunkStream>()

  const callNames = (sessionId: string): CallNames => {
    let m = callNamesBySession.get(sessionId)
    if (m === undefined) {
      m = new Map()
      callNamesBySession.set(sessionId, m)
    }
    return m
  }

  /** 把某会话攒下的文本增量 flush 成一条 assistant/chunk 内核事件（无残留则空转）。 */
  const flushChunks = async (sessionId: string, force: boolean): Promise<void> => {
    const st = chunkStreams.get(sessionId)
    if (st === undefined) return
    const text = st.parts.join('')
    if (text === '') {
      if (force) chunkStreams.delete(sessionId)
      return
    }
    if (!force && text.length < FLUSH_CHARS) return
    st.parts = []
    if (force) chunkStreams.delete(sessionId)
    await client.addEvent(sessionId, 'INFO', '', 'agent', 'assistant/chunk', {
      delta: text,
      turn: st.turn,
      step: st.step,
    }).catch(() => { /* 内核不可达时丢增量；assistant/message 落库仍保底完整文本 */ })
  }

  /** 吸收一个 text-delta：续进缓冲，达阈值即 flush（打字机粒度）。 */
  const absorbChunk = async (sessionId: string, event: SessionEvent): Promise<void> => {
    const d = chunkDeltaOf(event.data)
    if (d === null) return
    let st = chunkStreams.get(sessionId)
    if (st !== undefined && (st.turn !== d.turn || st.step !== d.step)) {
      // turn/step 切换：先强制 flush 残留，避免 < FLUSH_CHARS 的尾巴随切换丢失
      await flushChunks(sessionId, true)
      st = chunkStreams.get(sessionId)
    }
    if (st === undefined) {
      st = { turn: d.turn, step: d.step, parts: [] }
      chunkStreams.set(sessionId, st)
    }
    st.parts.push(d.text)
    if (st.parts.join('').length >= FLUSH_CHARS) {
      await flushChunks(sessionId, false)
    }
  }

  // M1b · 子代理会话注册（subagent/start 触发：子会话已发布、ctx.agents 可解析）。
  // 先同步登记（避免子代理首个工具调用竞态落回默认值），再后台 upsert 内核子会话行
  // （子事件/子工具透传以子会话 id 为 task_id 独立落库，同 DSH delegation）。
  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    const childId = String(info.id)
    const existing = registry.get(childId)
    if (existing !== undefined) {
      // 续跑 epoch 复用同一子会话：仅刷新 busy（结束后由 agent/status idle 回落）。
      existing.busy = true
      return
    }
    const child = ctx.agents.get(info.id)
    if (child === undefined) return
    registerChildSession(registry, child)
    const sess = registry.get(childId)
    if (sess !== undefined) {
      void client.upsertChatSession(childId, sess.cwd, sess.fullAccess, sess.title)
        .catch(() => { /* 内核不可达不阻断子代理运行 */ })
    }
  })

  // agent 状态同步：回归 idle → 会话不再忙、内核状态回 idle。
  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = String(agent.id)
    const sess = registry.get(sessionId)
    if (status === 'idle' && sess?.busy) {
      sess.busy = false
      void client.setChatState(sessionId, { status: 'idle' }).catch(() => {})
    }
    // 执行中发起的 plan-mode 切换（server.handlePlanMode 只记 session.deferredPlan）：
    // 等本轮真正结束（agent 回 idle、无 open turn）才落账 plan/mode —— 影响后续轮次，
    // 绝不打断当前轮（2026-09-06 实测事故：执行中切换被 dsh-plan-mode 排到下一 pre-step，
    // 模型中途收到 plan:policy 提示段改写行为并 max-tokens 截断）。
    if (status === 'idle' && sess?.deferredPlan !== undefined && sess.agent !== undefined) {
      const target = sess.deferredPlan
      sess.deferredPlan = undefined
      try {
        ctx.planMode.set(sess.agent, target)
      } catch (error) {
        if (process.env.LCORE_TRACE === '1') {
          console.error('[planner:trace] deferred plan commit failed:',
            error instanceof Error ? error.message : String(error))
        }
      }
    }
  })

  // agent 异常事件。
  ctx.on('agent/error', ({ agent, error }) => {
    void client.addEvent(
      String(agent.id), 'ERROR',
      `执行出错：${error instanceof Error ? error.message : String(error)}`,
      'agent', 'agent/error',
    ).catch(() => {})
  })

  // 会话事件 → 内核（事件/消息落库）。同一会话按序串行转发，保证
  // chat_messages 的 id 顺序与事件顺序一致（UI 按 id 渲染）。
  const chains = new Map<string, Promise<void>>()
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (event.type === 'assistant/chunk') {
        // W1 数据桥 · 打字机增量：text-delta 聚合 → 阈值 flush（同链串行，顺序保序）
        await absorbChunk(sessionId, event)
        return
      }
      // 文本/轮次落库前先 flush 残余增量，保证 chunk 事件先于 assistant/message 抵达
      if (event.type === 'assistant/message' || event.type === 'turn/end') {
        await flushChunks(sessionId, true)
      }
      await handleEvent(client, registry, callNames, sessionId, event)
    }).catch((error: unknown) => {
      if (process.env.LCORE_TRACE === '1') {
        console.error(`[planner:trace] events-bridge ${sessionId} ${event.type}:`,
          error instanceof Error ? error.message : String(error))
      }
      // 内核短暂不可达时静默丢弃事件；下一轮轮询/状态同步会自愈。
    })
    chains.set(sessionId, next)
  })
}

async function handleEvent(
  client: KernelClient,
  registry: SessionRegistry,
  callNames: (sessionId: string) => CallNames,
  sessionId: string,
  event: SessionEvent,
): Promise<void> {
  const model = registry.get(sessionId)?.agent?.options.model ?? ''

  switch (event.type) {
    case 'step/start': {
      await client.addEvent(sessionId, 'INFO', `正在请求 LLM（${model}）…`, 'llm', 'step/start')
      break
    }
    case 'user/message': {
      // 注意：user/message 事件的 data 即消息本体（{id, content, source}）。
      // 只落真实用户消息（goal 续跑注入的轮次消息不进 UI 历史）。
      if (event.data.source?.kind !== 'user') break
      const text = textOf(event.data.content)
      if (text) await client.appendChatMessage(sessionId, 'user', text)
      break
    }
    case 'assistant/message': {
      const text = textOf(event.data.message.content)
      if (text) {
        await client.appendChatMessage(sessionId, 'assistant', text)
        await client.addEvent(sessionId, 'INFO', text, 'agent', 'assistant/message')
      }
      break
    }
    case 'tool/call': {
      const { callId, name, arguments: args } = event.data
      callNames(sessionId).set(callId, name)
      const toolCalls = [{
        id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify(args ?? {}) },
      }]
      await client.appendChatMessage(
        sessionId, 'assistant',
        JSON.stringify({ content: null, tool_calls: toolCalls }),
        '__toolcalls__',
      )
      // W1 数据桥 · payload 补 callId：渲染层可将事件流与 __toolcalls__/tool 消息精确关联
      await client.addEvent(
        sessionId, 'INFO', `▶ 执行工具 ${name} ${argsPreview(args)}`, name, 'tool/call',
        { callId, name, args: args ?? {} },
      )
      break
    }
    case 'tool/result': {
      // tool/result 事件的 message.content = [ToolResultBlock]，
      // 文本在 block.content，callId 在 block.toolCallId。
      const block = event.data.message.content[0]
      const callId = block?.type === 'tool-result' ? block.toolCallId : ''
      const name = (callId !== '' && callNames(sessionId).get(callId)) || 'tool'
      const text = block?.type === 'tool-result'
        ? (textOf(block.content) || (block.isError ? '[错误] 工具执行失败' : ''))
        : textOf(event.data.message.content)
      if (text) {
        await client.appendChatMessage(sessionId, 'tool', text, name, callId)
        await client.addEvent(
          sessionId, 'INFO', resultPreview(text), name, 'tool/result',
          // W1 数据桥 · payload 补 callId（与 tool/call 对齐，供卡片配对/耗时统计）
          { callId, name, error: block?.type === 'tool-result' ? Boolean(block.isError) : false },
        )
      }
      break
    }
    case 'turn/start': {
      await client.addEvent(sessionId, 'INFO', `开始处理（第 ${event.data.turn} 轮）`, 'agent', 'turn/start',
        { turn: event.data.turn })
      break
    }
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'error') {
        await client.addEvent(sessionId, 'ERROR', `本轮执行失败：${reason.error.message}`, 'agent', 'turn/end')
      } else if (reason.kind === 'aborted') {
        await client.addEvent(sessionId, 'WARN', '本轮已停止', 'agent', 'turn/end')
      } else if (reason.kind === 'blocked') {
        await client.addEvent(sessionId, 'WARN', '本轮被策略阻止', 'agent', 'turn/end')
      } else if (reason.kind === 'max-tokens') {
        // 实测事故（2026-09-06）：回复超出输出预算被截断（turn/end reason=max-tokens），
        // 无此分支 = 零可见事件，UI 表现为「agent 半句话停住且无法继续」。
        await client.addEvent(sessionId, 'WARN', '回复达到长度上限被截断，本轮已结束（可回复“继续”接着执行）', 'agent', 'turn/end')
      } else if (reason.kind === 'interrupted') {
        await client.addEvent(sessionId, 'WARN', '本轮被中断', 'agent', 'turn/end')
      } else {
        // completed 之外的新 reason 也落可见事件，避免未来同类静默（completed 有意不落）。
        const kind = (reason as { kind: string }).kind
        if (kind !== 'completed') {
          await client.addEvent(sessionId, 'WARN', `本轮结束（原因：${kind}）`, 'agent', 'turn/end')
        }
      }
      // 阶段3 Phase3：工作区 git 会话 checkpoint（每轮结束落一个快照；无变更不产生提交）
      await client.gitCheckpoint(sessionId, `turn ${event.data.turn}`).catch(() => {})
      // idle 状态由 agent/status 同步；这里只做事件可见性。
      break
    }
    case 'goal/change': {
      const data = event.data as { goalId?: string; action?: string }
      await client.addEvent(
        sessionId, 'INFO',
        `目标${data.action ?? '更新'}（${data.goalId ?? ''}）`,
        'goal', 'goal/change', data,
      )
      break
    }
    default:
      break
  }
}

function textOf(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  return blocks.filter(b => b.type === 'text' && b.text).map(b => b.text ?? '').join('')
}

/**
 * M1b · 把发布后的子代理会话同步登记进 SessionRegistry（同步、幂等）。
 * 身份/权限继承来源 = DSH 子会话自身的持久化 header（dsh-subagent 在创建窗写入）：
 * - cwd：`header.cwd`（父会话 cwd 的拷贝，子会话独立可重建）；
 * - fullAccess：父 planner 会话的当前值（由 `header.parentSession` 回查；父不在册时缺省 true）；
 * - task_id = 子会话 id（内核按子会话独立落库）。
 * 沙盒/审批继承不在此处复制 —— dsh-subagent 已把父的 sandbox/mode 覆盖与
 * approval/policy=never 以 source:'delegation' 事件写进子会话日志，规划器
 * sandbox-policy/approval 按会话折叠即生效。
 * @param registry - 规划器会话注册表。
 * @param child - 已发布的子代理 agent。
 * @returns 子会话 id；未满足登记条件（非 subagent 形态/无 cwd）时 undefined。
 */
function registerChildSession(registry: SessionRegistry, child: Agent): string | undefined {
  const childId = String(child.id)
  if (registry.get(childId) !== undefined) return childId
  const header = child.session.header
  if (header.origin !== 'subagent') return undefined
  const parentId = header.parentSession === undefined ? undefined : String(header.parentSession)
  const parent = parentId === undefined ? undefined : registry.get(parentId)
  const cwd = header.cwd ?? parent?.cwd
  if (cwd === undefined || cwd === '') return undefined
  const fullAccess = parent?.fullAccess ?? true
  registry.set({
    sessionId: childId,
    cwd,
    fullAccess,
    title: '（子代理）',
    agent: child,
    busy: true,
    createdAt: Date.now(),
    kind: 'subagent',
    ...parentId !== undefined ? { parentId } : {},
  })
  return childId
}

function argsPreview(args: unknown): string {
  const s = JSON.stringify(args ?? {})
  return s.length <= 120 ? s : s.slice(0, 120) + '…'
}

function resultPreview(result: string): string {
  const first = result.trim().split('\n')[0] ?? ''
  const head = first.slice(0, 150)
  return `→ ${head}` + (first.length > 150 || result.includes('\n') ? '（详情已记录）' : '')
}
