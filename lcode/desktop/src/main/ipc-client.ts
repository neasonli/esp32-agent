/**
 * 本地 HTTP 客户端（W1 骨架）
 *
 * 与内核的本地 HTTP 通信封装：统一带上 X-Kernel-Token 鉴权头。
 * 仅供主进程使用（D19：渲染进程不直接调内核）。
 */
export class KernelHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export class IpClient {
  constructor(
    private getBaseUrl: () => string | null,
    private getToken: () => string
  ) {}

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const base = this.getBaseUrl()
    if (!base) throw new KernelHttpError(0, '内核未就绪')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Kernel-Token': this.getToken(),
      ...(options.headers as Record<string, string> | undefined)
    }
    const res = await fetch(base + path, { ...options, headers })
    if (!res.ok) throw new KernelHttpError(res.status, `内核接口错误: ${res.status}`)
    return res
  }

  async health(): Promise<Record<string, unknown>> {
    const res = await this.request('/api/health')
    return res.json()
  }

  async submitTask(requirement: string, workspaceId = ''): Promise<{ task_id: string; status: string }> {
    const res = await this.request('/api/run_task', {
      method: 'POST',
      body: JSON.stringify({ user_requirement: requirement, workspace_id: workspaceId })
    })
    return res.json()
  }

  async cancelTask(taskId: string): Promise<{ status: string }> {
    const res = await this.request('/api/cancel_task', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId })
    })
    return res.json()
  }

  async resumeTask(taskId: string, fullRestart: boolean): Promise<{ status: string; resume: string }> {
    const res = await this.request('/api/resume_task', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, full_restart: fullRestart })
    })
    return res.json()
  }

  async deleteTasks(taskIds: string[]): Promise<{ deleted: number; skipped: string[] }> {
    const res = await this.request('/api/delete_tasks', {
      method: 'POST',
      body: JSON.stringify({ task_ids: taskIds })
    })
    return res.json()
  }

  async getResult(taskId: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/get_result?task_id=${taskId}`)
    return res.json()
  }

  async getEvents(taskId: string, afterSeq: number): Promise<{ events: any[] }> {
    const res = await this.request(`/api/events?task_id=${taskId}&after_seq=${afterSeq}`)
    return res.json()
  }

  async getConversations(): Promise<{ conversations: unknown[] }> {
    const res = await this.request('/api/conversations')
    return res.json()
  }

  async getConversation(taskId: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/conversation?task_id=${taskId}`)
    return res.json()
  }

  /** 对话式 Agent（阶段2 W3）：发送消息/命令（可新建会话，full_access 仅在新建时生效） */
  async chat(
    message: string,
    sessionId = '',
    fullAccess?: boolean,
    cwd?: string
  ): Promise<{ session_id: string; status: string }> {
    const res = await this.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        message,
        // 精简模式兜底：新建会话时绑定工作区（内核回落 outputs_dir 会导致工程散落）
        cwd: sessionId ? undefined : cwd,
        full_access: sessionId ? undefined : fullAccess
      })
    })
    return res.json()
  }

  /** 会话分支（精简模式用内核侧实现：复制锚点前消息前缀开新会话） */
  async forkChat(sessionId: string, atMessageId: number): Promise<{ session_id: string }> {
    const res = await this.request('/api/chat_fork', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, at_message_id: atMessageId })
    })
    return res.json()
  }

  async getChatSessions(): Promise<{ sessions: unknown[] }> {
    const res = await this.request('/api/chat_sessions')
    return res.json()
  }

  async getChatSession(sessionId: string): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/chat_session?session_id=${sessionId}`)
    return res.json()
  }

  /** 删除对话会话（含消息历史/事件，不可恢复）——清理不在规划器内的死会话 */
  async deleteChatSessions(sessionIds: string[]): Promise<{ deleted: number }> {
    const res = await this.request('/api/chat_delete', {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds })
    })
    return res.json()
  }

  async cancelChat(sessionId: string): Promise<{ session_id: string; status: string }> {
    const res = await this.request('/api/chat_cancel', {
      method: 'POST',
      body: JSON.stringify({ task_id: sessionId })
    })
    return res.json()
  }

  async setChatAccess(sessionId: string, fullAccess: boolean): Promise<{ session_id: string; full_access: boolean }> {
    const res = await this.request('/api/chat_access', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, full_access: fullAccess })
    })
    return res.json()
  }

  /** 查询当前配置（LLM + 并发数 + ESP-IDF，W2 补全） */
  async getKernelConfig(): Promise<Record<string, unknown>> {
    const res = await this.request('/api/config')
    return res.json()
  }

  /** ESP-IDF 环境检测：deep=true 会真跑一次 `idf.py --version`（较慢） */
  async probeEnv(deep = false): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/env_probe?deep=${deep ? 'true' : 'false'}`)
    return res.json()
  }

  /** 列出 LLM 端点可用模型（OpenAI 兼容 GET /models；端点不支持则由内核回退预置清单） */
  async listLlmModels(): Promise<Record<string, unknown>> {
    const res = await this.request('/api/llm/models')
    return res.json()
  }

  /** 测试 LLM 连通性（一次极小真实调用；返回 served_model = 服务端实际用的模型） */
  async probeLlm(model?: string): Promise<Record<string, unknown>> {
    const q = model && model.trim() !== '' ? `?model=${encodeURIComponent(model.trim())}` : ''
    const res = await this.request(`/api/llm/probe${q}`)
    return res.json()
  }

  async updateLlmConfig(cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.request('/api/config', {
      method: 'POST',
      body: JSON.stringify(cfg)
    })
    return res.json()
  }

  async getWorkspaces(): Promise<{ workspaces: unknown[] }> {
    const res = await this.request('/api/workspaces')
    return res.json()
  }

  async shutdown(): Promise<void> {
    await this.request('/api/shutdown', { method: 'POST' }).catch(() => undefined)
  }
}
