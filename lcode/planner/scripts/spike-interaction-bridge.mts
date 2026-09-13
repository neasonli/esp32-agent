/**
 * M3 · interaction-bridge E2E（不经 HTTP / 不经内核）：
 * 程序化装配 ApprovalService + UserQuestionService + InteractionBridge，
 * 验证：
 * 1. approval：open turn 内 ctx.approval.request() → bridge.list 出现 pending →
 *    bridge.answer(allowed-once) → request resolve 'allowed-once'，audit 对落会话；
 * 2. questions：ctx.userQuestions.ask()（无 agent）→ bridge.list 出现 pending →
 *    bridge.answer(answers) → ask resolve answers；
 * 3. abort：pending 的 signal 中止 → request resolve 'cancelled' / ask 拒绝，晚到 answer 丢弃。
 * 运行：node --import tsx/esm <本文件>（cwd=DSH checkout）
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { InteractionBridge } from '../src/plugins/interaction-bridge.ts'

const trace = (label: string): void => console.error(`[bridge-e2e] ${label}`)

const ctx = new Context()
await ctx.plugin(Timer)
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(ApprovalService, { policy: 'ask' })
await ctx.plugin(UserQuestionService)
const bridge = new InteractionBridge()
bridge.mount(ctx)
trace('装配完成')

const session = ctx.sessions.create(SessionId(`bridge-${Date.now()}`))
session.append('turn/start', { turn: 1 })
const agent = { session } as never

// ---- 1. approval 路 ----
const approvalPromise = ctx.approval.request({
  agent,
  toolName: 'read_file',
  callId: CallId('call-a'),
  reason: 'escalate sandbox to workspace-write: need write for the stub',
})
await new Promise(r => setTimeout(r, 50))
const pendingApprovals = bridge.list(String(session.id)).filter(i => i.kind === 'approval')
trace(`approval pending 数量=${pendingApprovals.length}`)
if (pendingApprovals.length !== 1) throw new Error('BRIDGE_FAIL approval 未挂起')
const aId = pendingApprovals[0]!.id
const answered = bridge.answer(aId, { kind: 'approval', outcome: 'allowed-once' })
if (!answered) throw new Error('BRIDGE_FAIL approval answer 未命中')
const outcome = await approvalPromise
trace(`approval outcome=${outcome}`)
if (outcome !== 'allowed-once') throw new Error('BRIDGE_FAIL approval outcome=' + outcome)
const audit = session.events.filter(e => e.type.startsWith('approval/'))
trace(`audit 事件=${audit.map(e => e.type).join(',')} outcome=${audit.at(-1)?.data.outcome}`)
if (audit.length !== 2 || audit.at(-1)?.data.outcome !== 'allowed-once') throw new Error('BRIDGE_FAIL audit 对不完整')

// ---- 2. questions 路（无 agent） ----
const questionPromise = ctx.userQuestions.ask({
  questions: [{
    id: 'q1', question: 'Approve the plan?', detail: '# Stub Plan',
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }],
})
await new Promise(r => setTimeout(r, 50))
const pendingQs = bridge.list().filter(i => i.kind === 'questions')
trace(`questions pending 数量=${pendingQs.length}`)
if (pendingQs.length !== 1) throw new Error('BRIDGE_FAIL questions 未挂起')
const qId = pendingQs[0]!.id
bridge.answer(qId, { kind: 'questions', answers: [{ id: 'q1', selected: ['Approve'] }] })
const qAnswer = await questionPromise
trace(`questions answer=${JSON.stringify(qAnswer.answers)}`)
if (qAnswer.answers[0]?.selected[0] !== 'Approve') throw new Error('BRIDGE_FAIL questions answer 未回填')

// ---- 3. abort 路 ----
const ac = new AbortController()
const abortPromise = ctx.approval.request({
  agent, toolName: 'write_file', reason: 'will be aborted', signal: ac.signal,
}).then(o => o, () => 'rejected-err')
await new Promise(r => setTimeout(r, 50))
ac.abort()
const abortOutcome = await abortPromise
trace(`abort approval outcome=${abortOutcome}`)
if (abortOutcome !== 'cancelled') throw new Error('BRIDGE_FAIL abort 未 cancelled')
if (bridge.list(String(session.id)).length !== 0) throw new Error('BRIDGE_FAIL abort 后队列未清')

trace('PASS')
await ctx.fiber.dispose()
console.log('BRIDGE_PASS')
process.exit(0)
