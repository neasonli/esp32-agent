/**
 * 最小复现：不走 profile/loader，直接程序化装配核心 + deepseek LLM，驱动一轮对话。
 * 用于隔离"核心循环 vs 装配"问题（@deepseek-ai/* 需可解析：把本文件复制到
 * $DSH_HOME/profiles/lcode-planner/ 下运行）。
 * 运行：node --import tsx/esm <本文件>
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const trace = (l: string) => console.error(`[repro] ${l}`)

const ctx = new Context()
await ctx.plugin(Timer)
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent. Keep answers brief.' })
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LlmDeepSeek, {
  thinking: 'enabled',
  reasoningEffort: 'high',
  models: [{ id: 'deepseek-v4-flash', contextWindow: 128000 }],
})
await ctx.plugin(AgentLoop, { agents: [] })
trace('all mounted, creating agent')
const { agent } = await ctx.agents.create({
  sessionId: SessionId('repro-1'),
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})
trace('agent created')
await agent.whenIdle()
trace('idle; following up')
agent.followup(createUserMessage({ content: [{ type: 'text', text: '只回复两个字：OK' }], source: { kind: 'user' } }))
trace('waiting turn')
await agent.whenIdle()
trace('turn done')
const last = agent.session.events.findLast(e => e.type === 'assistant/message')
console.log('FINAL:', last?.data.message.content)
await ctx.fiber.dispose()
trace('disposed')
