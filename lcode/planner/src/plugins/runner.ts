/**
 * 一次性任务 Runner（开发/联调用，agent核心开发文档 §1.9 产品命令形态）：
 * `dsh --profile lcode-planner "任务"` —— 新建并持久化一次性会话，打印最终 assistant
 * 回复后退出；不带任务参数时进入 server 模式（由 lcode-server 插件持有进程）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { PlannerEnv } from '../config.ts'
import type { SessionRegistry } from '../sessions.ts'

export const name = 'lcode-runner'

export interface Config {
  env: PlannerEnv
  registry: SessionRegistry
}

export function apply(ctx: Context, config: Config): void {
  // 嵌套插件上下文中 strict get 可能取不到宿主提供的服务，非严格 + argv 兜底。
  const cmdline = ctx.get('cmdlineArgs', false) as { args?: readonly string[] } | undefined
  const task = (cmdline?.args ?? taskFromArgv()).join(' ').trim()
  if (process.env.LCORE_TRACE === '1') {
    console.error(`[planner:trace] runner: task=${JSON.stringify(task)}`)
  }
  if (task === '') return // 无任务 → 常驻 server 模式

  void runOneShot(ctx, config.env, config.registry, task).then(
    (code) => exit(ctx, code),
    (error: unknown) => {
      console.error(`[planner] 一次性执行失败：${error instanceof Error ? error.message : String(error)}`)
      exit(ctx, 1)
    },
  )
}

/** 兜底：从 process.argv 提取 profile 之后的参数（跳过 --profile/--patch 及其值）。 */
function taskFromArgv(): string[] {
  const argv = process.argv.slice(2)
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile' || arg === '--patch') { i += 1; continue }
    if (arg.startsWith('-')) continue
    out.push(arg)
  }
  return out
}

function exit(ctx: Context, code: number): void {
  const appExit = ctx.get('appExit', false) as ((code: number) => void) | undefined
  if (appExit !== undefined) appExit(code)
  else process.exit(code)
}

async function runOneShot(ctx: Context, env: PlannerEnv, registry: SessionRegistry, task: string): Promise<number> {
  const trace = (label: string): void => {
    if (process.env.LCORE_TRACE === '1') console.error(`[planner:trace] runner: ${label}`)
  }
  // 注意：本 bundle 由 Loader 挂载，绝不能 await ctx.loader（自引用死锁）；
  // agents/sessions 已由外层 apply 顺序装配完毕，直接取用（非严格 get）。
  const agents = ctx.get('agents', false)
  const sessions = ctx.get('sessions', false)
  if (agents === undefined || sessions === undefined) {
    console.error('[planner] agents/sessions 服务缺失')
    return 1
  }
  trace('creating agent')
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: env.cwd },
    agentOptions: { provider: env.provider, model: env.model },
  })
  // M1b：一次性会话也登记进 SessionRegistry —— 顶层工具透传/子代理继承不再回落默认
  // （cwd/fullAccess 由本条目提供；task_id = 本会话 uuid，无内核时事件丢弃）。
  const sessionId = String(agent.id)
  registry.set({
    sessionId,
    cwd: env.cwd,
    fullAccess: true,
    title: task.slice(0, 30),
    agent,
    busy: false,
    createdAt: Date.now(),
    kind: 'session',
  })
  trace('agent created, waiting initial idle')
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  trace('following up')
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  trace('waiting turn idle')
  await agent.whenIdle()
  trace('flushing session')
  await sessions.flush(agent.session)
  trace('summarizing')
  const { text, reason } = summarize(agent.session.events, firstSeq)
  process.stdout.write(`${text}\n`)
  if (reason?.kind === 'error') {
    process.stderr.write(`[planner] ${reason.error.code}: ${reason.error.message}\n`)
    return 1
  }
  return reason?.kind === 'completed' ? 0 : 1
}

function summarize(
  events: readonly SessionEvent[],
  firstSeq: number,
): { text: string; reason?: SessionEvent<'turn/end'>['data']['reason'] } {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => (b as { text: string }).text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}
