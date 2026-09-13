/**
 * 规划器侧会话注册表：规划器会话 id == DSH SessionId == 内核 chat_session_id（三端同 ID，
 * agent核心开发文档 §5.2：task_id == session_id 打通）。
 */
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'

/** 推理等级（reasoning effort，参照 DSH effort 档位；llm-deepseek 支持 off/high/max）。 */
export type ReasoningEffort = 'off' | 'high' | 'max'

export interface PlannerSession {
  sessionId: string
  cwd: string
  fullAccess: boolean
  title: string
  agent?: Agent
  handle?: AgentHandle
  busy: boolean
  createdAt: number
  /** 会话形态（M1b）：普通会话 / 子代理会话（DSH delegation）。 */
  kind?: 'session' | 'subagent'
  /** 子代理会话的父会话 id（= 父 planner 会话 sessionId）。 */
  parentId?: string
  /** 本会话推理等级（reasoning effort）；缺省不覆写（用装配默认）。 */
  reasoningEffort?: ReasoningEffort
  /**
   * 执行中（agent 正在跑、有 open turn）由用户发起的 plan-mode 切换意图：
   * 只记录不即时落账，等本轮 turn/end（agent 回 idle）后由 events-bridge 落账
   * （对齐 DSH「Plan 影响后续轮次」语义，避免执行中途模型突然收到 plan:policy 提示段
   * 而改变行为——2026-09-06 实测事故）。undefined = 无待生效意图。
   */
  deferredPlan?: boolean
}

export class SessionRegistry {
  private readonly map = new Map<string, PlannerSession>()

  get(sessionId: string): PlannerSession | undefined {
    return this.map.get(sessionId)
  }

  set(session: PlannerSession): void {
    this.map.set(session.sessionId, session)
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId)
  }

  list(): PlannerSession[] {
    return [...this.map.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** agent 反查会话（工具执行上下文用；agent.id == sessionId）。 */
  forAgent(agent: Agent): PlannerSession | undefined {
    return this.map.get(String(agent.id))
  }
}
