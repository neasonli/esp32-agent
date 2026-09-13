import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  ChatSessionItem,
  ConversationItem,
  KernelStatusInfo,
  WorkspaceItem
} from '../../../shared/types'

export type View = 'home' | 'task' | 'settings' | 'workspace'
export type Layout = 'treeLeft' | 'chatLeft'
export type Lang = 'zh' | 'en'
/** 聊天框发送快捷键：enter = Enter 直接发送（默认，WorkBuddy 语义，不显示提示）；ctrlEnter = Ctrl+Enter 发送并显示提示 */
export type SendMode = 'enter' | 'ctrlEnter'

/** 路径规范化（Windows 分隔符/大小写不敏感；目录去重与归属比较用） */
function normDir(p: string): string {
  return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 打开过的项目目录入栈：去重（保留最近一次路径写法）、最新在前、上限 30 条 */
function bumpOpenedDirs(dirs: string[], dir: string): string[] {
  const d = (dir ?? '').trim()
  if (d === '') return dirs
  const rest = dirs.filter((x) => normDir(x) !== normDir(d))
  return [d, ...rest].slice(0, 30)
}

interface AppState {
  view: View
  activeTaskId: string | null
  /** 对话式 Agent 会话（W3）：工作区视图打开的会话 ID */
  activeSessionId: string | null
  kernelStatus: KernelStatusInfo | null
  conversations: ConversationItem[]
  /** 对话会话列表（内核 /api/chat_sessions 缓存；存 store 使首页切换视图/重启后不闪空） */
  chatSessions: ChatSessionItem[]
  /** 任务详情三栏布局：源码树在左(聊天在右) 或 聊天在左(源码树在右) */
  layout: Layout
  /** 三栏宽度（鼠标拖拽分隔条调整；持久化，默认 文件树 256 / 聊天 320） */
  treeWidth: number
  chatWidth: number
  /** 界面语言（中/英，V1.5 设置页） */
  lang: Lang
  /** 聊天框发送快捷键模式（设置页；默认 Enter 直接发送） */
  sendMode: SendMode
  /** 工作区根目录（文件菜单"打开文件夹"设置后进入三栏工作区视图） */
  workspaceRoot: string | null
  /** 打开过的项目列表（opencode 主页左栏：distinct project_dir + 当前工作区） */
  projects: WorkspaceItem[]
  /** 主页选中项目（目录路径；决定右栏聊天记录归属） */
  activeProject: string | null
  /** 打开过的项目目录历史（持久化；无聊天内容的文件夹也保留，重启不消失） */
  openedDirs: string[]
  /**
   * 本次进入工作区是否应自动加载该项目「最新一条聊天记录」（用户 2026-09 拍板）：
   * 打开文件夹 / 选中项目 = true（进去就看到上次在聊的内容，输入框草稿也随会话回填）；
   * 「新建对话」= false（保持空会话引导，不被旧会话抢回）。
   */
  autoOpenLatest: boolean

  setView: (v: View) => void
  openTask: (taskId: string) => void
  /** 打开对话会话（跳工作区视图并加载该会话） */
  openChatSession: (sessionId: string) => void
  /** 首页两栏：聚焦会话到聊天区（不切换视图，会话属于当前工作区） */
  focusChatSession: (sessionId: string) => void
  /** 首页两栏：聚焦任务预览（不切换视图；右栏预览该任务的流水线回看，同时清除聊天聚焦） */
  focusTask: (taskId: string) => void
  /** 首页两栏：新建对话（清除任务/会话选中，右栏显示空会话引导） */
  newChat: () => void
  /** 关闭当前打开的会话（回到该工作区的空会话引导；会话本身不删除） */
  closeChatSession: () => void
  openWorkspace: (dir: string) => void
  /** 工作区：新建对话（进工作区但保持空会话引导，不自动加载最新会话） */
  openWorkspaceNewChat: (dir: string) => void
  /**
   * 聊天框「新会话」按钮：清空当前会话选中、保持空会话引导（当前会话仍留在项目里，
   * 可回首页/项目列表再次打开）。同时禁止自动加载旧会话，避免刚点开就被抢回。
   */
  startNewChat: () => void
  /** 标记「已自动加载最新会话」，避免重复抢焦点 */
  setAutoOpenLatest: (v: boolean) => void
  /** 主页：设置项目列表（轮询刷新） */
  setProjects: (list: WorkspaceItem[]) => void
  /** 主页：选中一个项目（右栏切换为其聊天记录；同时作为当前工作区，聊天绑定该项目） */
  focusProject: (dir: string) => void
  /** 记录一个"打开过的项目"目录（去重入栈；供首页项目列表持久保留） */
  rememberProjectDir: (dir: string) => void
  /** W2 补全：会话卡片"继续优化"→ 工作区视图并加载该任务会话（不改变工作区根） */
  continueTask: (taskId: string) => void
  setKernelStatus: (s: KernelStatusInfo) => void
  setConversations: (list: ConversationItem[]) => void
  setChatSessions: (list: ChatSessionItem[]) => void
  /** 首页轮询快照：一次 set 更新 chatSessions + conversations，并把出现的目录并入 openedDirs */
  applyHomeSnapshot: (sessions: ChatSessionItem[], convs: ConversationItem[]) => void
  setLayout: (l: Layout) => void
  /** 拖拽分隔条调整三栏宽度 */
  setTreeWidth: (w: number) => void
  setChatWidth: (w: number) => void
  setLang: (l: Lang) => void
  setSendMode: (m: SendMode) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      view: 'home',
      activeTaskId: null,
      activeSessionId: null,
      kernelStatus: null,
      conversations: [],
      chatSessions: [],
      layout: 'treeLeft',
      treeWidth: 256,
      chatWidth: 320,
      lang: 'zh',
      sendMode: 'enter',
      workspaceRoot: null,
      projects: [],
      activeProject: null,
      openedDirs: [],
      autoOpenLatest: false,

      setView: (v) => set({ view: v }),
      openTask: (taskId) => set({ view: 'task', activeTaskId: taskId, activeSessionId: null }),
      openChatSession: (sessionId) =>
        set({ view: 'workspace', activeSessionId: sessionId, activeTaskId: null }),
      focusChatSession: (sessionId) =>
        set({ activeSessionId: sessionId, activeTaskId: null }),
      focusTask: (taskId) =>
        set({ activeTaskId: taskId, activeSessionId: null }),
      newChat: () => set({ activeSessionId: null, activeTaskId: null }),
      closeChatSession: () => set({ activeSessionId: null }),
      openWorkspace: (dir) =>
        set((s) => ({
          view: 'workspace',
          workspaceRoot: dir,
          activeTaskId: null,
          activeSessionId: null,
          // 打开文件夹 = 登记一个"打开过的项目"（去重入栈，持久保留）
          openedDirs: bumpOpenedDirs(s.openedDirs, dir),
          // 打开文件夹 → 进工作区自动加载该项目最新一条聊天记录
          autoOpenLatest: true
        })),
      openWorkspaceNewChat: (dir) =>
        set((s) => ({
          view: 'workspace',
          workspaceRoot: dir,
          activeTaskId: null,
          activeSessionId: null,
          openedDirs: bumpOpenedDirs(s.openedDirs, dir),
          // 「新建对话」= 明确要空会话引导，禁止自动加载旧会话
          autoOpenLatest: false
        })),
      setAutoOpenLatest: (v) => set({ autoOpenLatest: v }),
      startNewChat: () =>
        set({ activeSessionId: null, activeTaskId: null, autoOpenLatest: false }),
      setProjects: (list) => set({ projects: list }),
      focusProject: (dir) =>
        set((s) => ({
          activeProject: dir,
          workspaceRoot: dir,
          activeTaskId: null,
          activeSessionId: null,
          // 点击项目行同样登记（该目录曾打开/选中过，重启后仍在列表）
          openedDirs: bumpOpenedDirs(s.openedDirs, dir),
          // 选中项目 = 想接着上次聊 → 允许自动加载最新会话
          autoOpenLatest: true
        })),
      rememberProjectDir: (dir) =>
        set((s) => ({ openedDirs: bumpOpenedDirs(s.openedDirs, dir) })),
      continueTask: (taskId) => set({ view: 'workspace', activeTaskId: taskId, activeSessionId: null }),
      setKernelStatus: (s) => set({ kernelStatus: s }),
      setConversations: (list) => set({ conversations: list }),
      setChatSessions: (list) => set({ chatSessions: list }),
      applyHomeSnapshot: (sessions, convs) =>
        set((s) => {
          // 把快照里出现的所有目录并入 openedDirs（对话 cwd / 任务 project_dir / 当前工作区）
          let dirs = s.openedDirs
          for (const c of convs) {
            if (c.project_dir) dirs = bumpOpenedDirs(dirs, c.project_dir)
          }
          for (const x of sessions) {
            if (x.cwd) dirs = bumpOpenedDirs(dirs, x.cwd)
          }
          if (s.workspaceRoot) dirs = bumpOpenedDirs(dirs, s.workspaceRoot)
          return { chatSessions: sessions, conversations: convs, openedDirs: dirs }
        }),
      setLayout: (l) => set({ layout: l }),
      setTreeWidth: (w) => set({ treeWidth: Math.max(160, Math.round(w)) }),
      setChatWidth: (w) => set({ chatWidth: Math.max(220, Math.round(w)) }),
      setLang: (l) => set({ lang: l }),
      setSendMode: (m) => set({ sendMode: m })
    }),
    {
      name: 'lcode-ui-settings',
      // activeSessionId 持久化：重启后重进「工作区」回到上次会话（配合 ChatPane 草稿回填）
      // openedDirs 持久化：首页项目列表底座——打开过的文件夹重启/切项目后不消失
      // chatSessions/conversations 也随写持久化：重启后首页先渲染旧列表，待轮询刷新补全，不闪空
      partialize: (s) => ({
        layout: s.layout,
        treeWidth: s.treeWidth,
        chatWidth: s.chatWidth,
        lang: s.lang,
        sendMode: s.sendMode,
        workspaceRoot: s.workspaceRoot,
        activeSessionId: s.activeSessionId,
        activeProject: s.activeProject,
        openedDirs: s.openedDirs,
        chatSessions: s.chatSessions,
        conversations: s.conversations
      })
    }
  )
)
