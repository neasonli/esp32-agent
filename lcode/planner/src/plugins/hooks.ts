/**
 * 规划器钩子插件（agent核心开发文档 §1.4 瀑布钩子协议的落地）：
 * - `agent/request`       —— 组装每次模型请求（provider/model 兜底、maxTokens 收敛）
 * - `agent/request-error` —— 模型请求失败瀑布（M0 A5：透传下游决策；装配的 dsh-llm-retry
 *   在链上执行 provider 级 retryPolicy，{kind:'retry'} 时循环在同一 step 内重试）
 * - `agent/pre-step`      —— 步骤进入决策（v1 透传；后续权限策略/plan-mode 在这里插）
 * - `agent/turn-stopping` —— 轮次收尾（把 turn 计数同步回内核会话，UI 进度可见）
 */
import type { Context, Events } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { KernelClient } from '../kernel-client.ts'
import type { PlannerEnv } from '../config.ts'
import type { SessionRegistry } from '../sessions.ts'

export const name = 'lcode-hooks'

export interface Config {
  client: KernelClient
  env: PlannerEnv
  /** 会话注册表（按 agent.id 反查会话级推理等级，覆写每次模型请求）。 */
  registry?: SessionRegistry
}

export function apply(ctx: Context, config: Config): void {
  const { client, env } = config

  // 请求瀑布：兜底 provider/model（agent 创建时未显式指定也能跑），并收敛 maxTokens。
  ctx.on('agent/request', async (payload, next) => {
    const proposed: LlmCallConfig = await next()
    const effort = config.registry?.get(String(payload.agent.id))?.reasoningEffort
    return {
      ...proposed,
      provider: proposed.provider || env.provider,
      model: proposed.model || env.model,
      // 会话级推理等级（桌面「推理等级」选择）：有值时覆写每次模型请求。
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      // 输出预算：16384。实测 4096 在 thinking=high 下会被推理占用大半，正文（如 plan-mode
      // 长叙述 / 详细修复说明）写到一半就触发 max-tokens 截断，turn/end reason=max-tokens 且
      // 无可见事件 → UI 表现为「agent 半句话停住、无规划弹窗、无法继续」（2026-09-06 实测事故）。
      ...(proposed.maxTokens === undefined ? { maxTokens: 16384 } : {}),
    }
  })

  // 请求失败瀑布（M0 A5）：本钩子参与 `agent/request-error` 链（默认透传下游决策）。
  // dsh-llm-retry（已装配）在同一链上按 provider retryPolicy 决定 {kind:'retry'} 或放行；
  // 这里只做可观测性记录，不改写任何失败语义（放行 = 保留原始失败，由 agent-loop 收尾）。
  ctx.on('agent/request-error', async (
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (process.env.LCORE_TRACE === '1') {
      const policy = payload.retryPolicy === undefined
        ? 'no-policy'
        : payload.retryPolicy.mode === 'normal'
          ? `normal(max=${payload.retryPolicy.maxRetries})`
          : 'always'
      console.error(`[planner:trace] agent/request-error ${payload.provider} ${payload.failure.code} ` +
        `turn=${payload.turn} step=${payload.step} policy=${policy}`)
    }
    return await next()
  })

  // 步骤进入瀑布：v1 透传。后续把「权限策略 / plan-mode 先规划后执行 / 会话确认」
  // 等横切能力插在这里（返回 {kind:'reject'} 可阻止本步进入）。
  ctx.on('agent/pre-step', async (payload, next) => {
    void payload
    return await next()
  })

  // 轮次收尾：把已完成 turn 数同步回内核会话（chat_steps），桌面端进度展示不变。
  ctx.on('agent/turn-stopping', async (payload) => {
    const { agent, turn } = payload
    await syncSteps(client, agent, turn).catch(() => { /* 内核不可达不阻断轮次 */ })
  })
}

async function syncSteps(client: KernelClient, agent: Agent, turn: number): Promise<void> {
  await client.setChatState(String(agent.id), { chat_steps: turn })
}
