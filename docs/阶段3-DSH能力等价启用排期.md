# 阶段 3 · DSH agent 处理能力等价：差距 → 启用排期表（V2.6）

> 基线：本地 DSH checkout `deepseek-harness-master`（**v0.1.0-rc.5**，`@deepseek-ai/dsh-*`）。
> 依据：`agent核心开发文档.md` §1.2/§1.7/第 8 章 + 附录 D + `lcode/planner/src/index.ts` 实际装配对照 +
> rc.5 monorepo `packages/*` 真实包清单（包名均已核实在本地树中存在）。
>
> **V2.2（M0 落地）**：A5（request-error + llm-retry）与 B1/B2/B3（重复工具提醒 / 工具调用
> 超时策略 / todo）已装配（全部 rc.5 原包 + 自有接线），出口三件套经本地 E2E 冒烟验证
> （注入 500 → `llm/retry` 自动重试；连续 3 次相同 `todo_write` → 重复提醒注入后续请求；
> `todo/write` 事件落会话 JSONL），详见 §9 附录 E。§1/§2/§3/§7 行状态已同步。
>
> **V2.3（M1 装配部分落地）**：A1 subagent 族**装配部分**完成（§10 附录 F）——`dsh-subagent`
> 服务 + in-process spawn/fork 后端 + `tool-subagent`（subagent/subagent_fork）+
> `tool-subagent-control`（send_message/interrupt_agent）+ `tool-subagent-report`，模型可见
> 工具与 rc.5 默认基座一致；"派子代理"（spawn 全新子会话 / fork 继承已完成轮次）本地 E2E
> 冒烟通过。**剩余 = M1b 结构性改造**：子会话身份映射（task_id 按子会话解析：sessions.ts /
> kernel-tools.ts / events-bridge.ts）与沙盒/审批继承（source:'delegation'）；子会话事件归属
> **已定调 = 子会话独立落库（与 DSH delegation 一致）**。§1/§2/§7 行状态已同步。
>
> **V2.4（M1b 子会话接线落地 = M1 全量）**：A1 全部四项完成（§11 附录 G）——events-bridge 监听
> `subagent/start` 把子代理会话注册进 SessionRegistry（cwd/fullAccess 继承父会话；task_id =
> 子会话 id）并 upsert 内核子会话行（子事件/子工具透传独立落子会话）；runner 一次性会话同样
> 登记（顶层工具透传/子代理继承不再回落默认）。沙盒/审批继承 = DSH 原生（dsh-subagent 在子
> 会话创建窗落 `sandbox/mode`+`approval/policy`，source:'delegation'，规划器 rc.5 policy 服务
> 按会话折叠即生效）。"派子代理读文件"端到端（子会话 task_id/沙盒信封断言）通过，M1 出口
> 达成。§1/§2/§7 行状态已同步。
>
> **V2.5（M2 落地 = workflow / ralph / plan-mode）**：A2+A3+A4（agent 侧）全部完成
> （§12 附录 H）——worker-thread 引擎（provider=spawn）+ tool-workflow + tool-ralph +
> plan-mode（section 与 rc.5 base bundle 一字不差）已装配；worker-thread **Windows spike
> 通过**（数据 URL + tsx/esm 引导分支实测可用，fan-out 2 子代理全 completed）；workflow /
> ralph / plan-mode 三场景本地 E2E 冒烟全绿（程序化装配 + 脚本化 stub LLM 驱动完整
> agent-loop，见附录 H）。**M2 出口达成**，agent 处理能力面 = DSH 默认基座组合齐平。
> §1/§2/§7/§8 行状态已同步；工具链基线说明见 §12 H.4。
>
> **快照比对标（V2.5 起）**：装配/联调以 rc.5 `examples/acp-agent` 快照 + `packages/bundle/base`
> 行为基线逐条比对；残余差异仅宿主工具族（E 类，DSH 亦默认不含）与外部 subagent 后端（排除项）。
> planner 类型核对基线依赖本地 `planner/node_modules` junction → `$DSH_HOME/profiles/node_modules`
> + tsconfig `typeRoots`（§12 H.4），tsc exit 0。
>
> **V2.6（M3 桌面接线落地 = 主任务链收尾）**：桌面接线（Phase 5.4 · §13 附录 I）完成——
> planner 侧装配 `dsh-user-questions` 服务 + `interaction-bridge`（approval answerer +
> user-questions provider → 挂起队列），server 暴露 `GET/POST /api/planner/interactions`
> 轮询/应答端点；桌面端 chat 透传 plan_mode（进入/退出计划模式 UI 开关）+ git
> checkpoint/回滚/状态三端点 IPC + 审批/plan 审阅弹窗接线（ChatPane）。
> **UI 接点补完（V2.6 后续）**：ChatPane 加 git 会话状态条与显式回滚（gitStatus/gitRollback
> + 破坏性二次确认弹窗）、HomeView 新建会话支持 plan-mode 预设、审批/plan 弹窗在运行与
> 空闲态均可轮询弹出；Agent 聊天窗口设计文档 W4 小节 + 验收 5 同步。验证：planner tsc
> exit 0、装配冒烟含 `user-questions → interaction-bridge` 行 + health 200、interactions
> 端点语义（404 幂等/400 校验）正确、BRIDGE_PASS spike（approval/questions/abort 三路）、
> E2E_M3/HTTP_ANSWER（agent-loop + HTTP 应答闭环）、桌面 typecheck + build exit 0、
> M2 三场景 E2E 无回归。**桌面端到端（真实内核 + Electron）待产品联调环境复测**
> （附录 I.4 已知边界）。§1/§2/§7/§8 行状态已同步。
>
> **达成口径（主任务链）**：M0（健壮性）+ M1（subagent）+ M2（workflow/ralph/plan-mode）+
> M3（桌面接线含 UI 接点）= agent 处理能力主体 + 桌面交互闭环；仅剩 M-E 宿主工具族（可选）、
> 版本漂移治理（维护项，单独估期）。

## 0. 验收口径（V2.1 · 已拍板：agent 处理能力与 DSH 默认基座一致；宿主工具族随 DSH 为可选）

> **agent 处理能力 = 与 DSH(rc.5) 一模一样；UI 等其它方面不追。** 判定方式 = 同包装配 +
> 同语义 + 以 rc.5 `examples/acp-agent` 快照（tool-schemas / 系统提示词 / 会话 JSONL）为基线逐条比对。

| 面 | 范围 | 处置 |
|---|---|---|
| **必装（agent 处理能力，DSH 默认基座即含）** | 主循环全链路（含 request-error 重试钩子）、goal、skill、todo、guard（重复/超时）、压缩、**沙盒族（已落地 V3.1）**、subagent（**仅 in-process spawn/fork**）、workflow、ralph、plan-mode（agent 侧）、**fs 工具族（tool-fs 标准集）** | 本表 A/B 类 → M0–M2 |
| **可选 · 与 DSH 一致默认关（overlay 按需启用）** | **宿主工具族**（bash/pwsh/terminal/web/e2b/mcp 及 fs-search/str-replace）——**rc.5 两个默认基座（headless-agent / acp-agent）均不含模型可见宿主工具**，只有独立 overlay（pty.cordis.yml / web.cordis.yml / e2b.cordis.yml 等）；bash 执行后端/fs 工具为基座基建。故 L-CODE 保持一致 = **默认不装、可选 overlay**；启用时工具名/schema/输出契约与 rc.5 一字不差 | 本表 E 类 → M-E（可选） |
| **明确排除** | **subagent 外部后端（acp / claude-code / codex）**（用户拍板：只装 in-process）；UI/桌面/工作台渲染、事件轮询 UI、烧录/回滚/审批弹窗（Phase 5.4 桌面接线）；产品基建（D 类：telemetry / host-* / sqlite / session-query / feedback / schedule / identity / jobs / code-runtime / agent-presets / workspace / spill / context 等） | 本表 §5/§6 |
| **产品扩展（不受影响）** | 内核领域工具（build / flash / serial / git 会话安全 / run_check tsc+idf 校验）——DSH 没有、按产品需求保留 | — |

---

## 1. 已装配对照（现状 = DSH 核心子集 + 沙盒族（V3.1）+ M0 健壮性四件套（V2.2）+ M1 subagent（V2.3 装配 / V2.4 子会话接线）+ M2 workflow/ralph/plan-mode（V2.5）+ M3 桌面接线（V2.6），来源 `planner/src/index.ts`）

| DSH 包（rc.5 实包名） | L-CODE 装配 | 说明 |
|---|---|---|
| `dsh-settings-file` / `dsh-credentials-local` | ✅ | settings.yaml 热重载 / DEEPSEEK_API_KEY 逐请求 |
| `dsh-llm` + `dsh-llm-deepseek` | ✅ | deepseek-official 路由（thinking/reasoningEffort） |
| `dsh-agent` + `dsh-agent-loop` + `dsh-tools` + `dsh-session` + `dsh-system-prompt`（agent-spine-demo 同构组装） | ✅ | turn/step、inbox、取消、工具系统、事件溯源 |
| `dsh-goal` + `dsh-tool-goal` + `dsh-goal-round-driver` | ✅ | goal 续跑 |
| `dsh-session-persistence-jsonl` / `dsh-session-checkpoint-policy` / `dsh-session-projection` | ✅ | JSONL 持久化 + 检查点 + 投影 |
| `dsh-token-meter` + `dsh-compaction-basic` | ✅ | 计量 + 压缩 |
| `dsh-fs-sandbox`（替换 fs-local）/ `dsh-fs-observation-policy` / `dsh-tool-fs` | ✅（V3.1） | 规划器侧文件工具，write/edit 按沙盒策略围栏 |
| **沙盒族**：`dsh-sandbox-local` + `dsh-sandbox-policy` + `dsh-user-approval` | ✅（V3.1，主文档附录 D） | ctx.sandbox / ctx.sandboxPolicy / ctx.approval；拒绝/升级文本与 rc.5 逐字一致 |
| `dsh-llm-retry` | ✅（M0 · §9） | request-error 重试执行器（hooks.ts `agent/request-error` 瀑布参与；provider 缺省 bounded normal：EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 各重试 2 次，500ms→10s 退避） |
| `dsh-tool-todo` | ✅（M0 · §9） | `todo_write`（allowParallelInProgress=true，同 acp-agent/headless-agent） |
| `dsh-repeat-tool-reminder` | ✅（M0 · §9） | 重复工具调用提醒（默认阈值 [3,5,8]；advisory 注入上下文，绝不否决） |
| `dsh-tool-call-timeout-policy` | ✅（M0 · §9） | 工具超时策略（tools/execute 包装按 ToolDefinition.timeoutMs；内核工具逐预算校准见 §9） |
| `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill` | ✅ | 指令型知识 |
| `dsh-subagent`（ctx.subagents）+ `dsh-subagent-spawn-in-process`（spawn）+ `dsh-subagent-fork-in-process`（fork） | ✅（M1 · §10/§11） | in-process provider 注册（spawn=全新子会话 / fork=继承父已完成轮次）；子会话经 events-bridge 注册进 SessionRegistry（task_id=子会话 id，独立落库）；外部后端（acp/claude-code/codex）不装 |
| `dsh-tool-subagent`（subagent / subagent_fork 两实例）+ `dsh-tool-subagent-control`（send_message / interrupt_agent）+ `dsh-tool-subagent-report`（continuable 子代内 report） | ✅（M1 · §10/§11） | 模型可见委托/控制工具集与 rc.5 默认基座一致（maxDepth=1）；沙盒/审批继承 = DSH 委派事件原生 |
| `cordis-plugin-timer` | ✅ | |
| `dsh-workflow`（ctx.workflowEngine 基座）+ `dsh-workflow-worker-thread`（worker-thread 引擎） | ✅（M2 · §12） | worker 线程内 agent() 桥到 A1 spawn provider（events-bridge subagent/start 注册自动覆盖）；**Windows spike 通过** |
| `dsh-tool-workflow`（workflow 工具） | ✅（M2 · §12） | fan-out 脚本经 agent-loop 冒烟（tool-workflow/run-start·agent-start·agent-end·run-end 录制事件齐备） |
| `dsh-tool-ralph`（ralph 工具） | ✅（M2 · §12） | fresh-agent 循环（spawn structured child → structured_output 提交 report）；无配置 = spawn + 默认轮次，同 headless-agent 行 |
| `dsh-plan-mode`（PlanModeController） | ✅（M2 · §12） | plan/mode 事件 + plan:policy 提示段（section 与 rc.5 base bundle 一字不差）+ exit_plan_mode 工具；无 user-questions 通道 = 拒绝并提示手动切换（同 DSH 无 answerer；桌面 answerer = Phase 5.4） |
| `dsh-user-questions`（peer 解析） | ✅（M2 · §12） | plan-mode 运行时 value-import `UserQuestionError` 必须可解析；服务本体/answerer 不装（C3 · Phase 5.4） |
| `dsh-user-questions` 服务本体 | ✅（M3 · §13） | `ctx.userQuestions` 装配（C3 启用）；provider 由 interaction-bridge 注册（桌面应答） |
| interaction-bridge（自有 · §13） | ✅（M3 · §13） | approval/request answerer + user-questions provider → 挂起队列；server `GET /api/planner/interactions` + `POST /{id}/answer`；桌面轮询应答 |

---

## 2. A 类：多智能体 / 编排 / 交互（启用即补齐，核心差距）

> 落位惯例：装配改 `planner/src/index.ts` + `package.json` peerDependencies；端到端联调沿用
> 附录 A/B/C 实测法（规划器类型核对 + 会话冒烟 + 桌面 typecheck/build）。估工为相对人日，仅供参考。

| # | 能力项 | DSH 包（rc.5） | 现状 | 启用动作 | 冲突点 / 决策点 | 估工 | 归属 |
|---|---|---|---|---|---|---|---|
| A1 | **子代理 subagent（仅 in-process spawn/fork；外部后端已排除）** | `dsh-subagent` + `dsh-subagent-in-process-driver` + `dsh-subagent-spawn-in-process` + `dsh-subagent-fork-in-process` + `dsh-tool-subagent` / `-control` / `-report` | ✅（M1 全量 · §10/§11） | ① 装配 in-process driver + spawn/fork backend + tool-subagent 三件 ✅；② **子会话身份映射** ✅：task_id 按子会话解析（events-bridge `subagent/start` → SessionRegistry 注册；`kernel-tools.ts` 经注册表取 cwd/fullAccess），子事件独立落子会话（DSH delegation 一致，§11）；③ **沙盒/审批继承** ✅：dsh-subagent 在子会话创建窗落 `sandbox/mode`+`approval/policy`（source:'delegation'），规划器 rc.5 policy 服务按会话折叠生效（§11）；④ 权限 ✅：子 agent cwd/fullAccess 继承父会话并过内核 `_check_access`（§11 信封断言） | child task_id 语义 ✅（子会话独立）；事件桥按会话串行转发适配子会话 ✅（§11） | M（2–4） | **Phase 4 ✅** |
| A2 | **workflow 编排（agent 脚本 fan-out）** | `dsh-workflow` + `dsh-workflow-worker-thread` + `dsh-tool-workflow` | ✅（M2 · §12） | ① 装配 workflow-worker-thread（provider=spawn，引擎内部挂 ctx.workflowEngine）+ tool-workflow ✅；② worker 线程内子 agent 复用 A1 映射（spawn → events-bridge subagent/start 注册）✅；③ 确定性 schema 载体仅固件固定流程后置可选 | worker-thread 在 Windows 可用性 spike **已通过**（§12 H.3：tsx data-URL 引导分支实测） | M（3–5） | **Phase 4 ✅** |
| A3 | **ralph 迭代** | `dsh-tool-ralph` | ✅（M2 · §12） | 装配 tool-ralph ✅（fresh-agent 循环，spawn structured child，无配置 = headless 行同参） | 依赖 A1 基建（已就绪） | S（1–2） | **Phase 4 ✅** |
| A4 | **plan-mode（agent 侧）** | `dsh-plan-mode` | ✅（M2 · §12） | ① 装配 plan-mode（section 与 rc.5 base 一字不差）✅；② pre-step 折叠 = 包内自带（hooks.ts 透传钩子并存，冒烟验证无冲突）✅；③ server.ts `/api/planner/chat` 增 `plan_mode?` 意图字段 → `ctx.planMode.set` ✅ | 桌面"确认进入执行"入口属 UI（Phase 5.4）——agent 侧状态机先行已一致；exit 审批通道（user-questions answerer）留 Phase 5.4 | M（2–4） | **Phase 4 ✅**（agent 侧）→ Phase 5.4 桌面 |
| A5 | **request-error 重试** | `dsh-llm-retry` | ✅（M0 · §9） | ① hooks.ts 增 `agent/request-error` 瀑布 ✅（透传 + trace）；② 装配 llm-retry ✅（rc.5 原包；provider 缺省 bounded normal，500/SERVER 自动重试） | 无（低风险） | S（0.5–1） | M0 ✅ |

---

## 3. B 类：健壮性 / 质量补齐（低成本高收益）

| # | 能力项 | DSH 包（rc.5） | 现状 | 动作 | 估工 | 归属 |
|---|---|---|---|---|---|---|
| B1 | 重复工具调用提醒 | `dsh-repeat-tool-reminder`（guard） | ✅（M0 · §9） | 装配 ✅（默认阈值 [3,5,8]，advisory 注入不否决） | S | M0 ✅ |
| B2 | 工具调用超时策略 | `dsh-tool-call-timeout-policy`（guard） | ✅（M0 · §9） | 装配 ✅ + 内核透传工具逐工具 `timeoutMs` 校准（build/run_check 大预算防杀真实编译；exec.signal 透传中止 HTTP 往返，见 §9） | S | M0 ✅ |
| B3 | 待办清单工具 | `dsh-tool-todo` | ✅（M0 · §9） | 装配 ✅（`allowParallelInProgress: true`） | S | M0 ✅ |
| B4 | 压缩增强 | `dsh-compaction-tool-result-pruner` / `dsh-command-compact` | ❌ | 可选装配（pruner 先） | S | 可选 |
| B5 | 技能 badge | `dsh-skill-badge` | ❌ | 可选 | S | 可选 |
| B6 | 会话标题 | `dsh-session-title-*` | ❌ | 可选（产品会话列表可用；属 agent 上下文轻微差异，非硬指标） | S | 可选 |

---

## 4. E 类：宿主工具族（V2.1 · 与 DSH 一致 = 可选，默认不装；overlay 按需启用）

> **rc.5 事实**：headless-agent / acp-agent 两个默认基座均**不含模型可见宿主工具**（bash/pwsh/
> terminal/web/e2b/mcp），只含 fs 工具与 bash 执行后端（基建）；宿主工具以独立 overlay
> （pty.cordis.yml / web.cordis.yml / e2b.cordis.yml 等）**按场景启用**。故"与 DSH 保持一致"
> = L-CODE **默认不装、可选 overlay**；启用时保证工具名/schema/输出契约与 rc.5 **一字不差**
> （快照比对），缺后端/账号行为与 DSH 无配置一致。对"开发/改代码"主流程无影响
> （内核工具链已覆盖；需要联网查资料等场景再按需开 web）。

| # | 能力项 | DSH 包（rc.5） | 动作（可选 overlay） | 冲突点 / 决策点 | 估工 | 归属 |
|---|---|---|---|---|---|---|
| E1 | 一次性 shell（bash / pwsh） | `dsh-tool-bash` + `dsh-bash-sandbox` / `dsh-bash-local`；`dsh-tool-pwsh` + `dsh-pwsh-sandbox` / `dsh-pwsh-local`（+ `dsh-subprocess-local`、`dsh-shell`） | overlay 装配 tool-pwsh（Windows 原生）与 tool-bash（POSIX；需 bash.exe） | Windows bash 可用性 spike；与内核 `shell` 并存；走 ctx.sandbox（V3.1 已备） | L（含 spike） | M-E（可选） |
| E2 | 持久 shell / terminal（pty） | `dsh-tool-terminal` + `dsh-terminal` | overlay 装配（同 pty.cordis.yml） | Windows pty 可用性 spike | L | M-E（可选） |
| E3 | web 抓取/搜索 | `dsh-tool-web` + `dsh-web-fetch-http` + `dsh-web-search-deepseek`（exa/perplexity 可选） | overlay 装配（同 web.cordis.yml） | search 需 provider key；fetch 直连网络 | M | M-E（可选） |
| E4 | 云端沙箱 e2b | `dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b` | overlay 装配（同 e2b.cordis.yml） | 需 e2b 云账号；无账号 = 不可用（同 DSH） | S–M | M-E（可选） |
| E5 | MCP 客户端 | `dsh-mcp-client` | overlay 装配 | 需外部 MCP server 才有工具 | S | M-E（可选） |
| E6 | fs-search / str-replace | `dsh-tool-fs-search`、`dsh-tool-str-replace-editor` | overlay 装配（fs 族其余模型可见工具；默认基座同样不含） | 无 | S | M-E（可选） |

> E 类与 D 类边界：**模型可见工具 = agent 处理能力面**，但宿主工具族在 DSH 里即"按需 overlay"，
> 故 L-CODE 与之保持一致 = **默认不装、可选启用（启用即一字不差）**；
> 宿主服务/UI/存储/查询/遥测等"进程与服务形态" = 产品面 → D（不装）。

---

## 5. C 类：明确排除 / 需决策（V2.0 后仅剩两类）

| # | 能力项 | 说明（拍板结果） |
|---|---|---|
| C1 | 沙盒全链 | ✅ **已落地（V3.1，附录 D）**。桌面审批 answerer UI **已接线（M3 · §13）**；内核子进程 OS 级限制（read-only fail-closed + cwd 防穿越，见附录 D.4）仍待 spike |
| C2 | **subagent 外部后端** | ❌ **排除（用户拍板：只装 in-process）**：`dsh-subagent-acp` / `-claude-code` / `-codex`、`dsh-acp`、`dsh-hooks-claude-code/-codex` 不装。属"调用第三方 agent 产品"，非 DSH 自身 agent 处理能力 |
| C3 | 人机 ask/审批 answerer | ✅ **已接线（M3 · §13）**：`dsh-user-approval` 服务 + `dsh-user-questions` 服务已装，approval/questions 经 interaction-bridge 挂起 → 桌面弹窗应答（ChatPane 接线）；`dsh-tool-ask-user` 模型可见工具按需后置（当前 exit_plan_mode 与沙盒升级审批已覆盖人机交互面） |
| C4 | tool-bash 之外的内核 shell 去留 | 保留内核 `shell`（产品领域工具，persona 引导）；E1 的 tool-bash/pwsh 为模型可见面并存。若后续冲突再做合并决策 |

---

## 6. D 类：产品基建 / UI 面（明确不装，防误装备忘）

| 包族（rc.5） | 用途 | L-CODE 处理 |
|---|---|---|
| `dsh-session-telemetry` / `-otel` | 遥测上报 | 不装 |
| `dsh-host-*`（webserver/frontend-static/plugin-inventory/directory-picker…）、`dsh-web`（宿主 Web）、`dsh-client*` / `dsh-sdk*` / `dsh-api*` | DSH 自身 GUI/宿主/API 面 | 不装（产品 UI = Electron 桌面 + 内核 HTTP） |
| `dsh-storage-sqlite` / `dsh-session-persistence-sqlite` / `dsh-session-query*` / `dsh-session-log-export` | 查询/导出类 | 不装（事件/消息已双写产品 DB，桌面轮询） |
| `dsh-session-projection-cache` / `dsh-session-stats` | 投影缓存/统计 | 不装 |
| `dsh-feedback`、`dsh-schedule`、`dsh-anonymous-user-id`、`dsh-jobs*`、`dsh-code-runtime*`、`dsh-command-*`、`dsh-message-feedback` | 产品功能/运行时基建 | 不装 |
| `dsh-agent-presets` / `dsh-persona` / `dsh-workspace` | 多 agent 预设/工作区事实注入 | 不装（单 persona 产品） |
| `dsh-context/*`（time-context/tmux-context/agent-instructions/session-reference）、`dsh-spill*` | 上下文增强/溢出 | 默认不装（记录差异）；如需上下文管理对齐，spill 先于 context 族评估 |
| `dsh-permission-presets`、`dsh-interaction/*`（除 user-approval） | 交互预设/命令 | 不装（桌面为准） |
| `dsh-guard` 其余、`dsh-typert*`/`dsh-util` 等 | 工具库/非模型可见 | 无视 |

---

## 7. 建议里程碑（依赖排序；M0/M1/M2 = agent 处理能力主体（DSH 默认基座一致），M-E = 宿主工具族可选）

| 里程碑 | 内容 | 出口标准（沿用附录实测法） |
|---|---|---|
| **M0 · 健壮性补齐 ✅（已落地 · §9 附录 E）** | A5（request-error + llm-retry）、B1/B2/B3（全部装配 rc.5 原包 + 自有接线） | 注入 500 自动重试、重复工具提醒、todo 在会话冒烟可见 —— **已达成**（§9 本地 E2E 冒烟逐项验证） |
| **M1 · subagent（Phase 4 前半）✅ 已落地（§10 附录 F 装配 + §11 附录 G 子会话接线）** | A1：① 装配 ✅；② 子会话身份映射 ✅；③ 沙盒/审批继承 ✅；④ 权限继承 ✅ | 出口达成：模型可见 subagent/subagent_fork/send_message/interrupt_agent；"派子 agent 读文件"端到端（子会话 task_id 独立落库 + 沙盒信封断言 + 子事件/子沙盒模式正确）冒烟通过（§11）；真实内核文件读取随环境可复测 |
| **M2 · workflow / ralph / plan-mode（Phase 4 后半）✅ 已落地（§12 附录 H）** | A2 + A3 + A4（agent 侧） | 出口达成：workflow fan-out（2 子代理）、ralph（fresh child structured complete）、plan-mode 状态机（plan/mode 事件 + plan:policy 注入 + exit 无通道拒绝）三场景 E2E 全绿；worker-thread Windows spike 通过；装配冒烟/health/tsc 全过 |
| **M-E · 宿主工具族（可选 · 与 DSH 一致默认关）** | E1–E6（overlay；按需启用 bash/pwsh/terminal/web/e2b/mcp） | 启用时工具 schema 与 rc.5 快照一致；默认不装行为 = DSH 默认基座 |
| **M3 · 桌面接线 ✅ 已落地（§13 附录 I · V2.6）** | Phase 5.4：approval answerer、plan-mode 确认、烧录/回滚/审批弹窗接线 | 桌面端到端（UI 不计入"agent 处理能力"验收）。已达成：approval/questions 桌面弹窗应答（bridge+端点+ChatPane）、chat plan_mode 透传与计划模式 UI、git checkpoint/回滚/状态 IPC、烧录确认沿用既有弹窗；桌面 typecheck/build exit 0；真实内核+Electron 端到端待产品联调环境复测 |
| **版本漂移治理** | 上游 DSH 升级评估（当前 rc.5） | pnpm workspace 对齐 + 全回归，单独估期 |

**达成口径（V2.1 · 主体已达成 V2.5，M3 桌面接线 V2.6 落地）**：M0+M1+M2 完成后，L-CODE 的 agent 处理能力与 **DSH
默认基座（rc.5 headless-agent/acp-agent 组合）一致**：主循环全链路 + goal/skill/todo/guard/重试 +
压缩 + 沙盒族 + subagent（in-process）+ workflow/ralph + plan-mode（agent 侧）+ fs 工具族。
**M0/M1/M2/M3 均已落地（§9/§10–11/§12/§13）**；剩余 = M-E 宿主工具族（可选）、
版本漂移治理（维护项，单独估期）。
M-E 仅当需要联网/终端/云等场景按需启用（与 DSH overlay 用法一致，启用即一字不差）。
验收 = 以 acp-agent/headless-agent 快照逐条比对（tool-schemas / 系统提示词 / 拒绝与升级文本 /
会话 JSONL）。残余差异仅：**宿主工具族（DSH 亦默认不含）**、**外部 subagent 后端（排除项）**、
**UI/产品基建（不追）**、**内核领域工具（产品扩展）**。

---

## 8. 排期假设与风险

1. 等价基线固定 rc.5：**不追上游**（避免滚动目标）；上游升级单独估期。
2. A1 子会话 task_id/事件归属是唯一结构性改造（sessions.ts / kernel-tools.ts / events-bridge.ts）
   —— **已落地（V2.4，§11）**：events-bridge `subagent/start` → SessionRegistry 注册 + 内核子
   会话行 upsert，子代理透传/子事件独立落子会话；kernel-tools.ts 无需改动（经注册表解析）。
3. Windows 环境风险：worker-thread（A2）—— **已 spike 通过（V2.5，§12 H.3）**：worker_threads
   内 tsx 引导（data URL + tsx/esm/api register）在 Windows + Node 24 实测可用，fan-out 2 子代理
   completed；pty（E2）、bash.exe（E1）仍待 M-E spike；e2b/web-search 依赖账号/网络。
4. E 类工具与内核 `shell` 并存：模型可见面以 DSH 同名工具为准，产品 persona 引导内核领域工具，
   两套并存期间以快照验收防止行为分叉。
5. 事件字典新增类型（subagent/*、workflow/*、plan/*、sandbox/mode、approval/*…）沿用
   `git/checkpoint` 先例：先落库，Phase 5 统一回写表格。

---

## 9. 附录 E：M0 落地记录（A5+B1–B3 健壮性补齐 · V2.2）

> 实现态记录（"文档只增不减"）。M0 = 排期表 §7 第一里程碑：装配 rc.5 健壮性四件套，
> 出口标准 = 注入 500 自动重试 / 重复工具提醒 / todo 在会话冒烟可见。全部落在规划器
> `lcode/planner/`，不改 Python 内核与桌面。

### E.1 装配（与 rc.5 agent-spine-demo / acp-agent 组合逐项一致）

| rc.5 包 | 落位 | 关键接线 |
|---|---|---|
| `dsh-llm-retry` | `planner/src/index.ts`（agent-registry 之后，同 agent-spine-demo） | hooks.ts 增 `agent/request-error` 瀑布（透传 + LCORE_TRACE 记录）；provider 侧 `retryPolicy` 省略 = bounded normal 默认（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 重试 2 次，500ms→10s + 10% jitter），同 DSH 默认组合 |
| `dsh-tool-todo` | `planner/src/index.ts` | `ctx.plugin(ToolTodo, { allowParallelInProgress: true })`（同 acp-agent/headless-agent）；`todo_write` 每次整表替换并落 `todo/write` 会话事件 |
| `dsh-repeat-tool-reminder` | `planner/src/index.ts` | 无配置挂载（默认阈值 [3,5,8]；advisory 提醒经 post-execute `additionalContexts` 注入下一次请求，绝不否决） |
| `dsh-tool-call-timeout-policy` | `planner/src/index.ts` | `tools/execute` 包装：有 `timeoutMs` 的工具在 exec.signal 上布 deadline，超时以结构化 `TOOL_TIMEOUT` 替换结果（文本与 DSH 逐字一致） |
| peerDependencies | `lcode/planner/package.json` | 增补以上 4 包（`"*"`，随 profile link 安装解析） |

- hooks.ts `agent/request-error`：参与 loop 失败瀑布的显式一环（注册于 llm-retry 之后，纯透传 +
  trace），不改变任何失败语义（放行 = 保留原始失败）。
- 内核工具逐工具预算（`planner/src/plugins/kernel-tools.ts` `TOOL_TIMEOUT_MS`）：
  `read_file/write_file/list_dir/file_tree/glob/grep/edit_file/shell/flash = 60s`；
  `git_clone = 300s`；`run_check = 900s`（esp-idf = idf.py build）；`build = 1800s`
  （慢工具给大预算，超时只作悬挂兜底，绝不静默杀掉真实编译）。flash 对话内为**登记制**
  （实际烧录走 `flash_confirm` 显式端点，不经本路径）。超时语义为**协作式**：`exec.signal`
  透传给 `kernel-client.tool()`（fetch `signal`），deadline 触发即中止本次 HTTP 往返；
  内核侧进程不因此被杀（无取消端点），长工具预算已按上表放大。

### E.2 实测（全部通过）

1. **装配冒烟**：`dsh --profile lcode-planner`（server 模式）挂载顺序 trace 含
   `llm-retry → tool-todo → repeat-tool-reminder → timeout-policy` 四新行无异常，
   `GET /api/planner/health` → `{"status":"ok",...}` 200。
2. **类型核对**：planner 全量源文件 `tsc --noEmit`（moduleResolution bundler + strict，
   经 `$DSH_HOME/profiles/node_modules` rc.5 实包类型解析）exit 0。
3. **本地 E2E 会话冒烟**（不经真实 LLM；SSE 桩模拟 DeepSeek `/chat/completions`，
   经 runner 一次性会话驱动完整 agent-loop）：
   - **A5 注入 500 自动重试**：桩首次返回 HTTP 500 → llm-deepseek 分类 `SERVER` →
     `llm/retry`（provider=deepseek-official、mode=normal、policyKey 含 SERVER、delayMs≈475ms）
     与 `llm/retry-started`（同 retryId）各 1 条落会话 JSONL，重试轮正常续跑；
   - **B3 todo 会话可见**：模型（桩）连发 3 次 `todo_write`（相同参数）→ 3 条
     `todo/write` 事件落会话 JSONL，工具返回 counts 正常；
   - **B1 重复工具提醒**：第 3 次相同调用命中阈值 [3] → repeat-tool-reminder 的
     GENTLE 提醒文本出现在**下一次模型请求**的上下文中（桩在第 5 次请求检出并回显
     `REMINDER_SEEN`，runner stdout 打印，进程 exit 0）。
   - 会话 `turn/end = {kind:"completed"}`。

### E.3 已知边界（后续 Phase 完善）

- 超时策略对内核工具为**协作式单侧中止**（规划器侧中止 HTTP 往返）；内核子进程如 shell/build
  不会被杀，悬挂兜底靠大预算（E.1）；若需强杀进程级执行，属附录 D.4「内核子进程 OS 级限制」同款 spike 评估。
- 事件字典新增 `todo/write`、`llm/retry`、`llm/retry-started` 类型：随会话 JSONL 落库
  （同 `git/checkpoint`/`flash/*` 先例），events-bridge 暂不映射、UI 表格回写 Phase 5 统一处理。
- guard 文案/阈值均为 rc.5 默认（advisory 不否决；超时结果文本逐字一致）；若产品需要更激进
  的重复拦截或更紧超时，属调参项，不改变装配语义。
- llm-retry 以 500ms 起退避 + jitter；生产 500 抖动可观测，属 DSH 默认行为（不改）。

---

## 10. 附录 F：M1 装配部分落地记录（A1 ① · V2.3）

> 实现态记录（"文档只增不减"）。本轮范围 = 用户拍板"先只做 M1 装配部分"：把 rc.5 subagent
> 族**工具面**照默认基座（headless-agent / acp-agent 行）装上并端到端跑通；
> 子会话身份映射 / 沙盒审批继承属结构性改造（M1b，下一轮）。子会话事件归属已定调：
> **子会话独立落库（与 DSH delegation 一致）**。

### F.1 装配（`planner/src/index.ts` + `package.json` peers；对照 rc.5 行）

| rc.5 包 | 落位/实例 | 说明 |
|---|---|---|
| `dsh-subagent` | `SubagentService`（默认导出） | `ctx.subagents` provider 注册表 + continuation 管理；inject agents/sessionProjections 子绑定 |
| `dsh-subagent-spawn-in-process` | providerName `spawn` | 全新子会话（zero parent context），复用 agent 工厂 |
| `dsh-subagent-fork-in-process` | providerName `fork` | 继承父已完成 turn 前缀的种子会话 |
| `dsh-tool-subagent-control` | 全局 | `send_message` / `interrupt_agent`（跟随同 ctx.subagents，不限 provider） |
| `dsh-tool-subagent-report` | 全局 | 仅在 continuable 子代作用域注入 `report`（本组合 spawn=continuable） |
| `dsh-tool-subagent` ×2 | `subagent`：provider=spawn、continuable、maxDepth=1；`subagent_fork`：provider=fork、one-shot、`enableRunInBackground:false`、maxDepth=1 | 与 headless/acp-agent 完全同参；子代 provider/model/maxTokens 从父继承 |

- 不装：subagent 外部后端（acp/claude-code/codex）与 `dsh-subagent-acp` 等；**不引入 dsh-jobs**
  （D 类排除）——本组合 spawn 走 `startContinuable`/provider one-shot，fork 禁 run_in_background，
  均不触达 jobs 背景任务路径（tool-subagent 对 one-shot 背景才要求 ctx.jobs）。
- 模型可见工具新增：`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`
  （continuable 子代还有 `report`）；tool-schemas 与 rc.5 一致（含 `description`/`prompt` 必填）。
- 子代理与父**同进程同 ctx**（in-process 语义）：spawn/fork 复用规划器 ctx（kernel-tools、
  todo、guard 等全量对子代理可见），子会话独立 Session（JSONL 持久化同根）。

### F.2 实测（全部通过）

1. **装配冒烟**：`dsh --profile lcode-planner` 挂载 trace 含
   `subagent → subagent-spawn → subagent-fork → tool-subagent-control → tool-subagent-report
   → tool-subagent → tool-subagent-fork` 七新行无异常；`/api/planner/health` 200。
2. **类型核对**：planner 全量源文件 `tsc --noEmit` exit 0。
3. **本地 E2E（spawn+fork，桩驱动不经真实 LLM）**：父会话 → `subagent`（spawn，前台）→
   子代理独立会话回复 child-ok；父会话 → `subagent_fork`（fork，继承已完成轮次）→ 子代理
   回复 fork-ok；父会话收尾 PARENT_DONE。会话根产出 **3 个会话 JSONL**（父 + spawn 子 +
   fork 子），子会话含 `subagent/descriptor`、`approval/policy` 事件；`turn/end=completed`，
   进程 exit 0。期间验证：subagent schema 必填 `description`+`prompt`（缺参即拒绝，行为与 DSH 同）。

### F.3 已知边界（= M1b 排期输入 → 已于 V2.4 关闭，见 §11）

> 本节为装配部分的边界记录；M1b 已落地（§11 附录 G），下述「子会话 task_id 映射」与
> 「沙盒/审批继承」边界均已关闭，原文保留作排期输入记录。

- **子会话 task_id/事件映射**（M1b ✅，§11）：子代理透传内核工具（read_file/edit_file/shell…）
  时 `registry.forAgent(子 agent)` 现经 events-bridge `subagent/start` 注册命中 → 按子会话
  解析 cwd/fullAccess、task_id=子会话 id，工具侧事件独立落子任务。实现：sessions.ts（kind/
  parentId）+ events-bridge.ts（注册 + upsert 内核子会话行）+ runner.ts（一次性会话登记）。
- **沙盒/审批继承**（M1b ✅，§11）：子会话 `sandbox/mode` + `approval/policy`（source:
  'delegation'）由 dsh-subagent 创建窗落日志，规划器 rc.5 policy/approval 服务按会话折叠生效，
  无 L-CODE 自定义代码。
- 桌面/UI 对子会话展示不追（Phase 5 工作台）。
- 事件字典新增 `subagent/start`、`subagent/end`、`subagent/descriptor`、`approval/policy` 等
  子代生命周期事件随子会话 JSONL 落库（同先例先落库，表格回写 Phase 5）。

---

## 11. 附录 G：M1b 子会话接线落地记录（A1 ②③④ · V2.4）

> 实现态记录（"文档只增不减"）。M1b = A1 结构性改造：子会话身份映射 + 沙盒/审批继承 +
> 权限继承。子会话事件归属按 V2.3 拍板 = **子会话独立落库（与 DSH delegation 一致）**。
> 至此 **M1（A1）全量完成**，agent 处理能力面补上 in-process subagent 全链路。

### G.1 装配与实现（全部落在 `lcode/planner/`，不改 Python 内核与桌面）

| 落位 | 变更 | 说明 |
|---|---|---|
| `sessions.ts` | `PlannerSession` 增 `kind?: 'session'\|'subagent'`、`parentId?: string` | 会话形态区分；供注册表/后续 UI 使用 |
| `plugins/events-bridge.ts` | 监听 `subagent/start`：把已发布的子代理会话**同步注册**进 SessionRegistry，再后台 `upsertChatSession` 内核子会话行；`registerChildSession()` 从子会话 header 读 `cwd`/`parentSession`/`origin` | 身份继承来源 = DSH 子会话持久化 header（dsh-subagent 创建窗写入）：cwd = 父 cwd 拷贝；fullAccess = 父 planner 会话当前值（header.parentSession 回查注册表，不在册缺省 true）；task_id = 子会话 id；title=（子代理）；续跑 epoch 复用同 id 仅刷新 busy |
| `plugins/runner.ts` | Config 增 `registry`；一次性会话（顶层）创建后同步登记 | 开发/联调 one-shot 态顶层工具透传与子代理继承不再回落默认（M0/M1 E2E 亦受益） |
| `plugins/index.ts` | events-bridge 行注入 `['agents']`；runner 行传入 `registry` | ctx.agents 供 `subagent/start` 时按 id 取子代理 Agent |
| **沙盒/审批继承** | 无自定义代码 | dsh-subagent 在子会话创建窗把父 sandbox 覆盖 + `approval/policy: never` 以 `source:'delegation'` 事件写入子会话日志；规划器 rc.5 dsh-sandbox-policy/dsh-user-approval 按会话折叠即生效（子代理升级审批自动拒绝，与 DSH 同） |

### G.2 实测（全部通过）

1. **装配冒烟**：挂载顺序 trace 无异常；`/api/planner/health` 200。
2. **类型核对**：planner 全量源文件 `tsc --noEmit` exit 0。
3. **本地 E2E（LLM 桩 + 假内核桩）**：runner 顶层会话登记后 → 派 spawn 子代理 →
   子代理在**自己的会话**里调 `read_file`（kernel-tools 透传假内核）→ 汇报 → 父再派 fork
   子代理 → PARENT_DONE，exit 0。假内核日志断言：
   - `POST /api/planner/chat_session` 含两条子会话 upsert（子会话 id、cwd=父 cwd、
     `full_access:true`、title=（子代理））——**子会话独立落库 ✅**；
   - `POST /api/planner/tool/read_file` 请求 `task_id` == 该子会话 id、`cwd`=父 cwd、
     `full_access:true`、`sandbox:{mode:'workspace-write', workspace_root: 规划器 cwd,
     session_id: 子会话 id}`——**子代理透传按子会话解析 + 沙盒信封继承 ✅**；
   - 子会话 JSONL：read_file 的 tool/call+tool/result 落在子会话内；子会话事件含
     `subagent/descriptor`、`approval/policy`（delegation 审批 pin）——**子事件落子会话 +
     委派策略种子 ✅**。
4. 内核 event/chat_message/chat_state/git_checkpoint 均按子会话 id 记录（假内核观测），
   桌面 500ms 轮询路径不变。

### G.3 已知边界（后续 Phase 完善）

- 真实内核回归（文件读取/权限 403/升级拒绝文本）待内核+LLM fixture 环境复测（映射层断言
  已在 G.2 覆盖；内核侧无改动）。
- 子会话在规划器 `/api/planner/sessions`（registry.list）可见（kind='subagent'）；桌面会话
  列表走内核 `/api/chat_session`，不受影响。若需要规划器层过滤，属 Phase 5 工作台事项。
- 子代理的 continuable 生命周期（send_message/续跑/撤销）为 DSH 原包语义，L-CODE 只做会话
  登记，不做额外编排；桌面 UI 展示不追（Phase 5）。
- 事件字典新增 `subagent/*`、`approval/policy` 等类型随子会话 JSONL 落库（先例先落库，
  Phase 5 统一回写表格）。

---

## 12. 附录 H：M2 落地记录（A2 workflow + A3 ralph + A4 plan-mode agent 侧 · V2.5）

> 实现态记录（"文档只增不减"）。M2 = 排期表 §7 第三里程碑（Phase 4 后半）：装配
> workflow（worker-thread 引擎 + 工具）/ ralph / plan-mode（agent 侧）。出口标准 = workflow
> fan-out、ralph、plan-mode 状态机冒烟通过（快照比对标）。全部落在规划器 `lcode/planner/`，
> 不改 Python 内核与桌面。peer 增补后共享 profiles/node_modules 已含全部目标包（195 个
> @deepseek-ai 实包，含 dsh-workflow 族 / plan-mode / user-questions）。

### H.1 装配（`planner/src/index.ts` + `package.json` peers；对照 rc.5 headless-agent / base 行）

| rc.5 包 | 落位/实例 | 说明 |
|---|---|---|
| `dsh-workflow-worker-thread` | default import → `ctx.plugin(..., { provider: 'spawn' })` | worker-thread 引擎（default export 继承 `WorkflowEngine` 注册 `ctx.workflowEngine`；inject subagents）。worker 内 agent() 桥到 A1 spawn provider —— 子代理经 events-bridge `subagent/start` 自动注册，**无需新增映射代码** |
| `dsh-tool-workflow` | namespace import → `ctx.plugin(ToolWorkflow)` | `workflow` 工具（inject tools/workflowEngine/systemPrompt）；无配置（默认 toolName/maxResultChars）同 headless 行 |
| `dsh-tool-ralph` | namespace import → `ctx.plugin(ToolRalph)` | `ralph` 工具（inject tools/workflowEngine/subagents/systemPrompt）；无配置 = subagentProvider spawn + 默认轮次上限，同 headless-agent 行 |
| `dsh-plan-mode` | default import → `ctx.plugin(PlanModeController, { section: PLAN_MODE_SECTION })` | `ctx.planMode`：plan/mode 事件折叠 + plan:policy 提示段 + `exit_plan_mode` 工具（工具目录跨模式稳定）。**section 文案与 rc.5 base bundle（`packages/bundle/base/cordis.patch.yml` plan-mode 行）一字不差**（快照比对标） |
| `dsh-user-questions` | 仅 peer 解析 | plan-mode 对 `UserQuestionError` 是**运行时 value import**，模块级必须可解析；服务本体与 answerer **不装**（C3 · 桌面 answerer = Phase 5.4；无通道时 `exit_plan_mode` 抛 `no user-questions channel …`，与 DSH 无 answerer 行为一致） |
| `dsh-workflow` | peer（引擎基座/类型） | worker-thread 与 tool-workflow/tool-ralph 的类型与基座来源 |
| peerDependencies | `lcode/planner/package.json` | 增补 6 包：`dsh-workflow`、`dsh-workflow-worker-thread`、`dsh-tool-workflow`、`dsh-tool-ralph`、`dsh-plan-mode`、`dsh-user-questions`（`"*"`，共享 profiles/node_modules 解析） |

- server.ts `/api/planner/chat`（A4 ③）：请求体增可选 `plan_mode?: boolean`（true=进入 plan 模式，
  false=退出）；服务端在 followup 前调 `ctx.planMode.set(agent, plan_mode)`——空闲会话即刻落
  `plan/mode`（committed），执行中排队至下一被接受 pre-step（与 DSH /plan 语义一致）。
- hooks.ts `agent/pre-step`：**无改动**。plan-mode 的 pre-step 折叠由包内 `ctx.on('agent/pre-step')`
  自带，L-CODE hooks 透传钩子与其并存（E2E 冒烟验证共存无冲突）。
- 模型可见工具新增：`workflow`、`ralph`、`exit_plan_mode`（exit 常驻注册、plan 模式外调用报错）；
  tool-schemas 与 rc.5 一致。

### H.2 装配冒烟（全部通过）

1. **挂载 trace**：`pnpm dsh --profile lcode-planner`（LCORE_TRACE=1）含新增四行
   `workflow-worker-thread → tool-workflow → tool-ralph → plan-mode` 无异常；
   `GET /api/planner/health` → `{"status":"ok",...}` 200（pid 在册、sessions 0）。
2. **类型核对**：planner 全量源文件 `tsc --noEmit` exit 0（moduleResolution bundler + strict；
   解析基线见 H.4）。

### H.3 本地 E2E（三场景 · 程序化装配 + 脚本化 stub LLM 驱动完整 agent-loop）

> 驱动脚本 `lcode/planner/scripts/e2e-m2.mts`：与 index.ts 等价装配核心面 + M2 各包，注册
> 「脚本化 stub adapter」（`ctx.llm.registerAdapter` 路由 `scripted-official`），按**会话 id 分组**
> 路由：父会话首请求返回场景工具调用 → 子代理会话（新 session）分别回文本 / structured report →
> 父会话后续请求收尾 DONE。父代理 provider=scripted-official（子代理经 A1 spawn 继承同 provider）。
> 各场景独立 ctx + 临时目录，退出码 0 = PASS。运行时 cwd = DSH checkout。

1. **workflow fan-out**（`E2E_PASS workflow`）：父首请求 → `workflow` 工具调用（脚本
   `Promise.all` 两个 agent）→ worker-thread 引擎各起一个 spawn 子代理（stub 回 `stub-ok`）→
   会话事件含 `tool/call workflow` + 录制四件 `tool-workflow/run-start`、`tool-workflow/agent-start`×2、
   `tool-workflow/agent-end`×2、`tool-workflow/run-end {stopReason:'completed'}`（fan-out 数量以
   录制事件断言 —— `workflow/*` 为 ctx 级引擎事件不进会话日志，录制层投影为 tool-workflow/*）；
   `turn/end = completed`。
2. **ralph**（`E2E_PASS ralph`）：父首请求 → `ralph` 工具调用（objective）→ Ralph 固定脚本在
   workflowEngine 上起一轮 spawn **structured child**（tools 含 `structured_output`；stub 按
   该工具存在回 `structured_output` complete report：status complete + evidence + 空 nextSteps/
   blocker）→ 工具结果文本含 `Ralph worker reported completion after 1 round(s)`；
   `turn/end = completed`。
3. **plan-mode**（`E2E_PASS plan-mode`）：空闲窗 `ctx.planMode.set(agent, true)` → committed 并落
   `plan/mode {active:true}` 会话事件；随后 followup 的模型请求 system 含 plan:policy 段（stub
   记录 system 文本断言命中 `plan mode` 文案）→ 模型（stub）调 `exit_plan_mode` → **无
   user-questions 通道 = 拒绝**（工具结果 isError，文本含 `no user-questions channel …`，与 DSH
   无 answerer 行为一致）→ 父收尾 `turn/end = completed`。
4. **Windows worker-thread spike**（`scripts/spike-workflow-engine.mts`，`SPIKE_OK`）：不经工具/
   LLM 决策直接 `ctx.workflowEngine.start()` fan-out 两 agent —— worker 线程在 Windows + tsx
   （data URL + `tsx/esm/api`/`tsx/cjs/api` register 引导分支，host.ts `resolveWorkerSpawn`）真实
   启动，`workflow/start → phase → agent-start×2 → agent-end×2 → end(completed, agentsStarted=2)`
   ctx 级事件齐备。A2「worker-thread Windows 可用性」风险关闭。

### H.4 类型核对解析基线（工具链说明，防复现迷路）

- `tsc --noEmit` 的 rc.5 类型解析依赖：`planner/node_modules` **junction →**
  `$DSH_HOME/profiles/node_modules`（195 个 @deepseek-ai 实包 hoist 处）+ `tsconfig.json`
  `typeRoots` 增补 `"../../../deepseek/deepseek-harness-master/node_modules/@types"`（@types/node
  不在 profiles 共享层）。两者为本机开发态解析基线的**既有事实**，非源码装配的一部分。

### H.5 已知边界（后续 Phase 完善）

- **plan-mode 审批通道**：`exit_plan_mode` 的用户审批需要 `user-questions` 通道 + answerer
  （桌面 UI），属 Phase 5.4；M2 阶段无通道时按 DSH 无 answerer 行为拒绝并提示手动切换模式
  （agent 侧状态机已一致，桌面确认弹窗接好后即通）。
- **桌面展示**：workflow/ralph/plan-mode 的会话事件类型（plan/mode、tool-workflow/*、workflow/*）
  随会话 JSONL 落库（先例先落库）；UI 表格/子会话工作台展示 = Phase 5。
- **内核真实回归**：本轮 E2E 为规划器自含 stub（不经内核）；workflow/ralph/plan-mode 与真实
  内核工具的混合场景（如 fan-out 内 read_file）待内核 + LLM fixture 环境复测。
- **快照比对标**：装配后模型可见工具集/提示段与 rc.5 base 组合逐条比对（workflow/ralph 工具
  名称、schema、plan:policy 文案一字不差）；剩余差异 = E 类宿主工具族（默认不装 = DSH 一致）。
- 事件字典新增 `plan/mode`、`tool-workflow/run-start|agent-start|agent-end|run-end`、
  `workflow/*`（ctx 级，不进会话日志）等：随会话 JSONL 落库，表格回写 Phase 5 统一处理。

---

## 13. 附录 I：M3 落地记录（桌面接线 · Phase 5.4 · V2.6）

> 实现态记录（"文档只增不减"）。M3 = 排期表 §7 主任务链收尾：把 approval/ask 等人机交互
> 通道与 git/plan-mode 能力接到桌面。核心结论：**agent 侧（planner）不动 DSH 语义** ——
> approval/questions 仍由 rc.5 原包（user-approval / user-questions）决定审计与策略，L-CODE
> 只增加「挂起队列桥」把 answerer 接到桌面 UI；桌面侧按既有 IPC/轮询架构透传。
> 改动面：`lcode/planner/`（服务端桥）+ `lcode/desktop/`（主进程 IPC/preload + ChatPane UI）。

### I.1 服务端桥（`planner/src/plugins/interaction-bridge.ts` + `index.ts` + `server.ts`）

| 落位 | 变更 | 说明 |
|---|---|---|
| `index.ts` | 装配 `dsh-user-questions` 服务（C3 启用）+ `new InteractionBridge().mount(ctx)` | `ctx.userQuestions` 就位（plan-mode exit_plan_mode 审批等）；桥注册 approval/request answerer（`ctx.on('approval/request')` → 挂起返回 ApprovalOutcome）与 user-questions provider（`ctx.userQuestions.registerProvider` → 挂起返回 answers）——answerer 语义与 rc.5 原包一致，无自定义策略 |
| `interaction-bridge.ts` | `InteractionBridge`：pending Map + `list(sessionId?)` + `answer(id, {kind, outcome\|answers})`；挂起项带 `abort`（request.signal → approval 'cancelled' / questions 拒绝，晚到应答幂等丢弃） | 会话归属 = `agent.session.id`（桌面只轮询活动会话） |
| `server.ts` | `GET /api/planner/interactions[?session_id=]` → 只读待应答快照；`POST /api/planner/interactions/answer` `{id, kind, outcome?\|answers?}` → 校验 + 放行 | 语义：未知 id 404、缺 id / 坏 outcome / 坏 kind 400（实测见 I.3） |
| peer | `dsh-user-questions` 服务本体随既有 peer（§12 H.1 已加）| 本轮只装配服务，未新增包 |

### I.2 桌面接线（`lcode/desktop/`）

| 层 | 变更 | 说明 |
|---|---|---|
| `shared/types.ts` | `LCodeApi.chat` 增 `planMode?` 第 4 参；新增 `gitCheckpoint/gitRollback/gitStatus`、`listInteractions/answerInteraction`；`PendingInteraction`（approval/questions 联合）与 `GitStatusResult/GitCheckpointResult/GitRollbackResult`（对齐内核 `git_safe` 透传形状：repo/root/head/subject/dirty 等） | 契约先落类型，IPC 与 UI 同源 |
| `preload/index.ts` | 白名单增 5 项 invoke（`git:checkpoint` / `git:rollback` / `git:status` / `planner:interactions` / `planner:interactionsAnswer`）；`chat:send` 带 planMode | D19 最小化面不变 |
| `main/planner-manager.ts` | `PlannerHttpClient` 增 `chat` plan_mode 透传、git 三端点、`listInteractions`、`answerInteraction` | 直连 planner HTTP |
| `main/index.ts` | IPC handler 补 git 三端点 + interactions 拉取/应答；`chat:send` 收 planMode 第 4 参并透传 | 回滚/审批不经内核权限（同 git_checkpoint 先例，显式用户操作） |
| `renderer/.../ChatPane.tsx` | ① 标题栏 **plan-mode 开关**（📋 计划中 / 计划）——下一条消息带 `plan_mode` 意图进入/退出；② **审批/plan 审阅弹窗**：1.2s 轮询 `listInteractions(sessionId)`（运行/空闲均轮询，无 running 门槛），出现 approval（工具名 + reason → 允许本次/拒绝）或 questions（plan detail + 选项 → 按所选 label 应答，含 plan-review intent 的 approve label）即弹窗；应答后刷新会话；③ **git 会话状态条**（独立行：repo subject @head + dirty ● 计数/clean）+ 显式回滚按钮 → 破坏性二次确认弹窗 → `gitRollback` | 与既有 flash / 每百轮确认弹窗同构（fixed inset 遮罩弹层） |
| `renderer/.../HomeView.tsx` | 新建会话支持 **plan-mode 预设**：输入区下方 📋 计划模式开关，提交时 `chat(req, …)` 带第 4 参 planMode | 空会话也能先进计划模式再对话 |

### I.3 验证（全部通过）

1. **planner tsc**：全量源文件 `--noEmit` exit 0（含新桥与 server 端点）。
2. **装配冒烟**：profile 挂载 trace 新增 `user-questions → interaction-bridge` 两行无异常；
   `/api/planner/health` 200。
3. **端点语义**（真实 profile）：`GET /api/planner/interactions` → `{"interactions":[]}`；
   answer 未知 id → 404、缺 id → 400、坏 outcome → 400（幂等/校验正确）。
4. **BRIDGE_PASS spike**（`scripts/spike-interaction-bridge.mts`，程序化装配 ApprovalService +
   UserQuestionService + bridge，不经 HTTP）：
   - approval：open turn 内 `ctx.approval.request()` → 队列出现 pending → `answer(allowed-once)`
     → resolve 'allowed-once'，`approval/asked` + `approval/decided` 审计对落会话（outcome 一致）；
   - questions：`ctx.userQuestions.ask()`（plan-review intent）→ 队列出现 pending →
     `answer({answers:[Approve]})` → resolve answers 回填；
   - abort：pending 的 signal 中止 → approval resolve 'cancelled'，队列清理。
5. **E2E_M3_PASS**（`scripts/e2e-m3.mts` · **agent-loop 端到端 · plan-mode 桌面审批闭环**）：
   装配 core + plan-mode + user-questions + bridge + 脚本化 stub LLM →
   `planMode.set(agent,true)` committed → followup 触发 turn → 桩首请求调 `exit_plan_mode`
   → execute 经 `ctx.userQuestions.ask()` 挂起（**不再抛"无通道"**——M3 通道已接）→ 主线程
   轮询 bridge 发现 questions pending（`intent: plan-review`、`approve: Approve`）→
   `bridge.answer(answers:[{selected:[Approve]}])` → ask resolve → exit 获批 → 下个 in-turn
   pre-step 折叠 `plan/mode {active:false}` → 桩次轮 DONE → `turn/end completed`。断言：
   plan/mode 事件 ×2（末条 inactive）、tool/call exit_plan_mode、tool/result 非错误。即
   **M2 同场景（无通道拒绝）在 M3 升级为桌面可应答获批**。
6. **HTTP_ANSWER_PASS**（`scripts/spike-http-answer.mts` · **真实 server.apply + HTTP 通道**）：
   装配 core（含 AgentRegistry 以满足 server inject）+ ApprovalService/UserQuestionService/
   bridge + 真实 `lcode-server` 插件（interactionBridge 注入），open turn 内
   `ctx.approval.request()` 挂起 → `GET /api/planner/interactions?session_id=…` 拉到
   approval pending（toolName/reason 透传）→ `POST /api/planner/interactions/answer
   {outcome:'allowed-once'}` → request resolve 'allowed-once' → approval/asked + decided
   审计对落会话。桌面经 HTTP 应答审批的服务端链路完整（不经内核，interactions 端点
   只碰 bridge）。
7. **桌面 typecheck + build**：`npm run typecheck` exit 0、`electron-vite build` exit 0
   （main/preload/renderer 三端产物生成）。
8. **回归**：planner tsc exit 0；M2 三场景 E2E（workflow/ralph/plan-mode）全部 `E2E_PASS`
   无回归。

### I.4 已知边界（后续产品联调完善）

- **真实内核 + Electron 实机端到端**：服务端闭环已全链验证（agent-loop → user-questions
  /approval 挂起 → HTTP 拉取/应答 → turn 获批，E2E_M3/HTTP_ANSWER），桌面 UI 接点（git
  状态条/回滚、HomeView plan 预设、审批弹窗轮询）经 typecheck + build 验证、UI 文案随
  renderer bundle 产物确认；**真实 LLM + 内核 + Electron 弹窗的整机联调**待产品联调环境
  复测（planner IPC 契约与 ChatPane 弹窗逻辑均已静态验证）。
- **ChatPane 渲染模型**：仍为气泡 + 工具名小字 + 事件折叠形态（W1 block 消息模型/工具卡片组
  重写未排入本阶段，见《Agent聊天窗口设计文档》W4 说明）；本阶段只补产品交互接点
  （审批/plan/git/烧录弹窗），渲染重写独立估期。
  > **2026-09-06 增补**：W1（block 基础）桌面渲染层重写已**开工**（见《Agent聊天窗口设计文档》
  > §8 W1）——`renderer/chatModel.ts`（回合归并 + text/工具卡组三态组装器）+ `BlockViews.tsx`
  > + ChatPane 消息区改块渲染，typecheck/build exit 0；纯渲染层先行、缺 typed 数据降级，
  > 后端桥接（assistant/chunk、turn/usage/callId）留待数据补齐轮。
  > **2026-09-06 增补（W1 数据桥接轮完成）**：`planner/src/plugins/events-bridge.ts`
  > ① 桥接 `assistant/chunk`（仅 text-delta，按 FLUSH_CHARS=24 聚合 → 内核
  > `assistant/chunk` 事件，payload `{delta,turn,step}`；reasoning/tool-call delta 不外发；
  > turn/step 切换与 assistant/message、turn/end 前强制 flush 防尾丢失）；
  > ② `tool/call`/`tool/result` payload 补 `callId`；③ `turn/start` payload 补 `turn`。
  > 桌面 ChatPane 增打字机尾巴（deriveStreamTail 纯推导：取最近定型事件后的 chunk 增量
  > 拼接；assistant/message 刚落库而块未刷时以全文续显），live 行不再重复铺 assistant/*。
  > 验证：planner tsc exit 0、桌面 typecheck + build exit 0；实机打字机节拍待联调复测。
  >
  > **2026-09-06 增补（缺陷修复 · 发送失败零提示）**：实机复测发现「改工作目录后内核重启 → 发送
  > 无反应且无提示」。根因双层：① 主进程仅启动时拉起 planner，内核重启（工作目录变更/崩溃自愈）
  > 换端口/token 后 planner 仍连旧内核 URL → chat 500 fetch failed；② ChatPane/HomeView 发送
  > 路径把失败静默吞掉（safeIpc 返回 null 后再读 `.session_id` 抛 TypeError 仅 console.error）。
  > 修复：`main/index.ts` 增 `syncPlannerToKernel`（内核 status=running 时按新地址/令牌幂等
  > 联动 `planner.restart`，串行化防并发）；`planner-manager.ts` 增 `restart()` + 绑定内核指纹
  > `isBoundTo()`；ChatPane 全用户操作接入可见错误行（opErr + safeIpc null 判空），HomeView
  > 判空并提示（i18n 增 errNotReady/errNoSession）。typecheck + build exit 0。
- **ask_user_question 模型可见工具**：C3 面已由 exit_plan_mode 与沙盒升级审批覆盖；如需模型
  主动提问（`dsh-tool-ask-user`），按需装配（schema 与 rc.5 一字不差，走同一 provider）。
- **多问题/自定义输入**：questions 弹窗当前逐条展示、按选项 label 应答；自由文本 custom 输入
  与多选 UI 待桌面打磨（协议已支持）。
- **内核子进程 OS 级限制**（C1 附录 D.4 spike）：read-only fail-closed + cwd 防穿越与桌面
  接线正交，单独评估。
- 事件字典新增 `approval/asked`、`approval/decided`（会话 JSONL 已落，原包审计）：
  UI 表格回写 Phase 5 统一处理。
