/**
 * 规划器 → Python 内核的本地 HTTP 客户端（X-Kernel-Token 鉴权，与现有内核一致）。
 *
 * 端点契约（新增于 lcode/kernel/api/main.py，agent核心开发文档 §1.8）：
 * - POST /api/planner/tool/{name}   底座/领域工具透传（参数/结果 JSON）
 * - POST /api/planner/event         规划层事件写入内核 events 表（桌面 500ms 轮询不变）
 * - POST /api/planner/chat_message  规划层消息落库（chat_messages 表，UI 历史不变）
 * - POST /api/planner/chat_session  会话 upsert（chat_sessions 表）
 * - POST /api/planner/chat_state    会话状态同步（status/waiting_confirm/chat_steps/…）
 * - GET  /api/planner/info          内核信息（outputs_dir / llm / idf）
 */
export class KernelClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['X-Kernel-Token'] = this.token
    return h
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const j = await res.json() as { detail?: string }
        if (typeof j.detail === 'string') detail = j.detail
      } catch { /* 非 JSON 响应保留状态文本 */ }
      throw new Error(`kernel ${method} ${path} -> ${res.status}: ${detail}`)
    }
    return await res.json() as T
  }

  /**
   * 执行内核工具（build/flash/shell/read_file/edit_file/run_check/…）。
   * @param signal 可选 AbortSignal（M0 B2：dsh-tool-call-timeout-policy 布在 exec.signal
   *   上的 deadline 会中止本次 HTTP 往返；中止以 AbortError 抛出，由超时策略替换为
   *   结构化 TOOL_TIMEOUT 结果）。
   */
  async tool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
    fullAccess: boolean,
    taskId = '',
    sandbox?: { mode: string; workspace_root: string; session_id: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result?: string; error?: string; denied?: boolean }> {
    return await this.request('POST', `/api/planner/tool/${encodeURIComponent(name)}`, {
      cwd, args, full_access: fullAccess, task_id: taskId,
      ...sandbox ? { sandbox } : {},
    }, signal)
  }

  /** 写一条内核事件（task_id = 规划器会话 id，桌面事件轮询直接可见）。 */
  async addEvent(
    taskId: string,
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    node = '',
    eventType = '',
    payload?: Record<string, unknown> | null,
  ): Promise<void> {
    await this.request('POST', '/api/planner/event', {
      task_id: taskId, level, message, node, event_type: eventType, payload: payload ?? undefined,
    })
  }

  /** 追加一条聊天消息（user/assistant/tool；tool 行带 tool_name/tool_call_id）。 */
  async appendChatMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    toolName = '',
    toolCallId = '',
  ): Promise<void> {
    await this.request('POST', '/api/planner/chat_message', {
      session_id: sessionId, role, content, tool_name: toolName, tool_call_id: toolCallId,
    })
  }

  /** upsert 会话；session_id 为空时由内核生成。返回 { session_id, cwd, full_access }。 */
  async upsertChatSession(
    sessionId: string,
    cwd: string,
    fullAccess: boolean,
    title = '',
  ): Promise<{ session_id: string; cwd: string; full_access: boolean }> {
    return await this.request('POST', '/api/planner/chat_session', {
      session_id: sessionId, cwd, full_access: fullAccess, title,
    })
  }

  /** 内核侧会话分支：以 atMessageId 为锚点复制会话前缀到新会话（chat_messages 权威层）。 */
  async forkChat(sessionId: string, atMessageId: number): Promise<{ session_id: string }> {
    return await this.request('POST', '/api/chat_fork', {
      session_id: sessionId, at_message_id: atMessageId,
    })
  }

  /** 同步会话状态字段（只更新传入的字段）。 */
  async setChatState(sessionId: string, patch: {
    status?: 'idle' | 'running'
    waiting_confirm?: boolean
    chat_steps?: number
    cancel_requested?: boolean
    full_access?: boolean
  }): Promise<void> {
    await this.request('POST', '/api/planner/chat_state', { session_id: sessionId, ...patch })
  }

  /** 会话确认结束后显式启动烧录（防误烧；内核后台执行，flash/* 事件经 events 表回流）。 */
  async confirmFlash(sessionId: string, projectDir: string, port = ''):
    Promise<{ session_id: string; status: string }> {
    return await this.request('POST', '/api/planner/flash_confirm', {
      session_id: sessionId, project_dir: projectDir, port,
    })
  }

  /** 取消待烧录（清除登记，不执行烧录）。 */
  async dismissFlash(sessionId: string): Promise<{ session_id: string; status: string }> {
    return await this.request('POST', '/api/planner/flash_dismiss', { session_id: sessionId })
  }

  /** 工作区 git 会话 checkpoint（阶段3 Phase3）：git 化 + add/commit；返回 repo/commit 信息。 */
  async gitCheckpoint(
    sessionId: string,
    message = 'session checkpoint',
    projectDir = '',
  ): Promise<{ session_id: string; repo: boolean; commit?: string | null }> {
    return await this.request('POST', '/api/planner/git_checkpoint', {
      session_id: sessionId, message, project_dir: projectDir,
    })
  }

  /** 会话回滚（显式，用户触发）：回滚工作区到指定/上一 checkpoint。 */
  async gitRollback(
    sessionId: string,
    commit = '',
    projectDir = '',
  ): Promise<{ session_id: string; ok: boolean; message: string }> {
    return await this.request('POST', '/api/planner/git_rollback', {
      session_id: sessionId, commit, project_dir: projectDir,
    })
  }

  /** 只读 git 状态（桌面「回滚」入口展示）。 */
  async gitStatus(sessionId: string, projectDir = ''): Promise<Record<string, unknown>> {
    return await this.request('POST', '/api/planner/git_status', {
      session_id: sessionId, project_dir: projectDir,
    })
  }

  /** 读取内核信息（默认工作目录、LLM、IDF 配置）。 */
  async getInfo(): Promise<{
    outputs_dir: string
    llm_model: string
    llm_base_url: string
    idf_path: string
    idf_target: string
  }> {
    return await this.request('GET', '/api/planner/info')
  }

  /**
   * 读取内核单个会话详情（planner 懒恢复登记用：重启后登记表为空，旧会话按
   * session_id 取 cwd/title/full_access 重建 SessionRegistry 条目，可继续对话/分支）。
   * 会话不存在时 request() 抛 404（调用方据此判定不可恢复）。
   * 注意：详情返回 messages 数组（含角色/content），不含 msg_count（msg_count 仅
   * Home 列表接口有）——空消息判定用 messages.length，别沿用 list 口径。
   */
  async getChatSessionDetail(sessionId: string): Promise<{
    session_id: string
    title: string
    cwd: string
    status: string
    full_access: boolean
    messages: unknown[]
  }> {
    return await this.request('GET', `/api/chat_session?session_id=${encodeURIComponent(sessionId)}`)
  }
}
