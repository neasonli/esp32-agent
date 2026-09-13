/**
 * 共享类型（主进程 / preload / 渲染进程 三侧共用，纯类型无运行时依赖）
 */
export type KernelStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface KernelStatusInfo {
  status: KernelStatus
  port: number | null
  pid: number | null
  startedAt: number | null
  restarts: number
  /** 主进程发事件时标注来源进程（内核本体不带，规划器带 'planner'） */
  kind?: 'kernel' | 'planner'
  /** 规划器自报的实际生效模型（仅 kind === 'planner' 时有值） */
  effectiveModel?: string
  lastError?: string
}

/**
 * 知识库后端状态（内核 /api/health 的 kb_* 投影）。
 * 方案 A 接缝：`private` = 私有知识库包已启用（手册检索可用）；
 * `stub` = 公开仓通用模式（不含语料，检索返回空）→ 界面提示"手册检索未启用"。
 */
export interface KbStatusInfo {
  kb_backend: 'private' | 'stub' | string
  kb_available: boolean
  kb_docs: number
  kb_note?: string
  kb_store_dir?: string
  kb_version?: string
}

export interface KernelEvent {
  seq: number
  task_id: string
  ts: string
  level: string
  node: string
  message: string
  /** 阶段3 Phase2 · 统一事件字典类型（§5.2：turn/start、tool/call、tool/result、assistant/chunk、check/start、diagnostic…）；历史事件为空串 */
  event_type?: string
  /** 结构化载荷（JSON 已解析）；tool/call={name,args}、tool/result={name,error}、diagnostic=CodeDiagnostic 等 */
  payload?: Record<string, unknown> | null
}

export interface TaskSubmitResult {
  task_id: string
  status: string
}

export interface ArtifactInfo {
  name: string
  path: string
  size_kb: number
}

export interface UsageSummary {
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  cost: number
  by_node: { node: string; calls: number; pt: number; ct: number }[]
}

export interface ConversationItem {
  task_id: string
  requirement: string
  status: string
  chip: string
  project_dir: string
  error_msg: string
  created_at: string
  updated_at: string
  total_tokens: number
  artifacts: ArtifactInfo[]
}

export interface ConversationDetail {
  user_requirement: string
  status: string
  chip_model: string
  project_dir: string
  result?: Record<string, unknown>
  error_msg: string
  created_at: string
  updated_at: string
  usage: UsageSummary
  events: KernelEvent[]
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  path: string
}

export interface FileContent {
  path: string
  name: string
  size: number
  content: string
}

export interface LlmConfigInput {
  llm_base_url?: string
  llm_api_key?: string
  llm_model?: string
  llm_temperature?: number
}

/** 对话式 Agent（阶段2 W3）：会话消息 */
/**
 * 内核环境配置（ESP-IDF 编译环境 + LLM）。
 *
 * 以前这些只能写在 `lcode/kernel/.env`；打包版没有 .env（也不该带），
 * 所以必须能持久化到 `userData/kernel-env.json` 并在启动时注入子进程环境。
 */
export interface KernelEnvConfig {
  idf_path?: string
  idf_tools_path?: string
  idf_python_env_path?: string
  idf_target?: string
  llm_api_key?: string
  llm_base_url?: string
  llm_model?: string
  llm_temperature?: number
  /** 内核解析出的 idf.py 路径（null = 未找到，编译不可用） */
  idf_py?: string | null
  /** 内核是否就绪（未就绪时返回的是本地持久化值） */
  kernel_ready?: boolean
}

/** 保存时只传发生变化的字段 */
export type KernelEnvPatch = Partial<KernelEnvConfig>

/** ESP-IDF 环境检测结果（内核 /api/env_probe） */
export interface IdfProbeResult {
  idf_py?: string | null
  ok?: boolean
  idf_path?: string
  idf_tools_path?: string
  idf_python_env_path?: string
  idf_target?: string
  idf_path_exists?: boolean
  export_script?: string
  export_script_exists?: boolean
  idf_tools_path_exists?: boolean
  python_env_exists?: boolean
  idf_version?: string
  probe_log?: string
  hint?: string
  deep?: boolean
}

/** 组件载荷名：ESP-IDF 编译环境 / 领域知识库（都是"单独下载安装"的扩展件） */
export type ComponentName = 'esp-idf' | 'kb'

/** 组件状态（主进程 components.ts 投影给设置页） */
export interface ComponentStatus {
  name: ComponentName
  installed: boolean
  dir: string
  version: string
  /** 随包归档路径（非空则可一键安装） */
  bundledZip: string
  bytes: number
  note: string
}

/** LLM 端点可用模型列表（内核 /api/llm/models） */
export interface LlmModelList {
  base_url?: string
  /** 当前配置的模型（永远出现在 models 里） */
  current?: string
  /** 可选项：端点登记的模型 + 当前值（若当前值是未登记别名） */
  models?: string[]
  /** 端点真正登记的模型（不含我们补进去的当前值） */
  endpoint_models?: string[]
  /** 当前值是否来自端点登记清单（false = 它是未登记的别名，如 deepseek-chat） */
  current_from_endpoint?: boolean
  /** endpoint = 端点真的返回了清单；preset = 回退预置；none = 都拿不到 */
  source?: 'endpoint' | 'preset' | 'none' | string
  note?: string
}

/** LLM 连接测试结果（内核 /api/llm/probe） */
export interface LlmProbeResult {
  requested_model?: string
  configured_model?: string
  base_url?: string
  ok?: boolean
  /** 服务端实际服务的模型（别名会被解析成规范模型） */
  served_model?: string
  latency_ms?: number
  error?: string
}

/**
 * 规划器（DSH 子进程）当前**实际生效**的 LLM 身份。
 * 对话跑的是这个进程，所以它的模型/Key 才是权威值；设置页里填的只是"请求值"。
 */
export interface PlannerLlmInfo {
  /** 实际使用的模型（规划器只认 v4 型号，别名会被改写） */
  model: string
  /** 桌面设置页请求的模型原值（可能被改写，界面据此解释差异） */
  requested_model: string
  llm_base_url: string
  /** 规划器进程里那把 Key 的末 4 位（绝不回传整串） */
  api_key_tail: string
  /** 'env' = 来自桌面注入（设置页）；'none' = 无，退回 DSH 凭据文件 */
  api_key_source: string
}

/**
 * 对话承载方式。
 * - `planner`：规划器（DSH 子进程）承载 —— 全功能（plan-mode / 推理等级 / 子代理 / 队列坞）
 * - `slim`：兜底**精简模式**，对话交给内核自带 Agent（`POST /api/chat`）。
 *   触发条件：规划器运行时不存在（打包版未随包）或规划器连续崩溃。
 *   能力差：无 plan-mode、无推理等级、无子代理/队列坞；主线（对话/改码/编译）不变。
 */
export interface ChatModeInfo {
  mode: 'planner' | 'slim'
  reason: string
  planner_status: string
  planner_available: boolean
  planner_error: string
}

export interface ChatMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_name: string
  tool_call_id: string
  ts: string
}

/** 首页项目（opencode 主页左栏：一个工程目录 = 一个项目，含其下的对话会话） */
export interface WorkspaceItem {
  /** 工程目录（项目路径） */
  dir: string
  /** 展示名（目录 basename） */
  name: string
  /** 最近活动时间（ISO，按会话 updated_at 取最大） */
  updated_at: string
  /** 该项目下的可见对话会话数 */
  chat_count: number
}

/** 对话式 Agent：会话列表项 */
export interface ChatSessionItem {
  session_id: string
  title: string
  cwd: string
  status: string
  created_at: string
  updated_at: string
  msg_count: number
}

/** 对话式 Agent：会话详情 */
export interface ChatSessionDetail {
  session_id: string
  title: string
  cwd: string
  status: string
  created_at: string
  updated_at: string
  messages: ChatMessage[]
  events: KernelEvent[]
  /** 每 100 轮暂停，等待用户确认继续/停止 */
  waiting_confirm?: boolean
  /** 已执行 LLM 轮次（跨轮次累计） */
  chat_steps?: number
  /** 执行权限：True=全部执行（Full Access），False=普通模式 */
  full_access?: boolean
  /** 阶段3 Phase2：待烧录请求（防误烧——对话中只登记，会话确认后由用户显式确认端口执行） */
  pending_flash?: { project_dir: string; port: string; requested_at: string } | null
  /** 上下文使用估算（与内核 _load_messages 同口径：按 token 预算截断 + 4字符/token 密度） */
  context?: {
    total_tokens_estimate: number
    message_tokens: number
    envelope_tokens: number
    total_chars: number
    message_count: number
    total_messages: number
    window_tokens: number
    ratio: number
    level: 'ok' | 'warn' | 'danger'
  }
}

/** preload 暴露给渲染进程的白名单 API（D19：最小化） */
export interface LCodeApi {
  getKernelStatus: () => Promise<KernelStatusInfo | null>
  /** 知识库后端状态（内核 /api/health 投影）：stub = 通用模式，手册检索未启用 */
  getKbStatus: () => Promise<KbStatusInfo | null>
  restartKernel: () => Promise<KernelStatusInfo | null>
  submitTask: (requirement: string, workspaceId?: string) => Promise<TaskSubmitResult>
  cancelTask: (taskId: string) => Promise<{ status: string }>
  resumeTask: (taskId: string, fullRestart?: boolean) => Promise<{ status: string; resume: string }>
  deleteTasks: (taskIds: string[]) => Promise<{ deleted: number; skipped: string[] }>
  getConversations: () => Promise<{ conversations: ConversationItem[] }>
  getConversation: (taskId: string) => Promise<ConversationDetail>
  /**
   * 对话式 Agent（阶段2 W3 / 阶段3 M2：plan_mode 意图透传；W2.5：reasoningEffort 透传；
   * 工作区绑定：cwd 新建会话时生效；delivery：运行中投递方式 —— 'queue'=排队（下一轮执行，
   * DSH Enter 语义）/ 'steer'=立即投递给运行中的 Agent（DSH Ctrl+Enter 语义））。
   */
  chat: (message: string, sessionId?: string, fullAccess?: boolean, planMode?: boolean, reasoningEffort?: ReasoningEffort, cwd?: string, delivery?: ChatDelivery) => Promise<{ session_id: string; status: string; mode?: 'planner' | 'slim' }>
  /** 当前对话承载方式（精简模式提示与控件显隐据此判定） */
  chatMode: () => Promise<ChatModeInfo | null>
  /** 运行中「待发送队列」（DSH QueueDock 同源：planner 侧 DSH agent inbox 投影） */
  getChatQueue: (sessionId: string) => Promise<{ session_id: string; items: QueuedChatItem[] }>
  /** 删除待发送队列中的一条消息 */
  removeChatQueueItem: (sessionId: string, messageId: string) => Promise<{ session_id: string; message_id: string; removed: boolean }>
  cancelChat: (sessionId: string) => Promise<{ session_id: string; status: string }>
  /** 会话分支（阶段4 W4）：复制锚点消息前的全部上下文开新对话，返回新会话 ID */
  forkChat: (sessionId: string, atMessageId: number) => Promise<{ session_id: string }>
  setChatAccess: (sessionId: string, fullAccess: boolean) => Promise<{ session_id: string; full_access: boolean }>
  /** 会话级推理等级即时切换（off/high/max；参照 DSH effort 档位） */
  setChatEffort: (sessionId: string, reasoningEffort: ReasoningEffort) => Promise<{ session_id: string; reasoning_effort: ReasoningEffort }>
  /** 读会话当前推理等级（规划器登记内存态；未登记/缺省返回 'high'） */
  getChatEffort: (sessionId: string) => Promise<ReasoningEffort | null>
  /** 会话 plan-mode 当前状态（planner agent 权威值，驱动 PlanChip 仅开启时出现） */
  getChatPlanState: (sessionId: string) => Promise<{ session_id: string; plan_active: boolean }>
  /** Plan-mode 即时切换（/plan、/plan off、PlanChip ✕：直接翻转 agent 状态） */
  setChatPlanMode: (sessionId: string, planActive: boolean) => Promise<{ session_id: string; plan_active: boolean; plan_pending: boolean; outcome: string }>
  /** 会话确认结束后显式烧录（防误烧；Phase 2） */
  confirmFlash: (sessionId: string, projectDir: string, port: string) => Promise<{ session_id: string; status: string }>
  dismissFlash: (sessionId: string) => Promise<{ session_id: string; status: string }>
  /** 阶段3 M3：人机交互（approval/questions）拉取与应答 */
  listInteractions: (sessionId?: string) => Promise<{ interactions: PendingInteraction[] }>
  answerInteraction: (id: string, answer: InteractionAnswerPayload) => Promise<{ answered: boolean }>
  getChatSessions: () => Promise<{ sessions: ChatSessionItem[] }>
  getChatSession: (sessionId: string) => Promise<ChatSessionDetail>
  /** 删除对话会话（清理不在规划器内的死会话；含历史/事件，不可恢复） */
  deleteChatSessions: (sessionIds: string[]) => Promise<{ deleted: number }>
  /** 工作区目录浏览（主进程本地 fs；与内核 _safe_resolve 同口径，越界拒绝） */
  listWorkspaceFiles: (dir: string) => Promise<{ path: string; entries: FileEntry[] }>
  readWorkspaceFile: (path: string) => Promise<FileContent>
  updateLlmConfig: (cfg: LlmConfigInput) => Promise<{
    status: string
    model: string
    base_url: string
    /** 内核未就绪时只是落盘；内核就绪后由主进程自动补推（见 pushEnvConfigToKernel） */
    kernel_ready?: boolean
    /** 因 LLM 配置变化而重启了规划器（对话进程持有 spawn 时的环境副本，必须重启才生效） */
    planner_restarting?: boolean
  }>
  /** 规划器（真正跑对话的进程）当前生效的 LLM 身份：模型 / base / Key 末 4 位 */
  plannerLlmInfo: () => Promise<PlannerLlmInfo | null>
  getKernelConfig: () => Promise<{ llm_model: string; llm_base_url: string; kernel_concurrency: number } | null>
  /** 环境配置（ESP-IDF 编译环境 + LLM）读取：内核就绪时以内核实况为准，否则回退本地持久化文件 */
  getEnvConfig: () => Promise<KernelEnvConfig | null>
  /** 环境配置保存：先落盘（userData/kernel-env.json），再热更新到内核（立即生效） */
  updateEnvConfig: (cfg: KernelEnvPatch) => Promise<Record<string, unknown> | null>
  /** ESP-IDF 环境检测：deep=true 会真跑一次 `idf.py --version`（几秒~几十秒） */
  probeIdf: (deep?: boolean) => Promise<IdfProbeResult | null>
  /** 列出当前 LLM 端点的可用模型（设置页下拉选择用） */
  listLlmModels: () => Promise<LlmModelList | null>
  /** 测试 LLM 连接（设置页「测试连接」；返回服务端实际使用的模型） */
  probeLlm: (model?: string) => Promise<LlmProbeResult | null>
  /** 组件载荷状态（ESP-IDF / 知识库） */
  componentStatus: () => Promise<ComponentStatus[] | null>
  /** 从 zip 安装组件（弹文件选择框；返回 null 表示 IPC 失败） */
  installComponent: (name: ComponentName) => Promise<{ ok: boolean; cancelled?: boolean; message: string } | null>
  /** 打开组件目录 */
  openComponentDir: (name: ComponentName) => Promise<string | null>
  updateKernelConfig: (cfg: { kernel_concurrency: number }) => Promise<{ status: string; kernel_concurrency: number } | null>
  getWorkspaces: () => Promise<{ workspaces: unknown[] }>
  onKernelStatus: (cb: (info: KernelStatusInfo) => void) => () => void
  onKernelEvent: (cb: (ev: KernelEvent) => void) => () => void
  /** 工作区目录内容变化（主进程 fs.watch 去抖推送；文件树据此立即刷新） */
  onWorkspaceChanged: (cb: (root: string) => void) => () => void
  /** 自定义菜单栏动作（V1.5：隐藏标题栏后原生菜单不可见，用 UI 菜单替代） */
  appQuit: () => Promise<void>
  appReload: () => Promise<void>
  toggleDevTools: () => Promise<void>
  /** 工作目录（生成的工程输出根） */
  pickDirectory: () => Promise<string | null>
  setWorkspaceDir: (dir: string | null) => Promise<string | null>
  getWorkspaceDir: () => Promise<string | null>
  openWorkspaceFolder: () => Promise<string | null>
  /** 帮助 →「支持开发者」：读取本地「收款码」目录图片，返回 data URL 供弹窗展示 */
  getPaymentQr: () => Promise<{ dir: string; images: { name: string; dataUrl: string }[] } | null>
  /** 帮助 →「打开官网」：用系统浏览器打开官网（URL 固定在主进程，渲染层不传地址） */
  openOfficialSite: () => Promise<string | null>
}

/** 推理等级（reasoning effort，参照 DSH ModelSelect 的 Effort 档位；llm-deepseek 支持 off/high/max）。 */
export type ReasoningEffort = 'off' | 'high' | 'max'

/** 运行中投递方式（照抄 DSH composer：Enter=queue 排队 / Ctrl+Enter=steer 立即投递）。 */
export type ChatDelivery = 'queue' | 'steer'

/** 待发送队列项（planner 侧 DSH agent inbox 投影；placement：next-turn=排队、next-step=已 steer 未消费）。 */
export interface QueuedChatItem {
  id: string
  text: string
  placement: 'next-turn' | 'next-step'
}

/** 阶段3 M3：待应答人机交互（与 planner interaction-bridge 的只读视图对齐）。 */
export type PendingInteraction =
  | {
    id: string
    kind: 'approval'
    sessionId: string
    toolName: string
    callId?: string
    reason?: string
    createdAt: number
  }
  | {
    id: string
    kind: 'questions'
    sessionId: string
    questions: {
      id: string
      question: string
      detail?: string
      header?: string
      options?: { label: string; description?: string }[]
      multiSelect?: boolean
      intent?: { kind: string; approve: string }
    }[]
    createdAt: number
  }

/** M3 应答载荷（approval outcome 或 questions answers）。 */
export type InteractionAnswerPayload =
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { kind: 'questions'; answers: { id: string; selected: string[]; custom?: string }[] }
