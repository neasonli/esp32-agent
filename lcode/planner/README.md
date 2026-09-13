# L-CODE 规划器（阶段3 · Phase 1 落地）

规划器 = **独立 Node 进程**（无窗口），承载对话/规划循环（turn/step + 钩子 + goal 续跑），
经本地 HTTP 调用 Python 内核执行真实工具（编译/烧录/文件/shell）。桌面端行为不变、
**不依赖 LangGraph**（agent核心开发文档 §8 Phase 1）。

## 装配清单（agent核心开发文档 §1.2 裁剪的落地）

本包是 DSH profile bundle：`cordis.patch.yml` 只插入一个自研插件行 `@lcode/planner`，
由 `src/index.ts` 在 apply 中程序化装配（与 `@deepseek-ai/dsh-agent-spine-demo` 同构）：

| 文档 1.2 清单 | 落地位置 | 说明 |
|---|---|---|
| settings | `FileSettingsProvider` | `$DSH_HOME/settings.yaml` 热重载 |
| credentials | `LocalCredentialProvider` | `DEEPSEEK_API_KEY` 逐请求解析 |
| llm (+ llm-deepseek) | `LlmRuntime` + `LlmDeepSeek` | provider 路由 `deepseek-official` |
| agent-spine（agent/loop/tools/session/system-prompt） | `AgentRegistry` + `AgentLoop` + `ToolRuntime` + `SessionStore` + `SystemPrompt` | 无预创建 agent，会话按需创建 |
| goal + tool-goal + goal-round-driver | `GoalService` + `toolGoal` + `goalRoundDriver` | **goal 续跑可用** |
| persistence / checkpoint / session-projection / token-meter / compaction | 对应插件 | JSONL 持久化 + 检查点 + 压缩 |
| fs + tool-fs | `SandboxedFileSystem`（dsh-fs-sandbox，替换 fs-local）+ `FsObservationPolicy` + `ToolFs` | 规划器侧文件工具；write/edit 按沙盒策略围栏（V3.1） |
| **沙盒族（V3.1 · rc.5 复刻）** | `LocalSandboxProvider`（dsh-sandbox-local）+ `SandboxPolicyService`（dsh-sandbox-policy）+ `ApprovalService`（dsh-user-approval） | 文件效应策略 read-only/workspace-write/danger-full-access + 每会话 sandbox/mode 覆盖 + 运行时上下文 + 升级审批（agent核心开发文档 附录 D） |
| skill 三插件 | `SkillRegistry` + `SkillFileSystem` + `toolSkill` | 指令型知识 |
| **自有插件** | `src/plugins/*` | 见下 |

**不装配（v1 现状；后续按 Phase 启用）**：web / tool-web / terminal / pty / e2b / bash /
subprocess / todo / telemetry；subagent / workflow / ralph / plan-mode 后置到 **Phase 4/5**
（§8 Phase 4 = DSH workflow agent 脚本编排，见 agent核心开发文档 附录 D）。

## 自有插件（src/plugins/）

| 插件 | 职责 |
|---|---|
| `kernel-tools` | 内核工具包装器：shell/git_clone/list_dir/read_file/write_file/build/flash +
   底座工具集 **edit_file/file_tree/glob/grep/run_check**（阶段3 Phase3：统一底座工具集，
   取代 Phase2 合并版 search）注册为 DSH 工具，经 `POST /api/planner/tool/{name}` 透传内核执行
   （工作目录/权限取自会话；工具调用带 task_id=会话 id，工具侧 patch/check/git 事件落对会话） |
| `hooks` | 瀑布钩子：`agent/request`（provider/model 兜底 + maxTokens）、`agent/pre-step`（v1 透传，扩展点）、`agent/turn-stopping`（turn 计数同步内核） |
| `events-bridge` | 会话事件 → 内核 `events` 表 + `chat_messages` 表（task_id=session_id，桌面 500ms 轮询不变；按会话串行转发保证消息顺序；事件按 §5.2 字典带 event_type/payload 落库；**turn/end 自动 git checkpoint**） |
| `server` | 本地 HTTP 服务（X-Planner-Token）：`/api/planner/chat` `/cancel` `/access`
  `/flash_confirm` `/flash_dismiss`（阶段3 Phase2：会话确认后显式烧录/取消，透传内核）
  `/git_checkpoint` `/git_rollback` `/git_status`（阶段3 Phase3：工作区 git 会话 checkpoint/回滚/状态）
  `/sessions` `/health` `/shutdown` |
| `runner` | 一次性任务：`dsh --profile lcode-planner "任务"` 打印最终回复后退出；无任务 = 常驻 server 模式 |

## 烧录流程（阶段3 Phase2 · 防误烧）

对话中 `flash` 工具**只登记不执行**（写入会话 pending_flash + flash/requested 事件）；
会话确认结束后，桌面弹窗核对串口端口，用户点「确认烧录」→ 内核
`POST /api/planner/flash_confirm` 后台执行 idf.py flash（flash/start → flash/end 事件回流）；
「取消烧录」→ `/api/planner/flash_dismiss`（flash/cancelled）。

## 安装（一次性）

```sh
cd lcode/planner
node scripts/setup-profile.mjs     # 创建 $DSH_HOME/profiles/lcode-planner 并安装本包（link 协议）
```

前置：DSH checkout 位于 `D:\1_ai_project\deepseek\deepseek-harness-master`（可用 `LCORE_DSH_REPO` 覆盖）。

## 运行

```sh
# 一次性会话（开发/联调）
cd D:\1_ai_project\deepseek\deepseek-harness-master
pnpm dsh --profile lcode-planner "任务"

# 常驻 server（供 Electron 网关 spawn/守护；端口/令牌由网关注入）
$env:LCORE_KERNEL_URL='http://127.0.0.1:8090'   # 内核地址
$env:LCORE_KERNEL_TOKEN='...'                    # 内核令牌
$env:LCORE_PLANNER_PORT='8790'                   # 规划器自身端口
$env:LCORE_PLANNER_TOKEN='...'                   # 规划器令牌
pnpm dsh --profile lcode-planner
```

LLM：`DEEPSEEK_API_KEY`（默认走 `$DSH_HOME/.credentials.yaml`）、可选 `DEEPSEEK_BASE_URL`
（复用内核同款 DeepSeek 兼容接口）、`LCORE_LLM_MODEL`（默认 deepseek-v4-flash）。

沙盒（V3.1 · rc.5 复刻，附录 D）：`LCORE_SANDBOX_MODE` = read-only / workspace-write /
danger-full-access（**默认 workspace-write**；danger-full-access = V3.0 及之前行为，审批自动
never）。模式决定规划器侧 fs 工具（write/edit）与内核工具（write_file/edit_file 等）的
文件效应边界；每会话可经 `sandbox/mode` 事件覆盖（桌面 UI 切换后置 Phase 5）。

## 桌面端接线（lcode/desktop）

- `src/main/planner-manager.ts`：`PlannerManager`（spawn 规划器进程 + 心跳 + 崩溃重启 +
  对话客户端），开发模式经 `node --import tsx/esm <DSH>/apps/cli/src/bin.ts --profile lcode-planner`
  拉起，LLM 配置优先读 `kernel/.env`。
- `src/main/index.ts`：`chat:send` / `chat:cancel` / `chat:access` 路由到规划器；
  事件轮询（EventPoller → 内核 `/api/events`）与聊天历史（内核 `/api/chat_session`）**不变**。

## 内核新增端点（lcode/kernel/api/main.py）

`POST /api/planner/tool/{name}`、`POST /api/planner/event`、`POST /api/planner/chat_message`、
`POST /api/planner/chat_session`、`POST /api/planner/chat_state`、`GET /api/planner/info`、
`POST /api/planner/git_checkpoint`、`POST /api/planner/git_rollback`、`POST /api/planner/git_status`
（阶段3 Phase3：工作区 git 化 + 会话 checkpoint，实现见 `kernel/tools/git_safe.py`）。

`kernel/agent/chat_agent.py` 手写循环已退役（`/api/chat` 不再被桌面调用；`_check_access`
权限检查保留供规划器工具透传复用）。
