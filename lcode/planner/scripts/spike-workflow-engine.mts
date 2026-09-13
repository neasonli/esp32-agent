/**
 * M2 A2 · worker-thread Windows spike（不经 LLM / 不经工具）：
 * 程序化装配 dsh-subagent(spawn) + dsh-workflow-worker-thread，直接
 * ctx.workflowEngine.start() 跑一段最小 fan-out 脚本，验证：
 * 1. worker 线程（tsx data-URL 引导分支）在 Windows 能真正启动；
 * 2. 脚本内 agent() 能经 spawn provider 创建子代理并完成（复用 A1 基建）；
 * 3. workflow/start、workflow/agent-start、workflow/agent-end、workflow/end 事件齐备。
 *
 * 运行（cwd=DSH checkout，解析 @deepseek-ai/* 经 planner/node_modules junction）：
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\spike-workflow-engine.mts
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, GenerateOptions, LlmResolvedModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

const trace = (label: string): void => console.error(`[spike] ${label}`)

/** 极简脚本化 LLM：无论收到什么请求都回「stub-ok」。 */
class StubAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'stub' } }
  listModels(): Promise<readonly never[]> { return Promise.resolve([]) }
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = 'stub-ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ctx = new Context()
await ctx.plugin(Timer)
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt, { persona: 'You are a stub coding agent.' })
await ctx.plugin(ToolRuntime, { mode: 'native' })
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
// 注册 stub provider 路由（替代 llm-deepseek；spawn 子代理走同 provider）
ctx.llm.registerAdapter(['stub-official'], new StubAdapter())
// A1 基建：subagent + spawn provider（worker-thread 引擎 inject subagents）
await ctx.plugin(SubagentService)
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
// A2 引擎：ctx.workflowEngine（默认 provider=spawn）
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
trace('mounted; ctx.workflowEngine=' + String(ctx.workflowEngine !== undefined))
trace('subagents providers=' + String(ctx.subagents.listProviders ? ctx.subagents.listProviders() : 'n/a'))

// 手动创建一个父代理（供 workflow parent 引用）
const { agent: parent } = await ctx.agents.create({
  sessionId: SessionId(`session-${Date.now()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: 'stub-official', model: 'stub' },
})

const events: string[] = []
ctx.on('workflow/start' as never, (info: { id: string }) => { events.push(`start:${String(info.id).slice(0, 8)}`) })
ctx.on('workflow/phase' as never, (_i: unknown, title: string) => { events.push(`phase:${title}`) })
ctx.on('workflow/log' as never, (_i: unknown, msg: string) => { events.push(`log:${msg}`) })
ctx.on('workflow/agent-start' as never, (_i: unknown, a: { seq: number; label?: string }) => { events.push(`agent-start:${a.seq}:${a.label ?? ''}`) })
ctx.on('workflow/agent-end' as never, (_i: unknown, a: { seq: number; outcome: string }) => { events.push(`agent-end:${a.seq}:${a.outcome}`) })
ctx.on('workflow/end' as never, (_i: unknown, r: { stopReason: string; agentsStarted: number }) => { events.push(`end:${r.stopReason}:${r.agentsStarted}`) })

const script = `
phase('fan-out')
const a = agent('Round one: reply stub-ok.')
const b = agent('Round two: reply stub-ok.')
const [ra, rb] = await Promise.all([a, b])
log('a=' + JSON.stringify(ra))
return { a: ra, b: rb }
`

trace('starting workflow run')
const run = ctx.workflowEngine.start({
  script,
  meta: { name: 'spike-fanout', description: 'windows worker-thread spike' },
  parent,
})
const settled = await run.result
trace('workflow settled stopReason=' + settled.stopReason + ' agentsStarted=' + settled.agentsStarted)
trace('events:')
for (const e of events) trace('  ' + e)
await run.dispose()
await ctx.fiber.dispose()
if (settled.stopReason !== 'completed' || settled.agentsStarted !== 2) {
  console.error('SPIKE_FAIL stopReason=' + settled.stopReason)
  process.exit(1)
}
if (!events.some(e => e.startsWith('agent-start:')) || !events.some(e => e.startsWith('agent-end:'))) {
  console.error('SPIKE_FAIL missing agent lifecycle events')
  process.exit(1)
}
console.log('SPIKE_OK events=' + JSON.stringify(events))
process.exit(0)
