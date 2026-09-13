/**
 * M2 出口 E2E（不经真实 LLM / 不经内核）：
 * 程序化装配与 index.ts 等价的核心面（timer/llm/session/system-prompt/tools/agent/
 * agent-loop + subagent(spawn) + workflow-worker-thread + tool-workflow + tool-ralph +
 * plan-mode），以「脚本化 stub LLM」驱动完整 agent-loop，分三场景冒烟：
 *
 *   workflow  —— 父首请求返回 workflow 工具调用（脚本 fan-out 两个 agent 子代理）→
 *                子代理各自完成（stub 文本）→ workflow 完成 → 父收尾 DONE；
 *                断言会话 tool/call workflow + workflow/start·agent-start·agent-end·end +
 *                turn/end completed。
 *   ralph     —— 父首请求返回 ralph 工具调用（objective）→ Ralph 引擎每轮起 fresh child
 *                （spawn structured，tools 含 structured_output）→ stub 回 complete report →
 *                一轮即完成 → 父收尾 DONE。
 *   plan-mode —— planMode.set(agent,true) 落 plan/mode 事件 → 请求组装含 plan:policy 段
 *                （stub 记录 system 文本断言）→ 模型（stub）调 exit_plan_mode →
 *                无 user-questions 通道 = 拒绝（与 DSH 无 answerer 一致）→ 父收尾 DONE。
 *
 * 运行（cwd=DSH checkout）：
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\e2e-m2.mts workflow
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\e2e-m2.mts ralph
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\e2e-m2.mts plan-mode
 * 任一场景退出码非 0 = 失败（stderr 有 E2E_FAIL 行）。
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, GenerateOptions, LlmResolvedModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const trace = (label: string): void => console.error(`[e2e-m2] ${label}`)
const scenario = process.argv[2] ?? ''
if (!['workflow', 'ralph', 'plan-mode'].includes(scenario)) {
  console.error('usage: e2e-m2.mts <workflow|ralph|plan-mode>')
  process.exit(2)
}

/** 脚本化 stub：按会话 id 分组路由（父会话固定；子代理为新会话）。 */
class ScriptedAdapter extends LlmAdapter {
  /** 父会话 id → 该会话已请求次数。 */
  private readonly parentCounts = new Map<string, number>()
  /** 收到的 system 文本（plan-mode 断言用）。 */
  readonly systems: string[] = []
  constructor(private readonly parentSessionId: string, private readonly scenarioName: string) {
    super()
  }
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'scripted' } }
  listModels(): Promise<readonly never[]> { return Promise.resolve([]) }
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = options.sessionId === undefined ? '' : String(options.sessionId)
    if (options.system !== undefined) this.systems.push(options.system)
    const isParent = sid === this.parentSessionId
    const count = (this.parentCounts.get(sid) ?? 0) + 1
    if (isParent) this.parentCounts.set(sid, count)
    const toolNames = (options.tools ?? []).map(t => t.name)

    // ralph / workflow 子代理（structured child）带 structured_output 工具：回 complete report。
    if (!isParent && toolNames.includes('structured_output')) {
      trace(`child(sid=${sid.slice(0, 8)}) structured_output 调用`)
      yield* this.toolCall('structured_output', {
        status: 'complete', summary: 'ralph-done', evidence: ['stub-evidence'],
        nextSteps: [], blocker: '',
      }, 'call-structured')
      return
    }
    // 非父会话普通子代理：回复文本 stub-ok。
    if (!isParent) {
      yield* this.text('stub-ok')
      return
    }
    // 父会话：首请求 → 触发场景工具调用；后续请求（已带工具结果）→ DONE。
    if (count === 1) {
      if (this.scenarioName === 'workflow') {
        trace('父首请求 → workflow 工具调用')
        const script = [
          "phase('fan-out')",
          "const results = await Promise.all([",
          "  agent('Round one: reply stub-ok.'),",
          "  agent('Round two: reply stub-ok.'),",
          '])',
          'return results',
        ].join('\n')
        yield* this.toolCall('workflow', {
          script,
          meta: { name: 'e2e-fanout', description: 'two parallel stub agents' },
        }, 'call-wf')
        return
      }
      if (this.scenarioName === 'ralph') {
        trace('父首请求 → ralph 工具调用')
        yield* this.toolCall('ralph', { objective: 'stub objective: report done.' }, 'call-ralph')
        return
      }
      trace('父首请求（plan-mode）→ 调 exit_plan_mode')
      yield* this.toolCall('exit_plan_mode', {
        plan: '# Stub Plan\n\nDo nothing.',
      }, 'call-exit')
      return
    }
    trace(`父会话第 ${count} 次请求 → DONE`)
    yield* this.text('DONE')
  }

  private async *text(t: string): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: t }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async *toolCall(name: string, args: Record<string, unknown>, id: string): AsyncGenerator<StreamChunk> {
    const callId = CallId(id)
    const raw = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: raw }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: raw } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function runScenario(name: string): Promise<void> {
  const workdir = await mkdtemp(join(tmpdir(), `e2e-m2-${name}-`))
  const ctx = new Context()
  try {
    await ctx.plugin(Timer)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {
      persona: 'You are a stub coding agent. Reply briefly and use tools when asked.',
    })
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
    await ctx.plugin(ToolWorkflow)
    await ctx.plugin(ToolRalph)
    await ctx.plugin(PlanModeController, {
      section: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode.',
    })
    trace(`${name}: 服务装配完成`)

    const parent = (await ctx.agents.create({
      sessionId: SessionId(`e2e-${name}-${Date.now()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'scripted-official', model: 'stub' },
    })).agent
    const parentSid = String(parent.id)
    const adapter = new ScriptedAdapter(parentSid, name)
    ctx.llm.registerAdapter(['scripted-official'], adapter)
    await parent.whenIdle()
    trace(`${name}: 父代理已建 ${parentSid}`)

    // firstSeq 在一切本场景写入（plan-mode set 会 append）之前捕获，断言不漏过滤。
    const firstSeq = parent.session.seq

    // plan-mode：先落 plan/mode 事件（空闲窗口 committed），再 followup 触发 turn。
    if (name === 'plan-mode') {
      const outcome = ctx.planMode.set(parent, true)
      trace(`plan-mode set → ${outcome}`)
      if (outcome !== 'committed') throw new Error(`E2E_FAIL plan-mode set outcome=${outcome}`)
    }

    parent.followup(createUserMessage({
      content: [{ type: 'text', text: name === 'workflow'
        ? 'Use the workflow tool to run a fan-out of two subagents and report their replies.'
        : name === 'ralph'
          ? 'Run a ralph loop toward the stub objective.'
          : 'Plan the stub work, then finish.' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    trace(`${name}: turn 结束`)

    const events = parent.session.events.filter(e => e.seq >= firstSeq)
    const types = events.map(e => e.type)
    trace(`${name}: 事件类型 = ${[...new Set(types)].join(', ')}`)
    trace(`${name}: turn/end = ${JSON.stringify(types.includes('turn/end') ? (events.findLast(e => e.type === 'turn/end') as SessionEvent<'turn/end'> | undefined)?.data.reason : '（无）')}`)

    const fail = (why: string): never => { throw new Error(`E2E_FAIL ${why}`) }

    if (name === 'workflow') {
      if (!types.includes('tool/call')) fail('无工具调用')
      const call = events.find(e => e.type === 'tool/call' && e.data.name === 'workflow')
      if (call === undefined) fail('父未调用 workflow 工具')
      // fan-out 子代理生命周期以 tool-workflow/* 录制事件断言（workflow/* 为 ctx 级引擎事件，
      // 不进会话日志；录制层把 agent-start/agent-end 投影为 tool-workflow/agent-*）。
      const agentStarts = events.filter(e => e.type === 'tool-workflow/agent-start').length
      const agentEnds = events.filter(e => e.type === 'tool-workflow/agent-end').length
      const runStart = events.some(e => e.type === 'tool-workflow/run-start')
      const runEnd = events.find(e => e.type === 'tool-workflow/run-end')
      trace(`tool-workflow 录制：run-start=${runStart} agent-start=${agentStarts} agent-end=${agentEnds} run-end=${JSON.stringify(runEnd?.data ?? null)}`)
      if (!runStart || agentStarts !== 2 || agentEnds !== 2 || runEnd === undefined) {
        fail('workflow fan-out 生命周期事件不齐（期望 2 子代理）')
      }
      const endReason = (events.findLast(e => e.type === 'turn/end') as SessionEvent<'turn/end'> | undefined)?.data.reason
      if (endReason?.kind !== 'completed') fail(`turn 未正常完成：${JSON.stringify(endReason)}`)
    } else if (name === 'ralph') {
      if (!types.includes('tool/call')) fail('无工具调用')
      if (!events.some(e => e.type === 'tool/call' && e.data.name === 'ralph')) fail('父未调用 ralph 工具')
      const results = events.filter(e => e.type === 'tool/result')
      const ralphResult = results.find(e => {
        const b = e.data.message.content[0]
        return b?.type === 'tool-result' && b.content.some(c => c.type === 'text' && c.text.includes('Ralph worker reported completion'))
      })
      trace(`ralph 完成文本出现在工具结果：${ralphResult !== undefined}`)
      if (ralphResult === undefined) fail('ralph 工具结果未含完成报告')
      const endReason = (events.findLast(e => e.type === 'turn/end') as SessionEvent<'turn/end'> | undefined)?.data.reason
      if (endReason?.kind !== 'completed') fail(`turn 未正常完成：${JSON.stringify(endReason)}`)
    } else {
      // plan-mode
      const planEvents = events.filter(e => e.type === 'plan/mode')
      trace(`plan/mode 事件数=${planEvents.length}（含 turn 前 committed 应 ≥1）`)
      if (planEvents.length < 1) fail('会话无 plan/mode 事件')
      const activeNow = planEvents.at(-1) as SessionEvent<'plan/mode'> | undefined
      if (activeNow?.data.active !== true) fail('plan/mode 未保持 active')
      const systemSeen = adapter.systems.some(s => s.includes('plan mode'))
      trace(`模型请求 system 含 plan:policy 段：${systemSeen}`)
      if (!systemSeen) fail('plan 模式下请求未注入 plan:policy 提示段')
      const exitCall = events.find(e => e.type === 'tool/call' && e.data.name === 'exit_plan_mode')
      if (exitCall === undefined) fail('父未调用 exit_plan_mode')
      const exitResult = events.find(e => e.type === 'tool/result')
      const exitErr = exitResult !== undefined && exitResult.data.message.content.some(b =>
        b.type === 'tool-result' && (b.isError === true || JSON.stringify(b.content).includes('no user-questions channel')))
      trace(`exit_plan_mode 无通道拒绝：${exitErr}`)
      if (!exitErr) fail('exit_plan_mode 未按无通道拒绝（期望 no user-questions channel 错误）')
    }
    trace(`${name}: PASS`)
  } finally {
    await ctx.fiber.dispose()
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

await runScenario(scenario).then(
  () => { console.log(`E2E_PASS ${scenario}`); process.exit(0) },
  (error: unknown) => {
    console.error(`E2E_FAIL ${scenario}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
