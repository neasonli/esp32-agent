/**
 * M3 · 人机交互桥（Phase 5.4 桌面接线 · agent 侧服务端）：
 *
 * 把 planner 进程内的两处「等人应答」通道暴露成可被桌面轮询/应答的挂起队列，
 * answerer 语义与 DSH rc.5 原包完全一致（approval/request 瀑布 + userQuestions
 * provider），本桥只是把"应答者"接到桌面 UI：
 *
 * - `approval/request` answerer：ctx.approval（user-approval，V3.1 已装）在 ask
 *   策略下进入 `approval/request` 瀑布时，本桥把请求挂起（pending），桌面经
 *   `GET /api/planner/interactions` 拉到待审批项、用户点选后
 *   `POST /{id}/answer {outcome}` 应答 → 桥 resolve → ApprovalService 落
 *   approval/asked + approval/decided 审计对（原包语义，无 L-CODE 自定义改动）。
 *   无应答者注册时默认 fail-closed unavailable（与 rc.5 一致）；本桥注册即
 *   answerer，桌面不在线时交互悬起直至 abort（工具超时/用户取消兜底）。
 *
 * - user-questions provider：装配 `dsh-user-questions` 服务（C3：桌面 answerer
 *   接线后启用）并 registerProvider——`exit_plan_mode`（plan 审阅）与未来的
 *   ask_user_question 工具都走这里；桌面拉到问题、用户应答后
 *   `POST /{id}/answer {answers}` 回填。
 *
 * 会话归属：交互对象带 agent.session，bridge 以 sessionId 分组（桌面只轮询
 * 当前活动会话即可，避免跨会话串扰）。abort 语义：请求 signal 中止时该 pending
 * 立即取消（approval → 'cancelled'；questions → 拒绝），晚到的桌面应答被丢弃。
 *
 * 端点由 server.ts 暴露（本文件只提供服务对象 + answerer/provider 挂载）：
 *   GET  /api/planner/interactions[?session_id=]  → 该会话待应答交互列表（只读快照）
 *   POST /api/planner/interactions/{id}/answer    → {outcome}（approval）或 {answers}（questions）
 *
 * 运行位置：`planner/src/plugins/`，由 index.ts apply 顺序装配（approval 服务之后）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

export const name = 'lcode-interaction-bridge'

/** 待应答交互的只读视图（给 server/桌面；settle 保持在实例内部）。 */
export type PendingInteraction =
  | {
    id: string
    kind: 'approval'
    sessionId: string
    toolName: string
    callId?: string
    reason?: string
    createdAt: number
  }
  | {
    id: string
    kind: 'questions'
    sessionId: string
    questions: AskUserQuestionItem[]
    createdAt: number
  }

interface PendingEntry {
  view: PendingInteraction
  settle: (value: ApprovalOutcome | AskUserQuestionAnswer) => void
  aborted: () => void
}

/** answer() 的合法载荷：approval outcome 或 user-questions answers。 */
export type InteractionAnswer = { kind: 'approval'; outcome: ApprovalOutcome }
  | { kind: 'questions'; answers: AskUserQuestionAnswer['answers'] }

/**
 * 挂起队列服务：answerer 在此登记等待，桌面经 answer() 放行。
 * 一个 planner 进程持有一个实例（index.ts 创建，传给 bridge 挂载与 server）。
 */
export class InteractionBridge {
  private readonly pending = new Map<string, PendingEntry>()

  /** 只读快照（可按会话过滤；approval 排前、questions 在后，均按创建序）。 */
  list(sessionId?: string): PendingInteraction[] {
    const out: PendingInteraction[] = []
    for (const entry of this.pending.values()) {
      if (sessionId !== undefined && entry.view.sessionId !== sessionId) continue
      out.push(entry.view)
    }
    return out
  }

  /** 桌面应答：找到并放行该交互。未找到（已取消/已答）返回 false（幂等丢弃）。 */
  answer(id: string, answer: InteractionAnswer): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    if (answer.kind === 'approval') {
      entry.settle(answer.outcome)
    } else {
      entry.settle({ answers: answer.answers })
    }
    return true
  }

  /** 挂起一个 approval/request（answerer 用）。 */
  private askApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const id = randomUUID()
    const sessionId = String(request.agent.session.id)
    return new Promise<ApprovalOutcome>((resolve) => {
      if (request.signal?.aborted) {
        resolve('cancelled')
        return
      }
      const entry: PendingEntry = {
        view: {
          id,
          kind: 'approval',
          sessionId,
          toolName: request.toolName,
          ...request.callId !== undefined ? { callId: String(request.callId) } : {},
          ...request.reason !== undefined ? { reason: request.reason } : {},
          createdAt: Date.now(),
        },
        settle: (value) => resolve(value as ApprovalOutcome),
        aborted: () => {
          if (this.pending.delete(id)) resolve('cancelled')
        },
      }
      this.pending.set(id, entry)
      request.signal?.addEventListener('abort', entry.aborted, { once: true })
    })
  }

  /** 挂起一个 user-questions ask（provider 用）。 */
  private askQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const id = randomUUID()
    const sessionId = request.agent === undefined
      ? ''
      : String(request.agent.session.id)
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new Error('interaction aborted'))
        return
      }
      const entry: PendingEntry = {
        view: {
          id,
          kind: 'questions',
          sessionId,
          questions: request.questions,
          createdAt: Date.now(),
        },
        settle: (value) => resolve(value as AskUserQuestionAnswer),
        aborted: () => {
          if (this.pending.delete(id)) reject(new Error('interaction aborted'))
        },
      }
      this.pending.set(id, entry)
      request.signal?.addEventListener('abort', entry.aborted, { once: true })
    })
  }

  /** 挂载 answerer + provider（在 approval / user-questions 服务装配后调用）。 */
  mount(ctx: Context): void {
    // approval/request answerer：返回 ApprovalOutcome（allowed-once/rejected/cancelled）。
    ctx.on('approval/request', (request: ApprovalRequest) => this.askApproval(request))

    // user-questions provider：ctx.userQuestions 服务装配后才存在。
    const userQuestions = ctx.get('userQuestions', false) as {
      registerProvider: (p: { ask(r: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }) => () => void
    } | undefined
    if (userQuestions !== undefined) {
      userQuestions.registerProvider({ ask: (r) => this.askQuestions(r) })
    }
  }
}
