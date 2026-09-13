/**
 * 规划器本地 HTTP 服务（供 Electron 网关调用；agent核心开发文档 §1.8/§9 src/server）。
 *
 * - POST /api/planner/chat      {session_id?, message, cwd?, full_access?, plan_mode?} → {session_id, status}
 *                                plan_mode?: true=进入 plan 模式（先规划后执行）；false=退出。
 *                                （M2 A4 · 桌面"确认进入执行"UI 属 Phase 5.4，agent 侧状态机先行）
 * - POST /api/planner/cancel    {session_id}                                 → 停止当前轮
 * - POST /api/planner/access    {session_id, full_access}                    → 切换执行权限
 * - POST /api/planner/fork      {session_id, at_message_id}                  → 分支：复制锚点前上下文开新会话并登记（阶段4 W4）
 * - POST /api/planner/flash_confirm {session_id, project_dir, port}          → 会话确认后显式烧录（防误烧）
 * - POST /api/planner/flash_dismiss {session_id}                             → 取消待烧录
 * - POST /api/planner/git_checkpoint {session_id, message?, project_dir?}    → 工作区 git checkpoint（阶段3 Phase3）
 * - POST /api/planner/git_rollback  {session_id, commit?, project_dir?}      → 会话回滚（显式）
 * - POST /api/planner/git_status    {session_id, project_dir?}               → 只读 git 状态
 * - GET  /api/planner/interactions[?session_id=]                             → 待应答人机交互（M3 · 桌面轮询取件）
 * - POST /api/planner/interactions/{id}/answer {kind, outcome?|answers?}     → 桌面应答（M3 · approval/questions）
 * - GET  /api/planner/sessions                                               → 会话列表
 * - GET  /api/planner/health                                                 → 健康检查
 * - POST /api/planner/shutdown                                               → 优雅退出
 *
 * 鉴权：X-Planner-Token（桌面网关 spawn 时分配）。事件/消息/状态经内核 HTTP 落库，
 * 桌面端对内核的 500ms 事件轮询与聊天历史读取保持原样。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { KernelClient } from '../kernel-client.ts'
import type { SessionRegistry, PlannerSession, ReasoningEffort } from '../sessions.ts'
import type { InteractionBridge } from './interaction-bridge.ts'
import type { PlannerEnv } from '../config.ts'

export const name = 'lcode-server'

export interface Config {
  client: KernelClient
  registry: SessionRegistry
  env: PlannerEnv
  /** M3 · 人机交互桥（approval/questions 挂起队列；桌面轮询/应答端点）。 */
  interactionBridge?: InteractionBridge
}

interface ChatRequest {
  session_id?: string
  message?: string
  cwd?: string
  full_access?: boolean
  /** M2 A4：plan-mode 意图（true=进入 plan 模式，false=退出；缺省不切换）。 */
  plan_mode?: boolean
  /** 推理等级（reasoning effort：off/high/max）；会话内发送时覆写本会话档位。 */
  reasoning_effort?: string
  /**
   * 运行中投递方式（DSH composer 语义，2026-09 照抄）：
   * - 'queue'（默认）= 排队：`agent.followup` —— 本轮结束后作为自己的一轮自动执行；
   * - 'steer' = 立即投递：`agent.steer` —— 注入运行中本轮最近的 step 边界被消费。
   * 空闲会话忽略该字段（首条消息即正常一轮）。
   */
  delivery?: 'queue' | 'steer'
}

export function apply(ctx: Context, config: Config): void {
  const { client, registry, env } = config
  let kernelInfo: Awaited<ReturnType<KernelClient['getInfo']>> | undefined

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
    })
  })

  server.listen(env.port, '127.0.0.1', () => {
    console.log(`[planner] HTTP 服务已启动：http://127.0.0.1:${env.port}`)
  })

  ctx.effect(function* () {
    yield () => {
      server.close()
    }
  }, 'lcode-server.listen()')

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) {
      sendJson(res, 401, { detail: '无效的令牌' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/planner/health') {
      // LLM 身份也一并回显：桌面据此把"设置页选的模型 / 实际用的模型 / 用的是哪把 Key"
      // 摆到界面上（Key 只回末 4 位）。对话跑的是本进程，这里的值才是"真正生效"的值。
      const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
      sendJson(res, 200, {
        status: 'ok',
        name: 'lcode-planner',
        pid: process.pid,
        sessions: registry.list().length,
        model: env.model,
        requested_model: env.requestedModel,
        llm_base_url: process.env.DEEPSEEK_BASE_URL ?? '',
        api_key_tail: apiKey ? `****${apiKey.slice(-4)}` : '',
        api_key_source: apiKey ? 'env' : 'none',
      })
      return
    }

    if (req.method === 'GET' && path === '/api/planner/sessions') {
      sendJson(res, 200, {
        sessions: registry.list().map(s => ({
          session_id: s.sessionId,
          cwd: s.cwd,
          full_access: s.fullAccess,
          title: s.title,
          busy: s.busy,
          created_at: s.createdAt,
          ...(s.reasoningEffort === undefined ? {} : { reasoning_effort: s.reasoningEffort }),
        })),
      })
      return
    }

    // M3 · 桌面轮询取件：某会话（缺省全部）的待应答人机交互只读快照。
    if (req.method === 'GET' && path === '/api/planner/interactions') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session_id') ?? undefined
      const bridge = config.interactionBridge
      if (bridge === undefined) {
        sendJson(res, 200, { interactions: [] })
        return
      }
      sendJson(res, 200, { interactions: bridge.list(sessionId) })
      return
    }

    // 会话 plan-mode 只读回填（前端 PlanChip「仅开启时出现」的权威值来自 planner agent 状态）。
    if (req.method === 'GET' && path === '/api/planner/plan_state') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session_id') ?? ''
      const session = registry.get(sessionId)
      if (session === undefined || session.agent === undefined) {
        sendJson(res, 200, { session_id: sessionId, plan_active: false })
        return
      }
      const state = ctx.planMode.get(session.agent)
      // deferredPlan = 执行中由用户发起、等本轮结束才落账的切换意图：权威读取把它折叠为
      // “目标态”，UI（PlanChip）据此保持与用户选择一致，不会因尚未 commit 而熄灭。
      const deferred = session.deferredPlan
      const effectiveActive = deferred !== undefined ? deferred : state.active
      sendJson(res, 200, { session_id: sessionId, plan_active: effectiveActive })
      return
    }

    // 运行中「待发送队列」只读快照（DSH QueueDock 对应物）：
    // 投影 DSH agent inbox —— next-turn = 排队中的普通回合（Enter 投递），
    // next-step = 已 steer、尚未被 step 边界消费的消息（Ctrl+Enter 投递）。
    if (req.method === 'GET' && path === '/api/planner/queue') {
      const sessionId = url.searchParams.get('session_id') ?? ''
      const session = registry.get(sessionId)
      sendJson(res, 200, {
        session_id: sessionId,
        items: session === undefined ? [] : queueItems(session),
      })
      return
    }

    if (req.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req)
      switch (path) {
        case '/api/planner/chat': {
          await handleChat(res, body as ChatRequest)
          return
        }
        case '/api/planner/queue_remove': {
          handleQueueRemove(res, body)
          return
        }
        case '/api/planner/effort': {
          await handleEffort(res, body)
          return
        }
        case '/api/planner/planmode': {
          await handlePlanMode(res, body)
          return
        }
        case '/api/planner/cancel': {
          await handleCancel(res, body)
          return
        }
        case '/api/planner/access': {
          await handleAccess(res, body)
          return
        }
        case '/api/planner/fork': {
          await handleFork(res, body)
          return
        }
        case '/api/planner/flash_confirm': {
          await handleFlashConfirm(res, body)
          return
        }
        case '/api/planner/flash_dismiss': {
          await handleFlashDismiss(res, body)
          return
        }
        case '/api/planner/git_checkpoint': {
          await handleGit('checkpoint', res, body)
          return
        }
        case '/api/planner/git_rollback': {
          await handleGit('rollback', res, body)
          return
        }
        case '/api/planner/git_status': {
          await handleGit('status', res, body)
          return
        }
        case '/api/planner/interactions/answer': {
          await handleInteractionAnswer(res, body)
          return
        }
        case '/api/planner/shutdown': {
          sendJson(res, 200, { status: 'shutting_down' })
          setTimeout(() => { void shutdown() }, 200)
          return
        }
      }
    }
    sendJson(res, 404, { detail: '未找到端点' })
  }

  function authorized(req: IncomingMessage): boolean {
    if (!env.token) return true
    return req.headers['x-planner-token'] === env.token
  }

  /**
   * 懒恢复登记（2026-09 拍板：历史会话跨重启保留）：
   * planner 重启后 SessionRegistry（进程内存态）为空，旧会话按 session_id 再来时
   * 从内核会话详情重建登记。要「继续对话/分支」必须恢复 DSH agent —— 其上下文
   * 持久化在 planner sessionRoot 的 JSONL（与内核 chat_messages 独立），用
   * ctx.agents.resume 从持久化会话加载 agent 事件历史。
   * 恢复条件：内核会话存在、非 running、有内容；JSONL 缺失/损坏 → 返回 undefined
   * （调用方回 404，用户可新建会话；Home 历史仍可见可读）。
   * @returns 已登记会话；无法恢复时 undefined。
   */
  async function restoreSession(sessionId: string): Promise<PlannerSession | undefined> {
    let detail: { title: string; cwd: string; status: string; full_access: boolean; messages?: unknown[] }
    try {
      detail = await client.getChatSessionDetail(sessionId)
    } catch (error) {
      // 内核侧已不存在（如被启动清理删空）→ 无法恢复
      console.error('[planner] restoreSession: 内核无会话详情', sessionId,
        error instanceof Error ? error.message : String(error))
      return undefined
    }
    // 空消息判定用 messages 数组长度：内核 /api/chat_session 详情返回 messages 而非
    // msg_count（msg_count 只在 Home 列表接口有），沿用 list 口径会造成有内容会话被
    // 误判为空壳而拒绝恢复（2026-09-08 实测：de30… 64 条消息被当空消息 → 404）。
    const messageCount = Array.isArray(detail.messages) ? detail.messages.length : 0
    if (detail.status === 'running' || messageCount === 0) {
      console.error('[planner] restoreSession: 会话不可恢复（running 或无消息）', sessionId,
        detail.status, `msgs=${messageCount}`)
      return undefined
    }
    const cwd = detail.cwd || (kernelInfo ??= await client.getInfo()).outputs_dir
    const fullAccess = detail.full_access !== false
    let handle: AgentHandle
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: env.provider, model: env.model },
      })
    } catch (error) {
      // JSONL 不存在/格式不兼容：无法把前文上下文接回 agent。仅当会话有内容仍可读，
      // 但不能继续；调用方决定回 404。
      console.error('[planner] restoreSession: agents.resume 失败', sessionId,
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
      return undefined
    }
    const restored: PlannerSession = {
      sessionId,
      cwd,
      fullAccess,
      title: detail.title || '',
      agent: handle.agent,
      handle,
      busy: false,
      createdAt: Date.now(),
    }
    registry.set(restored)
    return restored
  }

  /**
   * 运行中「待发送队列」投影（DSH QueueDock 同源数据）：
   * 直接读 DSH agent 的 inbox（next-turn / next-step），不另建队列——
   * inbox 是唯一队列（DSH 契约：每条被接受的消息都有唯一可观察顺序）。
   */
  function queueItems(session: PlannerSession): { id: string; text: string; placement: 'next-turn' | 'next-step' }[] {
    const agent = session.agent
    if (agent === undefined) return []
    const read = (
      messages: readonly { id: unknown; content: readonly { type?: unknown; text?: unknown }[] }[],
      placement: 'next-turn' | 'next-step',
    ): { id: string; text: string; placement: 'next-turn' | 'next-step' }[] =>
      messages.map((m) => ({
        id: String(m.id),
        placement,
        text: (m.content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n'),
      }))
    return [
      ...read(agent.inbox.nextTurn as never, 'next-turn'),
      ...read(agent.inbox.nextStep as never, 'next-step'),
    ]
  }

  /** 从待发送队列里删除一条（DSH QueueDock 的删除项：inbox.remove(messageId)）。 */
  function handleQueueRemove(res: ServerResponse, body: Record<string, unknown>): void {
    const sessionId = String(body.session_id ?? '')
    const messageId = String(body.message_id ?? '')
    const session = registry.get(sessionId)
    if (session === undefined || session.agent === undefined) {
      sendJson(res, 404, { detail: '会话不存在或 agent 未就绪' })
      return
    }
    if (messageId === '') {
      sendJson(res, 400, { detail: 'message_id 不能为空' })
      return
    }
    let removed = false
    try {
      removed = session.agent.inbox.remove(messageId as unknown as MessageId)
    } catch (error: unknown) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { session_id: sessionId, message_id: messageId, removed })
  }

  async function handleChat(res: ServerResponse, req: ChatRequest): Promise<void> {
    const message = (req.message ?? '').trim()
    if (message.length === 0) {
      sendJson(res, 400, { detail: 'message 不能为空' })
      return
    }
    // 推理等级：随消息携带时即时覆写本会话档位（供 agent/request 瀑布使用）。
    const effort = normalizeEffort(req.reasoning_effort)
    let session: PlannerSession
    if (req.session_id) {
      let existing = registry.get(req.session_id)
      if (existing === undefined) {
        // 懒恢复：planner 重启后登记表（内存态）为空，旧会话按需从内核详情 + DSH
        // JSONL 恢复 agent（2026-09 拍板：历史会话跨重启保留，可继续对话/分支）。
        existing = await restoreSession(req.session_id)
      }
      if (existing === undefined) {
        sendJson(res, 404, {
          detail: '会话不在规划器中（历史会话懒恢复失败，详见 planner 日志；可尝试新建会话）',
        })
        return
      }
      // 运行中投递（对齐 DSH composer 的 queue/steer 语义，2026-09 照抄）：
      //   Enter（普通）= queue → agent.followup：排进 inbox 的 next-turn，本轮结束自动起一轮；
      //   Ctrl+Enter（加速）= steer → agent.steer：注入运行中本轮最近的 step 边界立即消费。
      // 旧实现直接回 409「会话正在执行中，请稍候」→ 运行中输入框被禁用、无法发送（用户实测反馈）。
      const agentRunning = existing.agent !== undefined && existing.agent.status !== 'idle'
      if (existing.busy || agentRunning) {
        if (existing.agent === undefined) {
          sendJson(res, 409, { detail: '会话正在执行中（agent 未就绪），请稍候' })
          return
        }
        const delivery: 'queue' | 'steer' = req.delivery === 'steer' ? 'steer' : 'queue'
        if (effort !== undefined) existing.reasoningEffort = effort
        try {
          // 不改内核状态：本轮本来就在 running；投递失败只报错，不回滚（turn 仍在跑）
          const message_ = createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
          })
          if (delivery === 'steer') existing.agent.steer(message_)
          else existing.agent.followup(message_)
        } catch (error: unknown) {
          console.error('[planner] 运行中投递失败:',
            error instanceof Error ? error.message : String(error))
          sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
          return
        }
        sendJson(res, 200, { session_id: existing.sessionId, status: 'running', delivery })
        return
      }
      session = existing
      session.busy = true
      if (effort !== undefined) session.reasoningEffort = effort
    } else {
      // 新建会话：先向内核登记（拿 session_id），再建 DSH agent（三端同 ID）。
      try {
        const cwd = req.cwd || (kernelInfo ??= await client.getInfo()).outputs_dir
        const fullAccess = req.full_access ?? true
        const created = await client.upsertChatSession('', cwd, fullAccess, message.slice(0, 50))
        const id = created.session_id
        const handle = await ctx.agents.create({
          sessionId: SessionId(id),
          meta: { cwd: created.cwd },
          agentOptions: { provider: env.provider, model: env.model },
        })
        session = {
          sessionId: id,
          cwd: created.cwd,
          fullAccess: created.full_access,
          title: message.slice(0, 50),
          agent: handle.agent,
          handle,
          busy: true,
          createdAt: Date.now(),
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        }
        registry.set(session)
      } catch (error: unknown) {
        sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
        return
      }
    }

    try {
      // 新一轮消息 = 用户要继续：清掉历史 cancel_requested（与内核 run_chat_turn 同口径），
      // 置 running。
      await client.setChatState(session.sessionId, { status: 'running', cancel_requested: false })
      // M2 A4 · plan 意图折叠：在 followup 前按请求切换本会话 plan 模式。
      // 空闲会话（无 open turn）由 planMode.set 即刻落 plan/mode 事件（committed）；
      // 执行中会话的切换排队至下一次被接受的 pre-step（与 DSH /plan 语义一致）。
      // 防御：plan 切换是会话级意图，即使失败也只记录，不阻断消息本体投递
      // （否则一次切换异常会把整个请求打成 500 且内核状态停在 running——实测事故）。
      if (req.plan_mode !== undefined && session.agent !== undefined) {
        try {
          ctx.planMode.set(session.agent, req.plan_mode)
        } catch (modeError: unknown) {
          console.error('[planner] plan_mode 切换失败（忽略，继续发送）:',
            modeError instanceof Error ? modeError.message : String(modeError))
        }
      }
      session.agent!.followup(createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }))
    } catch (error: unknown) {
      session.busy = false
      // 回滚：请求失败时内核状态必须回到 idle（可能已先置 running），
      // 否则 UI 读到永久 running、stop 因 agent 未进入 turn 而失效（实测事故）。
      await client.setChatState(session.sessionId, { status: 'idle', cancel_requested: false })
        .catch(() => { /* 回滚失败仅记录；agent 未运行，无后台 turn 会改写状态 */ })
      console.error('[planner] chat 请求处理失败:',
        error instanceof Error ? error.message : String(error))
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { session_id: session.sessionId, status: 'running' })
  }

  /**
   * 会话分支（阶段4 W4 · 桌面「在新对话中分支」，参考 DSH session.fork）：
   * 内核复制该会话在锚点消息前的全部 chat_messages 前缀 → 新会话（权威正文层），
   * 规划器为其新建 DSH agent 并登记进 SessionRegistry，保证新会话可继续对话。
   * 注意：模型上下文随 agent 内存（会话事件）；fork 后 agent 为新实例，
   * 前文以 chat_messages 正文呈现，与“规划器重启后继续旧会话”属同一延续语义。
   */
  async function handleFork(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    const atMessageId = Number(body.at_message_id ?? NaN)
    let source = registry.get(sessionId)
    if (source === undefined) {
      // 懒恢复：planner 重启后源会话不在登记表（内存态），fork 只需元数据
      // （cwd/fullAccess/title）——前缀由内核 forkChat 复制、新 agent 全新上下文，
      // 不依赖源 agent 存在。若内核侧也没有该会话才拒绝。
      let detail: { title?: string; cwd?: string; full_access?: boolean; status?: string } | undefined
      try {
        detail = await client.getChatSessionDetail(sessionId)
      } catch { /* 404 = 内核也不存在 */ }
      if (detail === undefined || detail.status === 'running') {
        sendJson(res, 404, { detail: '源会话不存在或无法分支（内核侧已无此会话）' })
        return
      }
      source = {
        sessionId,
        cwd: detail.cwd || '',
        fullAccess: detail.full_access !== false,
        title: detail.title || '',
        busy: false,
        createdAt: Date.now(),
        kind: 'session',
      }
    }
    if (!Number.isInteger(atMessageId) || atMessageId <= 0) {
      sendJson(res, 400, { detail: 'at_message_id 无效' })
      return
    }
    if (source.busy) {
      sendJson(res, 409, { detail: '会话正在执行中，请先停止再分支' })
      return
    }
    try {
      const cwd = source.cwd || (kernelInfo ??= await client.getInfo()).outputs_dir
      const srcTitle = (source.title ?? '').trim()
      const title = srcTitle && srcTitle !== '新对话' ? `${srcTitle}（分支）` : '新对话'
      const forked = await client.forkChat(sessionId, atMessageId)
      const handle = await ctx.agents.create({
        sessionId: SessionId(forked.session_id),
        meta: { cwd },
        agentOptions: { provider: env.provider, model: env.model },
      })
      // 以规划器口径修正内核行标题（fork 已复制 cwd/full_access/前缀正文，upsert 幂等）
      await client.upsertChatSession(forked.session_id, cwd, source.fullAccess, title)
      registry.set({
        sessionId: forked.session_id,
        cwd,
        fullAccess: source.fullAccess,
        title,
        agent: handle.agent,
        handle,
        busy: false,
        createdAt: Date.now(),
        kind: source.kind,
        parentId: source.kind === 'subagent' ? source.parentId : undefined,
      })
      sendJson(res, 200, { session_id: forked.session_id })
    } catch (error: unknown) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /** M3 · 桌面应答：approval outcome 或 user-questions answers（id 在 body 内）。 */
  async function handleInteractionAnswer(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const bridge = config.interactionBridge
    if (bridge === undefined) {
      sendJson(res, 404, { detail: '交互桥未装配' })
      return
    }
    const id = String(body.id ?? '')
    if (id === '') {
      sendJson(res, 400, { detail: 'id 不能为空' })
      return
    }
    const kind = body.kind
    if (kind === 'approval') {
      const outcome = body.outcome
      if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(String(outcome))) {
        sendJson(res, 400, { detail: 'approval outcome 无效' })
        return
      }
      const ok = bridge.answer(id, { kind: 'approval', outcome: String(outcome) as 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' })
      sendJson(res, ok ? 200 : 404, ok ? { id, answered: true } : { detail: '交互不存在或已应答' })
      return
    }
    if (kind === 'questions') {
      const answers = body.answers
      if (!Array.isArray(answers)) {
        sendJson(res, 400, { detail: 'answers 必须为数组' })
        return
      }
      const ok = bridge.answer(id, { kind: 'questions', answers: answers as { id: string; selected: string[]; custom?: string }[] })
      sendJson(res, ok ? 200 : 404, ok ? { id, answered: true } : { detail: '交互不存在或已应答' })
      return
    }
    sendJson(res, 400, { detail: 'kind 必须是 approval 或 questions' })
  }

  async function handleCancel(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    const session = registry.get(sessionId)
    if (session === undefined || session.agent === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    // 会话实际空闲（无进行中 turn，例如 fork 后 agent 尚未 followup、或上一次
    // chat 在 followup 前失败留下假 running）时，agent.cancel() 不会触发任何
    // turn/end → 内核状态永远不会回到 idle，UI 停在"正在工作"且无法停止。
    // 此时直接复位内核 idle + 清除 cancel_requested，让 UI 立即可继续。
    if (!session.busy) {
      await client.setChatState(sessionId, { status: 'idle', cancel_requested: false }).catch(() => {})
      sendJson(res, 200, { session_id: sessionId, status: 'stop_requested', reset: 'idle' })
      return
    }
    session.agent.cancel({ kind: 'user' })
    await client.setChatState(sessionId, { cancel_requested: true }).catch(() => {})
    sendJson(res, 200, { session_id: sessionId, status: 'stop_requested' })
  }

  async function handleAccess(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    const fullAccess = Boolean(body.full_access)
    const session = registry.get(sessionId)
    if (session === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    session.fullAccess = fullAccess
    await client.setChatState(sessionId, { full_access: fullAccess })
    sendJson(res, 200, { session_id: sessionId, full_access: fullAccess })
  }

  /** 推理等级即时切换（推理等级选择不随消息的路径：桌面独立请求）。 */
  async function handleEffort(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    const effort = normalizeEffort(body.reasoning_effort)
    const session = registry.get(sessionId)
    if (session === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    if (effort === undefined) {
      sendJson(res, 400, { detail: 'reasoning_effort 无效（off/high/max）' })
      return
    }
    session.reasoningEffort = effort
    sendJson(res, 200, { session_id: sessionId, reasoning_effort: effort })
  }

  /** Plan-mode 即时切换（对齐 DSH /plan 与 /plan off 的 command 语义：直接翻转 agent 状态，
   *  无需等下一消息才生效）。空闲会话立即 committed；执行中 queued 至下一被接受的 pre-step。 */
  async function handlePlanMode(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    const active = Boolean(body.plan_active)
    const session = registry.get(sessionId)
    if (session === undefined || session.agent === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    // 执行中切换（有进行中 turn / agent 在跑）：不即时落账。若此刻调 ctx.planMode.set，
    // 会被 dsh-plan-mode 排到「下一被接受的 pre-step」——即当前轮次的下一个 step 就生效，
    // 模型会突然收到 plan:policy 提示段、改写当前轮的行为（2026-09-06 实测事故：step12→13
    // 之间切 plan，模型下一步就改口「我切到 plan mode 做只读调查」并在 step 13 被 max-tokens
    // 截断）。与用户期望/DSH 语义一致：等本轮执行完（agent 回 idle）再落账，影响后续轮次。
    if (session.busy) {
      session.deferredPlan = active
      const current = ctx.planMode.get(session.agent)
      sendJson(res, 200, {
        session_id: sessionId,
        plan_active: current.active,
        plan_pending: current.active !== active,
        outcome: 'queued',
      })
      return
    }
    const outcome = ctx.planMode.set(session.agent, active)
    const state = ctx.planMode.get(session.agent)
    sendJson(res, 200, {
      session_id: sessionId,
      plan_active: state.active,
      plan_pending: state.pending,
      outcome,
    })
  }

  async function handleFlashConfirm(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    // 会话确认结束后显式烧录：仅转发到内核执行（待烧录登记一致性由内核校验）。
    const sessionId = String(body.session_id ?? '')
    const projectDir = String(body.project_dir ?? '')
    const port = String(body.port ?? '')
    if (registry.get(sessionId) === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    if (projectDir === '') {
      sendJson(res, 400, { detail: 'project_dir 不能为空' })
      return
    }
    try {
      const r = await client.confirmFlash(sessionId, projectDir, port)
      sendJson(res, 200, r)
    } catch (error: unknown) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleFlashDismiss(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    try {
      const r = await client.dismissFlash(sessionId)
      sendJson(res, 200, r)
    } catch (error: unknown) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /** git 三端点（阶段3 Phase3）：透传内核（session 存在性由内核按 cwd 校验）。 */
  async function handleGit(
    action: 'checkpoint' | 'rollback' | 'status',
    res: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = String(body.session_id ?? '')
    if (registry.get(sessionId) === undefined) {
      sendJson(res, 404, { detail: '会话不存在' })
      return
    }
    const projectDir = String(body.project_dir ?? '')
    try {
      let r: unknown
      if (action === 'checkpoint') {
        r = await client.gitCheckpoint(sessionId, String(body.message ?? 'session checkpoint'), projectDir)
      } else if (action === 'rollback') {
        r = await client.gitRollback(sessionId, String(body.commit ?? ''), projectDir)
      } else {
        r = await client.gitStatus(sessionId, projectDir)
      }
      sendJson(res, 200, r)
    } catch (error: unknown) {
      sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
    }
  }

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    const text = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  async function shutdown(): Promise<void> {
    console.log('[planner] 收到退出指令，正在停止')
    for (const s of registry.list()) {
      try {
        await s.handle?.dispose()
      } catch { /* 忽略单个会话清理失败 */ }
    }
    server.close()
    process.exit(0)
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {} as T
  return JSON.parse(raw) as T
}

/** 归一化推理等级：非法/缺省返回 undefined（沿用装配默认）。 */
function normalizeEffort(raw: unknown): ReasoningEffort | undefined {
  if (raw === 'off' || raw === 'high' || raw === 'max') return raw
  return undefined
}
