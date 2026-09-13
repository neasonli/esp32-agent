/**
 * M3 出口 E2E（不经真实 LLM / 不经内核，但走真实 agent-loop）：
 * 程序化装配与 index.ts 等价的核心面（core + plan-mode + user-questions 服务 +
 * InteractionBridge + 脚本化 stub LLM），验证 plan-mode「桌面审批」端到端闭环：
 *
 *   用户消息前 planMode.set(agent,true)（committed，plan/mode active:true 落会话）
 *   → followup 触发 turn → 桩首请求返回 exit_plan_mode 工具调用（带 # 标题 plan）
 *   → execute 经 ctx.userQuestions.ask() 挂起（桥 provider；不再抛"无通道"）
 *   → 主线程轮询 bridge.list() 发现 questions pending（plan-review intent）
 *   → bridge.answer(approve label 'Approve') → ask resolve → exit 获批
 *   → 下个 in-turn pre-step 折叠 plan/mode active:false
 *   → 桩第二轮请求收尾 DONE → turn/end completed
 *
 * 断言：plan/mode 事件 ≥2（先 true 后 false，最后 inactive）；tool/call exit_plan_mode；
 * tool/result 非错误（approve 路径）；turn completed。这证明"桌面应答"让
 * exit_plan_mode 真正获批（M2 无通道时同场景是拒绝，见 e2e-m2 plan-mode）。
 *
 * 运行（cwd=DSH checkout）：
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\e2e-m3.mts
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
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { InteractionBridge } from '../src/plugins/interaction-bridge.ts'

const trace = (label: string): void => console.error(`[e2e-m3] ${label}`)

/** 脚本化 stub：父会话首请求 → exit_plan_mode；后续 → DONE。 */
class ScriptedAdapter extends LlmAdapter {
  private readonly counts = new Map<string, number>()
  constructor(private readonly parentSessionId: string) { super() }
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'scripted' } }
  listModels(): Promise<readonly never[]> { return Promise.resolve([]) }
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = options.sessionId === undefined ? '' : String(options.sessionId)
    const count = (this.counts.get(sid) ?? 0) + 1
    this.counts.set(sid, count)
    if (sid === this.parentSessionId && count === 1) {
      trace('父首请求 → exit_plan_mode 工具调用')
      const callId = CallId('call-exit')
      const raw = JSON.stringify({ plan: '# Stub Plan\n\nDo nothing concrete.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'exit_plan_mode', argumentsDelta: raw }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'exit_plan_mode', arguments: raw } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    trace(`父会话第 ${count} 次请求 → DONE`)
    const t = 'DONE'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: t }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function run(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are a stub coding agent.' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  // M3：装配 user-questions 服务 + 桥（approval/questions answerer → 桌面挂起队列）
  await ctx.plugin(UserQuestionService)
  const bridge = new InteractionBridge()
  bridge.mount(ctx)
  await ctx.plugin(PlanModeController, {
    section: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode.',
  })
  trace('服务装配完成')

  const parent = (await ctx.agents.create({
    sessionId: SessionId(`e2e-m3-${Date.now()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: 'scripted-official', model: 'stub' },
  })).agent
  const parentSid = String(parent.id)
  const adapter = new ScriptedAdapter(parentSid)
  ctx.llm.registerAdapter(['scripted-official'], adapter)
  await parent.whenIdle()
  trace(`父代理已建 ${parentSid}`)

  const firstSeq = parent.session.seq
  const outcome = ctx.planMode.set(parent, true)
  trace(`plan-mode set → ${outcome}`)
  if (outcome !== 'committed') throw new Error(`E2E_M3_FAIL plan-mode set outcome=${outcome}`)

  parent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Plan the stub work and finish via exit_plan_mode.' }],
    source: { kind: 'user' },
  }))
  trace('turn 已 followup；等待 questions 挂起（桌面拉取点）…')

  // 模拟桌面轮询：等待桥里出现 questions pending（plan-review）。
  let answered = false
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const pending = bridge.list(parentSid).filter(i => i.kind === 'questions')
    if (pending.length > 0) {
      const first = pending[0] as Extract<typeof pending[number], { kind: 'questions' }>
      const q = first.questions[0]
      trace(`桌面拉到 questions：id=${first.id} intent=${q?.intent?.kind ?? 'none'} approve=${q?.intent?.approve ?? '-'}`)
      if (q?.intent?.kind !== 'plan-review') throw new Error(`E2E_M3_FAIL intent 不是 plan-review：${JSON.stringify(q?.intent ?? null)}`)
      const approveLabel = q.intent.approve
      const ok = bridge.answer(first.id, {
        kind: 'questions',
        answers: [{ id: q.id, selected: [approveLabel] }],
      })
      trace(`桥应答（approve=${approveLabel}）命中=${ok}`)
      if (!ok) throw new Error('E2E_M3_FAIL answer 未命中')
      answered = true
      break
    }
    await new Promise(r => setTimeout(r, 50))
  }
  if (!answered) throw new Error('E2E_M3_FAIL 桌面轮询超时未发现 questions pending')

  await parent.whenIdle()
  trace('turn 结束')
  const events = parent.session.events.filter(e => e.seq >= firstSeq)
  const types = events.map(e => e.type)
  trace(`事件类型 = ${[...new Set(types)].join(', ')}`)

  const fail = (why: string): never => { throw new Error(`E2E_M3_FAIL ${why}`) }
  const planModes = events.filter(e => e.type === 'plan/mode')
  trace(`plan/mode 事件数=${planModes.length}，末条=${JSON.stringify((planModes.at(-1) as SessionEvent<'plan/mode'> | undefined)?.data ?? null)}`)
  if (planModes.length < 2) fail('plan/mode 未经历进入+退出两态')
  if ((planModes.at(-1) as SessionEvent<'plan/mode'> | undefined)?.data.active !== false) {
    fail('exit 获批后 plan/mode 未折叠为 inactive')
  }
  if (!types.includes('tool/call') || !events.some(e => e.type === 'tool/call' && e.data.name === 'exit_plan_mode')) {
    fail('父未调用 exit_plan_mode')
  }
  const exitResult = events.find(e => e.type === 'tool/result')
  const exitErr = exitResult?.data.message.content.some(b =>
    b.type === 'tool-result' && b.isError === true)
  trace(`exit_plan_mode 工具结果 isError=${exitErr ?? 'n/a'}`)
  if (exitErr) fail('exit_plan_mode 走错了拒绝路径（期望 approve 成功）')
  const endReason = (events.findLast(e => e.type === 'turn/end') as SessionEvent<'turn/end'> | undefined)?.data.reason
  if (endReason?.kind !== 'completed') fail(`turn 未正常完成：${JSON.stringify(endReason)}`)
  trace('PASS')
  await ctx.fiber.dispose()
  console.log('E2E_M3_PASS')
  process.exit(0)
}

await run().then(
  () => { process.exit(0) },
  (error: unknown) => {
    console.error(`E2E_M3_FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
