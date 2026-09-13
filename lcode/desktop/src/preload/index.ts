/**
 * preload 白名单（W2 第二批）
 *
 * D19 铁律的载体：只暴露最小化 API，渲染进程零业务逻辑。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ComponentName,
  ComponentStatus,
  ConversationDetail,
  FileContent,
  FileEntry,
  KernelEnvPatch,
  KernelEvent,
  KernelStatusInfo,
  LCodeApi,
  LlmConfigInput,
  TaskSubmitResult
} from '../shared/types'

const api: LCodeApi = {
  getKernelStatus: () => ipcRenderer.invoke('kernel:getStatus'),
  getKbStatus: () => ipcRenderer.invoke('kernel:kbStatus'),
  restartKernel: () => ipcRenderer.invoke('kernel:restart'),

  submitTask: (requirement: string, workspaceId?: string) =>
    ipcRenderer.invoke('task:submit', requirement, workspaceId),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  resumeTask: (taskId: string, fullRestart = false) =>
    ipcRenderer.invoke('task:resume', taskId, fullRestart),
  deleteTasks: (taskIds: string[]) => ipcRenderer.invoke('task:delete', taskIds),

  getConversations: () => ipcRenderer.invoke('kernel:getConversations'),
  getConversation: (taskId: string) => ipcRenderer.invoke('kernel:getConversation', taskId),
  chat: (message: string, sessionId?: string, fullAccess?: boolean, planMode?: boolean, reasoningEffort?: string, cwd?: string, delivery?: 'queue' | 'steer') =>
    ipcRenderer.invoke('chat:send', message, sessionId ?? '', fullAccess, planMode, reasoningEffort, cwd, delivery),
  getChatQueue: (sessionId: string) => ipcRenderer.invoke('chat:queue', sessionId),
  removeChatQueueItem: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke('chat:queueRemove', sessionId, messageId),
  cancelChat: (sessionId: string) => ipcRenderer.invoke('chat:cancel', sessionId),
  /** 当前对话承载方式：planner（全功能）或 slim（精简兜底，内核 Agent 承载） */
  chatMode: () => ipcRenderer.invoke('chat:mode'),
  forkChat: (sessionId: string, atMessageId: number) =>
    ipcRenderer.invoke('chat:fork', sessionId, atMessageId),
  setChatAccess: (sessionId: string, fullAccess: boolean) =>
    ipcRenderer.invoke('chat:access', sessionId, fullAccess),
  setChatEffort: (sessionId: string, reasoningEffort: string) =>
    ipcRenderer.invoke('chat:effort', sessionId, reasoningEffort),
  getChatEffort: (sessionId: string) =>
    ipcRenderer.invoke('chat:effortGet', sessionId),
  getChatPlanState: (sessionId: string) =>
    ipcRenderer.invoke('chat:planState', sessionId),
  setChatPlanMode: (sessionId: string, planActive: boolean) =>
    ipcRenderer.invoke('chat:planMode', sessionId, planActive),
  confirmFlash: (sessionId: string, projectDir: string, port: string) =>
    ipcRenderer.invoke('flash:confirm', sessionId, projectDir, port),
  dismissFlash: (sessionId: string) => ipcRenderer.invoke('flash:dismiss', sessionId),
  listInteractions: (sessionId?: string) =>
    ipcRenderer.invoke('planner:interactions', sessionId),
  answerInteraction: (id: string, answer: { kind: 'approval'; outcome?: string } | { kind: 'questions'; answers?: { id: string; selected: string[]; custom?: string }[] }) =>
    ipcRenderer.invoke('planner:interactionsAnswer', id, answer),
  getChatSessions: () => ipcRenderer.invoke('kernel:getChatSessions'),
  getChatSession: (sessionId: string) =>
    ipcRenderer.invoke('kernel:getChatSession', sessionId),
  deleteChatSessions: (sessionIds: string[]) =>
    ipcRenderer.invoke('chat:delete', sessionIds),
  listWorkspaceFiles: (dir: string) => ipcRenderer.invoke('workspace:listFiles', dir),
  readWorkspaceFile: (path: string) => ipcRenderer.invoke('workspace:readFile', path),
  updateLlmConfig: (cfg: LlmConfigInput) => ipcRenderer.invoke('kernel:updateLlmConfig', cfg),
  getKernelConfig: () => ipcRenderer.invoke('kernel:getKernelConfig'),
  /** 环境配置（ESP-IDF + LLM）：读当前值（内核就绪时以内核实况为准） */
  getEnvConfig: () => ipcRenderer.invoke('kernel:getEnvConfig'),
  /** 环境配置保存：先落盘（userData/kernel-env.json）再热更新到内核 */
  updateEnvConfig: (cfg: KernelEnvPatch) => ipcRenderer.invoke('kernel:updateEnvConfig', cfg),
  /** ESP-IDF 环境检测：deep=true 时真跑 idf.py --version */
  probeIdf: (deep = false) => ipcRenderer.invoke('kernel:probeIdf', deep),
  /** 列出 LLM 端点可用模型（下拉选择用；端点不支持时内核回退预置清单） */
  listLlmModels: () => ipcRenderer.invoke('kernel:listModels'),
  /** 组件载荷（ESP-IDF / 知识库）状态：单独下载/安装的扩展件 */
  componentStatus: () => ipcRenderer.invoke('components:status'),
  /** 从 zip 安装组件（弹文件选择框） */
  installComponent: (name: ComponentName) => ipcRenderer.invoke('components:install', name),
  /** 打开组件目录（便于用户放/看文件） */
  openComponentDir: (name: ComponentName) => ipcRenderer.invoke('components:openDir', name),
  /** 测试 LLM 连接：一次极小真实调用，返回服务端实际使用的模型 */
  probeLlm: (model?: string) => ipcRenderer.invoke('kernel:probeLlm', model),
  updateKernelConfig: (cfg: { kernel_concurrency: number }) =>
    ipcRenderer.invoke('kernel:updateKernelConfig', cfg),
  /** 规划器（跑对话的进程）实际生效的模型与 Key 末 4 位 */
  plannerLlmInfo: () => ipcRenderer.invoke('planner:llmInfo'),
  getWorkspaces: () => ipcRenderer.invoke('kernel:getWorkspaces'),

  onKernelStatus: (cb: (info: KernelStatusInfo) => void) => {
    const listener = (_e: unknown, info: KernelStatusInfo) => cb(info)
    ipcRenderer.on('kernel:status', listener)
    return () => ipcRenderer.removeListener('kernel:status', listener)
  },
  onKernelEvent: (cb: (ev: KernelEvent) => void) => {
    const listener = (_e: unknown, ev: KernelEvent) => cb(ev)
    ipcRenderer.on('kernel:event', listener)
    return () => ipcRenderer.removeListener('kernel:event', listener)
  },
  /** 工作区目录内容变化（主进程 fs.watch 去抖推送）→ 文件树立即刷新 */
  onWorkspaceChanged: (cb: (root: string) => void) => {
    const listener = (_e: unknown, root: string) => cb(root)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },

  appQuit: () => ipcRenderer.invoke('app:quit'),
  appReload: () => ipcRenderer.invoke('app:reload'),
  toggleDevTools: () => ipcRenderer.invoke('app:devtools'),
  pickDirectory: () => ipcRenderer.invoke('app:pickDirectory'),
  setWorkspaceDir: (dir: string | null) => ipcRenderer.invoke('app:setWorkspaceDir', dir),
  getWorkspaceDir: () => ipcRenderer.invoke('app:getWorkspaceDir'),
  openWorkspaceFolder: () => ipcRenderer.invoke('app:openWorkspaceFolder'),
  getPaymentQr: () => ipcRenderer.invoke('app:paymentQr'),
  openOfficialSite: () => ipcRenderer.invoke('app:openOfficialSite')
}

contextBridge.exposeInMainWorld('lcode', api)

export type { ConversationDetail, FileContent, FileEntry, KernelEvent, KernelStatusInfo, TaskSubmitResult }
