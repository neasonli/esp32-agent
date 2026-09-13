/**
 * M3 · HTTP 通道端到端 spike（不经真实 LLM，但走真实 server.apply + HTTP）：
 * 程序化装配 SessionStore + ApprovalService + UserQuestionService + InteractionBridge，
 * 再装配 lcode-server（真实端点代码，interactionBridge 注入），验证桌面经 HTTP 应答
 * approval 的完整链路：
 *
 *   open turn 内 ctx.approval.request()（工具升级审批）→ 桥挂起
 *   → HTTP GET  /api/planner/interactions?session_id=… 拉到 pending（kind=approval）
 *   → HTTP POST /api/planner/interactions/answer {kind:'approval', outcome:'allowed-once'}
 *   → request resolve 'allowed-once' → approval/decided 审计对落会话
 *
 * server.apply 的其它端点（chat/flash/git…）不经内核即不可用，本 spike 只走
 * interactions 两端点（它们只碰 bridge，不依赖内核）。
 *
 * 运行（cwd=DSH checkout）：
 *   node --import tsx/esm D:\1_ai_project\mcu_ai_agent\lcode\planner\scripts\spike-http-answer.mts
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { KernelClient } from '../src/kernel-client.ts'
import { SessionRegistry } from '../src/sessions.ts'
import { loadPlannerEnv } from '../src/config.ts'
import { apply as applyServer } from '../src/plugins/server.ts'
import { InteractionBridge } from '../src/plugins/interaction-bridge.ts'

const trace = (label: string): void => console.error(`[http-answer] ${label}`)
const basePort = 8891

const ctx = new Context()
await ctx.plugin(Timer)
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry) // server.apply inject ['agents'] 需要 ctx.agents
await ctx.plugin(ApprovalService, { policy: 'ask' })
await ctx.plugin(UserQuestionService)
const bridge = new InteractionBridge()
bridge.mount(ctx)

// 真实 server 端点：KernelClient 指向不可达端口（interactions 端点不触碰内核）。
const kernelUrl = `http://127.0.0.1:${basePort - 1}`
const env = {
  ...loadPlannerEnv(),
  kernelUrl,
  kernelToken: 'x',
  port: basePort,
  token: 'spike-token',
  cwd: process.cwd(),
}
const client = new KernelClient(kernelUrl, 'x')
const registry = new SessionRegistry()
await ctx.plugin({ name: 'lcode-server', inject: ['agents'], apply: applyServer }, {
  client, registry, env, interactionBridge: bridge,
})
// server.listen 异步：等待 HTTP 端口就绪。
const readyUrl = `http://127.0.0.1:${basePort}/api/planner/health`
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(readyUrl, { headers: { 'X-Planner-Token': 'spike-token' } })
    if (r.ok) break
  } catch { /* not ready yet */ }
  await new Promise(r => setTimeout(r, 100))
}
trace(`server 已起：http://127.0.0.1:${basePort}`)

// open turn 会话 + fake agent（approval.request 前提：turn 已开）。
const session = ctx.sessions.create(SessionId('http-approval'))
session.append('turn/start', { turn: 1 })
const agent = { session } as never
const approvalPromise = ctx.approval.request({
  agent,
  toolName: 'write_file',
  reason: 'escalate sandbox to workspace-write: stub reason',
})
await new Promise(r => setTimeout(r, 100))

// 桌面：HTTP 拉取
const listUrl = `http://127.0.0.1:${basePort}/api/planner/interactions?session_id=${encodeURIComponent(String(session.id))}`
const listRes = await fetch(listUrl, { headers: { 'X-Planner-Token': 'spike-token' } })
if (!listRes.ok) throw new Error(`HTTP_ANSWER_FAIL GET ${listRes.status}`)
const list = (await listRes.json()) as { interactions: unknown[] }
trace(`GET interactions → ${JSON.stringify(list)}`)
if (list.interactions.length !== 1) throw new Error('HTTP_ANSWER_FAIL 未拉到 pending approval')
const first = list.interactions[0] as { id: string; kind: string; sessionId: string; toolName: string }
if (first.kind !== 'approval' || first.toolName !== 'write_file') {
  throw new Error(`HTTP_ANSWER_FAIL 形状不符 ${JSON.stringify(first)}`)
}

// 桌面：HTTP 应答 allowed-once
const answerRes = await fetch(
  `http://127.0.0.1:${basePort}/api/planner/interactions/answer`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Planner-Token': 'spike-token' },
    body: JSON.stringify({ id: first.id, kind: 'approval', outcome: 'allowed-once' }),
  },
)
if (!answerRes.ok) throw new Error(`HTTP_ANSWER_FAIL POST ${answerRes.status}`)
trace(`POST answer → ${await answerRes.text()}`)

const outcome = await approvalPromise
trace(`approval outcome=${outcome}`)
if (outcome !== 'allowed-once') throw new Error(`HTTP_ANSWER_FAIL outcome=${outcome}`)
const audit = session.events.filter(e => e.type.startsWith('approval/'))
if (audit.length !== 2 || audit.at(-1)?.data.outcome !== 'allowed-once') {
  throw new Error('HTTP_ANSWER_FAIL 审计对不完整')
}
trace('PASS')
// 经 shutdown 端点干净关闭（server.close 后再 process.exit，避免 Windows libuv
// 句柄清理断言）；shutdown 内部遍历 registry（空）后 server.close + exit 0。
await fetch(`http://127.0.0.1:${basePort}/api/planner/shutdown`, {
  method: 'POST',
  headers: { 'X-Planner-Token': 'spike-token' },
}).catch(() => {})
console.log('HTTP_ANSWER_PASS')
// shutdown 会异步 exit；此处兜底（若 shutdown 进程内未生效则直接退出）。
setTimeout(() => process.exit(0), 500)
