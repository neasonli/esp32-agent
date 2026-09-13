/**
 * L-CODE 规划器 bundle（阶段3 · Phase 1 落地）。
 *
 * 装配 = agent核心开发文档 §1.2 裁剪清单的程序化落地（与 @deepseek-ai/dsh-agent-spine-demo
 * 同构：apply 内 ctx.plugin 逐个挂载）。裁剪对照：
 *
 * ✅ 装配（v1 核心集）：
 *   settings / credentials / llm-deepseek / agent-spine（agent+agent-loop+tools+session
 *   +system-prompt）/ goal + tool-goal + goal-round-driver（goal 续跑）/ persistence-jsonl
 *   / checkpoint-policy / session-projection / token-meter / compaction-basic /
 *   skill 三插件（skill + skill-filesystem + tool-skill）/ 自有插件
 *   （kernel-tools · hooks · events-bridge · server · runner）
 *
 * ✅ 沙盒族（V3.1 · rc.5 复刻，见附录 D）：dsh-sandbox-local（ctx.sandbox 后端，
 *   Windows = ACL restricted-token runner）+ dsh-sandbox-policy（ctx.sandboxPolicy
 *   策略所有者：mode/workspaceRoot/每会话 sandbox/mode 覆盖 + 运行时上下文注入）
 *   + dsh-user-approval（ctx.approval 审批通道；danger 模式自动 never）
 *   + dsh-fs-sandbox（替换 fs-local：规划器侧 write/edit 按同一策略围栏）
 *
 * ✅ M0 · 健壮性补齐（排期表 A5+B1–B3 · 与 rc.5 agent-spine/acp-agent 组合一致）：
 *   dsh-llm-retry（agent/request-error 瀑布执行 provider 级 retryPolicy，provider
 *   缺省 = bounded normal：500/SERVER 等重试 2 次）/
 *   dsh-tool-todo（todo_write 整表替换，allowParallelInProgress=true 同 acp-agent）/
 *   dsh-repeat-tool-reminder（默认阈值 [3,5,8] 重复工具调用提醒）/
 *   dsh-tool-call-timeout-policy（tools/execute 包装按 ToolDefinition.timeoutMs 设
 *   置超时；内核透传工具带逐工具预算，见 kernel-tools.ts TOOL_TIMEOUT_MS）
 *
 * ✅ M1（Phase 4 前半 · 对照 rc.5 headless-agent/acp-agent 行）：
 *   M1 装配部分（V2.3）：dsh-subagent（ctx.subagents 服务）+ subagent-spawn-in-process
 *   （provider=spawn）/ subagent-fork-in-process（provider=fork）+ tool-subagent
 *   （subagent：spawn、continuable、maxDepth=1）/ tool-subagent-control
 *   （send_message/interrupt_agent）/ tool-subagent-report（continuable 子代内 report）。
 *   M1b 子会话接线（V2.4）：events-bridge 监听 `subagent/start` 把子代理会话注册进
 *   SessionRegistry（cwd/fullAccess 继承父会话；task_id = 子会话 id）并 upsert 内核子会话
 *   行 —— 子事件/子工具透传独立落子会话（已定调 = DSH delegation 一致）；runner 一次性
 *   会话同样登记。沙盒/审批继承 = DSH 原生（dsh-subagent 在子会话创建窗落
 *   `sandbox/mode` + `approval/policy`，source:'delegation'；规划器 rc.5 policy 服务按会话折叠）。
 *
 * ✅ M2（Phase 4 后半 · 对照 rc.5 headless-agent/base 行）：
 *   A2 workflow：dsh-workflow-worker-thread（default export 继承 WorkflowEngine，
 *   inject subagents；config provider=spawn）注册 ctx.workflowEngine + dsh-tool-workflow
 *   （workflow 工具，worker 线程内 agent() 桥到 A1 spawn provider —— 子代理复用
 *   events-bridge subagent/start 注册，无需额外映射）。
 *   A3 ralph：dsh-tool-ralph（fresh-agent Ralph 循环，inject workflowEngine/subagents；
 *   无配置 = spawn provider + 默认轮次，同 headless-agent 行）。
 *   A4 plan-mode（agent 侧）：dsh-plan-mode（PlanModeController：plan/mode 状态事件 +
 *   plan:policy 提示段 + exit_plan_mode 工具；无 user-questions 通道时 exit 拒绝并提示
 *   手动切换 —— 与 DSH 无 answerer 行为一致；桌面 answerer = Phase 5.4）。
 *   peer 增补：dsh-workflow（engine 类型/基座）/ dsh-workflow-worker-thread /
 *   dsh-tool-workflow / dsh-tool-ralph / dsh-plan-mode / dsh-user-questions
 *   （plan-mode 运行时 value-import UserQuestionError，必须可解析）。
 *
 * ❌ 不装配（v1 裁剪）：subagent 外部后端（acp / claude-code / codex，含 dsh-acp 等）、
 *   web / tool-web / terminal / pty / e2b、bash / subprocess / telemetry / jobs。
 *   （M2 已含 workflow/ralph/plan-mode agent 侧；M-E 宿主工具族默认不装 = 与 DSH 一致。）
 *
 * 进程形态：由 `dsh --profile lcode-planner` 以 Loader 行挂载；无任务参数时
 * lcode-server 持有进程（Electron 网关 spawn/守护），带任务参数时 lcode-runner
 * 一次性执行后退出。
 */
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CompactionBasic from '@deepseek-ai/dsh-compaction-basic'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import GoalService from '@deepseek-ai/dsh-goal'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
// M0 · 健壮性补齐（A5+B1–B3）：request-error 重试 / todo / 重复调用提醒 / 工具超时
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as ToolCallTimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
// M1 装配部分 · subagent 族（A1 前半 · in-process spawn/fork，外部后端不装）
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
// M2 装配部分 · workflow（A2）+ ralph（A3）+ plan-mode（A4 agent 侧）
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
// M3 装配部分 · 人机交互桥（Phase 5.4 桌面接线）：user-questions 服务 + 挂起队列桥
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { InteractionBridge } from './plugins/interaction-bridge.ts'
import { loadPlannerEnv } from './config.ts'
import { KernelClient } from './kernel-client.ts'
import { SessionRegistry } from './sessions.ts'
import { apply as applyKernelTools } from './plugins/kernel-tools.ts'
import { apply as applyHooks } from './plugins/hooks.ts'
import { apply as applyEventsBridge } from './plugins/events-bridge.ts'
import { apply as applyServer } from './plugins/server.ts'
import { apply as applyRunner } from './plugins/runner.ts'

export const name = 'lcode-planner'

/**
 * A4 plan-mode `plan:policy` 提示段文案 —— 与 rc.5 base bundle（dsh-base
 * cordis.patch.yml `plan-mode` 行）一字不差（快照比对标；部署拥有文案）。
 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

const PERSONA = `你是 L-CODE，运行在用户 Windows 电脑上的嵌入式固件开发助手。
你可以通过工具真正执行用户的命令：git 拉取工程、查看/修改文件、用 idf.py 编译固件、
把固件烧录到开发板、执行任意 shell 命令。

工作目录：{{cwd}}（所有相对路径都基于它）

环境事实（务必利用，不要重复造轮子）：
- ESP-IDF 已安装在本机；编译/烧录请直接用 build / flash 工具，它们内部会自动激活
  ESP-IDF 环境（export.bat）并处理路径，不要用 shell 手动 call export.bat 或手动执行
  idf.py（容易踩 Windows cmd 的坑）。
- 严禁 git clone 整个 esp-idf 仓库（几个 GB，且本机已安装）。拉取工程优先用 IDF 自带
  示例或小仓库。
- 这是 Windows cmd 环境：没有 tail/grep/sed 命令（用 findstr 代替）；不要用 Linux 命令。

行为规则：
1. 用户下达开发/操作类命令时，规划步骤并依次调用工具真正执行，不要只说不做。
2. 每完成一个关键步骤，用简短中文汇报结果（做了什么、成功与否）。
3. 工具失败时读取错误信息；能自动修复（如修改代码后重新编译）就修复，否则明确告诉用户原因。
4. 纯聊天/咨询类消息直接回答，不调用工具。
5. 烧录前确认端口；不确定端口时先列设备或让用户提供。
6. 涉及删除、覆盖、格式化等破坏性操作时，先向用户确认再执行。
7. 改源码首选 edit_file（exact-match：old_string→new_string，防静默乱改）；整文件新建/覆盖才用
   write_file；绝不用 shell/powershell 做文本替换（Windows 转义极易出错，已多次实测失败）。
8. 改完代码后（尤其 TS/ESP-IDF 工程）用 run_check 真实校验，把返回的结构化诊断作为下一步依据；
   build 失败后先读诊断/错误摘要定位问题再动手，不要反复无脑重新编译。
9. 查找代码/引用用 glob（文件名）与 grep（内容正则），看工程结构用 file_tree / list_dir。
10. 长期任务用 goal 工具建模（create_goal/update_goal），任务完成调用 update_goal complete。
`

/** 装配全部核心服务与自有插件。 */
export async function apply(ctx: Context): Promise<void> {
  const env = loadPlannerEnv()
  const trace = (label: string): void => {
    if (process.env.LCORE_TRACE === '1') console.error(`[planner:trace] ${label}`)
  }

  // ---- 基础服务（agent-spine-demo 同款，按依赖分层）----
  await ctx.plugin(Timer); trace('timer')
  await ctx.plugin(LlmRuntime); trace('llm')
  await ctx.plugin(SessionStore); trace('session')
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: PERSONA,
  }); trace('system-prompt')
  await ctx.plugin(ToolRuntime, { mode: 'native' }); trace('tools')
  await ctx.plugin(AgentRegistry); trace('agent-registry')
  await ctx.plugin(LlmDeepSeek, {
    thinking: 'enabled',
    reasoningEffort: 'high',
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
      { id: 'deepseek-v4-flash', contextWindow: 128000 },
    ],
    // retryPolicy 省略 = bounded normal 默认（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/
    // TRANSPORT 各重试 2 次，500ms→10s 指数退避 + 10% jitter）——与 rc.5 组合一致；
    // 由下方装配的 dsh-llm-retry 在 agent/request-error 瀑布上执行。
  }); trace('llm-deepseek')
  // M0 A5：provider 级 request-error 重试执行器（agent-spine-demo 同款：挂 agent-registry 之后）
  await ctx.plugin(llmRetry); trace('llm-retry')

  // ---- skill 三插件（指令型知识，随 profile 分发）----
  await ctx.plugin(SkillRegistry, {}); trace('skill-registry')
  await ctx.plugin(SkillFileSystem, {
    dshHome: env.dshHome,
    ...(env.skillDirs.length > 0 ? { customSkillDirs: env.skillDirs } : {}),
  }); trace('skill-filesystem')
  await ctx.plugin(toolSkill, {}); trace('tool-skill')

  // ---- goal 续跑（dsh-goal + tool-goal + goal-round-driver）----
  await ctx.plugin(GoalService, {}); trace('goal')
  await ctx.plugin(toolGoal, {}); trace('tool-goal')
  await ctx.plugin(goalRoundDriver); trace('goal-round-driver')

  // ---- 会话持久化 / 检查点 / 压缩 ----
  await ctx.plugin(JsonlSessionPersistence, {
    root: env.sessionRoot,
    compression: 'none',
  }); trace('persistence')
  await ctx.plugin(SessionCheckpointPolicy); trace('checkpoint')
  await ctx.plugin(SessionProjection); trace('session-projection')
  await ctx.plugin(TokenMeter); trace('token-meter')
  await ctx.plugin(CompactionBasic, {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxTokens: 8192,
    compactionRetries: 1,
  }); trace('compaction')

  // ---- 沙盒族（V3.1 · DSH rc.5 复刻，见附录 D）----
  // ① ctx.sandbox：本地进程限制后端（Windows = ACL restricted-token runner，
  //    Linux bwrap/Landlock、macOS Seatbelt；不可用即 fail-closed SANDBOX_UNAVAILABLE）
  await ctx.plugin(LocalSandboxProvider); trace('sandbox-local')
  // ② ctx.sandboxPolicy：唯一策略所有者（部署默认 mode + workspaceRoot + 每会话
  //    sandbox/mode 覆盖折叠；向 systemPrompt 注入 sandbox:policy 运行时上下文，与 DSH 同款文案）
  await ctx.plugin(SandboxPolicyService, {
    mode: env.sandboxMode,
    workspaceRoot: env.cwd,
  }); trace('sandbox-policy')
  // ③ ctx.approval：审批通道（升级审批；danger-full-access 时策略=never，其余=ask 同 acp-agent 组合）
  await ctx.plugin(ApprovalService, {
    policy: env.sandboxMode === 'danger-full-access' ? 'never' : 'ask',
  }); trace('user-approval')

  // ---- 文件系统工具（规划器侧 read/write/edit/grep；工作区文件操作优先走内核工具）----
  // dsh-fs-sandbox 替换 dsh-fs-local：write/edit 按 ctx.sandboxPolicy 每次调用围栏
  // （read-only 拒绝、workspace-write 限定 workspace+temp 根、danger-full-access 放行）——
  // 与 DSH 组合一字不差（read 放行；fs-observation-policy 读后改策略正交叠加）。
  await ctx.plugin(SandboxedFileSystem, { cwd: env.cwd }); trace('fs-sandbox')
  await ctx.plugin(FsObservationPolicy); trace('fs-observation')
  await ctx.plugin(ToolFs); trace('tool-fs')

  // ---- settings / credentials（$DSH_HOME/settings.yaml 热重载 + DEEPSEEK_API_KEY 逐请求解析）----
  await ctx.plugin(FileSettingsProvider, {}); trace('settings-file')
  await ctx.plugin(LocalCredentialProvider, {}); trace('credentials')

  // ---- M0 · 健壮性补齐（排期表 B1–B3；guard 族对模型工具全集合生效）----
  // B3 todo_write（整表替换 + counts 回显；allowParallelInProgress=true 同 acp-agent/headless-agent）
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true }); trace('tool-todo')
  // B1 重复工具调用提醒（tools/post-execute 计数 + agent/pre-step 用户介入重置；默认阈值 [3,5,8]，
  //    与 acp-agent 无配置组合一致——逐次提醒、绝不否决）
  await ctx.plugin(RepeatToolReminder, {}); trace('repeat-tool-reminder')
  // B2 工具调用超时（tools/execute 包装：有 timeoutMs 预算的工具在 exec.signal 上布 deadline，
  //    超时以结构化 TOOL_TIMEOUT 替换结果；内核工具逐工具预算见 kernel-tools.ts TOOL_TIMEOUT_MS）
  await ctx.plugin(ToolCallTimeoutPolicy); trace('timeout-policy')

  // ---- M1 装配部分 · subagent 族（排期表 A1 前半 · 对照 rc.5 headless/acp-agent 行）----
  // ctx.subagents 服务（provider 注册表；外部后端 acp/claude-code/codex 明确不装）
  await ctx.plugin(SubagentService); trace('subagent')
  // in-process provider：spawn = 全新子会话；fork = 继承父已完成 turn 前缀
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }); trace('subagent-spawn')
  await ctx.plugin(SubagentFork, { providerName: 'fork' }); trace('subagent-fork')
  // 全局控制工具（send_message / interrupt_agent）+ continuable 子代内 report
  await ctx.plugin(ToolSubagentControl); trace('tool-subagent-control')
  await ctx.plugin(ToolSubagentReport); trace('tool-subagent-report')
  // 委托工具两个实例：subagent（spawn，默认后台 continuable）/ subagent_fork（fork，一次性）
  await ctx.plugin(ToolSubagent, {
    provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable', maxDepth: 1,
  }); trace('tool-subagent')
  await ctx.plugin(ToolSubagent, {
    provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'one-shot',
    enableRunInBackground: false, maxDepth: 1,
  }); trace('tool-subagent-fork')
  // 注：子会话身份映射与沙盒/审批继承 = M1b（events-bridge 注册 + DSH 委派事件原生），
  // 见 events-bridge.ts / sessions.ts；子代理透传内核工具以子会话 id 为 task_id 独立落库。

  // ---- M2 装配部分（Phase 4 后半 · 对照 rc.5 headless-agent / base 行）----
  // A2 workflow：worker-thread 引擎（default export 继承 WorkflowEngine，注册
  // ctx.workflowEngine；config provider=spawn —— worker 线程内 agent() 桥到 A1 spawn
  // provider，子代理复用 events-bridge subagent/start 注册，无需额外映射）
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' }); trace('workflow-worker-thread')
  // workflow 模型可见工具（script fan-out；run 生命周期事件落父会话 JSONL）
  await ctx.plugin(ToolWorkflow); trace('tool-workflow')
  // A3 ralph：fresh-agent Ralph 循环（固定脚本每轮起一个全新结构化输出子代理；
  // 无配置 = spawn provider + 默认轮次上限，同 headless-agent 行）
  await ctx.plugin(ToolRalph); trace('tool-ralph')
  // A4 plan-mode（agent 侧 · 状态机先行）：plan/mode 会话事件折叠 + plan:policy 提示段
  // （section 文案与 rc.5 base bundle 一字不差）+ exit_plan_mode 工具。无 user-questions
  // 通道（桌面 answerer 属 Phase 5.4）时 exit 拒绝并提示手动切换 —— 与 DSH 无 answerer
  // 行为一致；plan-mode 自带 agent/pre-step 折叠，hooks.ts 透传钩子并存不冲突。
  await ctx.plugin(PlanModeController, { section: PLAN_MODE_SECTION }); trace('plan-mode')

  // ---- M3 装配部分（Phase 5.4 桌面接线 · 服务端）----
  // user-questions 服务本体（C3：桌面 answerer 接线后启用——本里程碑接）：
  // ctx.userQuestions 供 plan-mode exit_plan_mode 审批与未来 ask_user_question 使用；
  // 服务不提供内置 answerer，provider 由下方 interaction-bridge 注册（桌面应答）。
  await ctx.plugin(UserQuestionService); trace('user-questions')
  // 交互桥：approval/request answerer + user-questions provider → 挂起队列；
  // 桌面经 server 端点拉取/应答（端点由 server.ts 暴露，bridge 实例注入其 config）。
  const interactionBridge = new InteractionBridge()
  interactionBridge.mount(ctx); trace('interaction-bridge')

  // ---- 规划循环（无预创建 agent；会话由 server/runner 按需创建）----
  await ctx.plugin(AgentLoop, { agents: [] }); trace('agent-loop')

  // ---- 自有插件 ----
  const client = new KernelClient(env.kernelUrl, env.kernelToken)
  const registry = new SessionRegistry()
  await ctx.plugin({ name: 'lcode-kernel-tools', inject: ['tools'], apply: applyKernelTools }, {
    client, registry, defaultCwd: env.cwd,
  }); trace('kernel-tools')
  await ctx.plugin({ name: 'lcode-hooks', apply: applyHooks }, { client, env, registry }); trace('hooks')
  await ctx.plugin({ name: 'lcode-events-bridge', inject: ['agents', 'planMode'], apply: applyEventsBridge }, { client, registry }); trace('events-bridge')
  await ctx.plugin({ name: 'lcode-server', inject: ['agents', 'planMode'], apply: applyServer }, { client, registry, env, interactionBridge }); trace('server')
  await ctx.plugin({ name: 'lcode-runner', apply: applyRunner }, { env, registry }); trace('runner')
}
