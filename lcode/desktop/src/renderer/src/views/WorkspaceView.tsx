/**
 * 工作区视图（三栏，类 Cursor "Open Folder"）：
 *
 *   [文件夹文件树] [中间内容窗] [Agent 聊天框]
 * 文件树根 = 当前工作目录（自定义工作区或内核默认 outputs）；
 * Agent 聊天在无任务时显示需求输入，提交后工程生成在工作目录下。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { FileTreePane } from '../components/FileTreePane'
import { ContentView, type OpenItem } from '../components/ContentView'
import { ChatPane } from '../components/ChatPane'
import { ThreePaneLayout } from '../components/ThreePaneLayout'
import type { ChatSessionItem, FileContent } from '../../../shared/types'

/** Windows 路径归一化（大小写/分隔符不敏感；会话 cwd 与工作区根比较） */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    } catch {
      return p
    }
  }
  return norm(a) === norm(b)
}

export function WorkspaceView(): JSX.Element {
  const {
    workspaceRoot,
    activeSessionId,
    chatSessions,
    setChatSessions,
    focusChatSession,
    autoOpenLatest,
    setAutoOpenLatest
  } = useAppStore()
  const [openItem, setOpenItem] = useState<OpenItem | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [fileErr, setFileErr] = useState('')
  const [filesVersion, setFilesVersion] = useState(0)
  // 已自动加载过最新会话的根目录（本次运行内）：避免用户点「新建对话」后又被自动抢回旧会话
  const autoOpenedRef = useRef('')
  // 中间窗打开的文件路径（工作区内容变化时自动刷新用）
  const openFilePathRef = useRef<string | null>(null)
  openFilePathRef.current = openItem?.kind === 'file' ? openItem.path : null

  /**
   * 打开文件夹/选中项目后自动加载该项目的「最新一条聊天记录」（2026-09 用户拍板）：
   * 该目录在项目列表里已有对话 → 直接打开最近更新的那条；输入框内容由 ChatPane
   * 的按会话草稿（lcode-chat-draft:<工程>:<会话>）自动回填，无需再手点。
   * 走「新建对话」（autoOpenLatest=false）或该项目确实没有对话时，保持空会话引导。
   *
   * 关键：**「文件→打开文件夹」会重启内核**（--outputs 生效，冷启动 30~60s），
   * 期间 `getChatSessions` 必失败——所以这里必须重试，不能一次失败就放弃
   * （旧实现一次失败即 return，导致打开已有对话的文件夹看不到最新会话）。
   * 取列表优先用缓存（立刻响应），再用内核权威列表校正/判定“确实没有对话”。
   */
  useEffect(() => {
    const root = (workspaceRoot ?? '').trim()
    if (root === '') return
    if (activeSessionId) {
      autoOpenedRef.current = root // 已有打开中的会话（点胶囊/重启恢复）→ 不再抢
      return
    }
    if (!autoOpenLatest) {
      autoOpenedRef.current = root // 明确要新建对话 → 保持空会话引导
      return
    }
    if (autoOpenedRef.current === root) return // 本次已自动加载过

    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 40 // 1.5s × 40 ≈ 60s，覆盖内核冷启动窗口
    const RETRY_MS = 1500

    /** 从给定列表里挑该项目最近的一条可见会话并打开；没有则返回 false */
    const pick = (list: ChatSessionItem[]): boolean => {
      const latest = list
        .filter((s) => (s.msg_count ?? 0) > 0 || s.status === 'running')
        .filter((s) => sameDir(s.cwd, root))
        .sort((a, b) => (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0))[0]
      if (!latest) return false
      autoOpenedRef.current = root
      setAutoOpenLatest(false)
      focusChatSession(latest.session_id)
      return true
    }

    const finishWithoutMatch = (): void => {
      autoOpenedRef.current = root
      setAutoOpenLatest(false)
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return
      const r = await window.lcode.getChatSessions().catch(() => null)
      if (cancelled) return
      if (r) {
        // 内核权威列表：有则打开最新，确实没有就定为空会话引导（不再重试）
        setChatSessions(r.sessions)
        if (!pick(r.sessions)) finishWithoutMatch()
        return
      }
      // 内核未就绪（打开文件夹后的重启窗口）：先用缓存让用户马上看到内容
      if (pick(useAppStore.getState().chatSessions)) return
      attempts += 1
      if (attempts < MAX_ATTEMPTS) window.setTimeout(() => void tick(), RETRY_MS)
      else finishWithoutMatch()
    }

    void tick()
    return () => {
      cancelled = true
    }
    // 依赖刻意不含 chatSessions 数组（每次轮询都会换引用）：用 getState 读最新值，避免反复重启本效应
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, activeSessionId, autoOpenLatest, setChatSessions, focusChatSession, setAutoOpenLatest])

  // 工作区内容变化（主进程 fs.watch）→ 自动刷新中间窗已打开文件（Agent 改文件时界面同步）
  useEffect(() => {
    return window.lcode.onWorkspaceChanged(() => setFilesVersion((v) => v + 1))
  }, [])

  // 切换文件夹 → 中间窗里打开的文件/产物属于上一个工程，必须关闭。
  // （旧行为：残留旧文件并在新工程根下读它 → 路径越界/不存在，显示“无法读取内容”——2026-09 实测）
  useEffect(() => {
    setOpenItem(null)
    setFile(null)
    setFileErr('')
  }, [workspaceRoot])

  const openFile = useCallback(async (path: string, name: string) => {
    setOpenItem({ kind: 'file', path, name })
    setFileErr('')
    setFile(null)
    try {
      const c = await window.lcode.readWorkspaceFile(path)
      if (!c) {
        setFileErr('文件读取失败（文件已被删除或无法读取）')
        return
      }
      setFile(c)
    } catch (e) {
      setFileErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const openArtifact = useCallback((path: string, name: string, sizeKb?: number) => {
    setOpenItem({ kind: 'artifact', path, name, size_kb: sizeKb })
    setFile(null)
    setFileErr('')
  }, [])

  // 内容变化后重读已打开文件（Agent 生成/修改文件时中间窗内容自动同步）
  useEffect(() => {
    const p = openFilePathRef.current
    if (p === null || filesVersion === 0) return
    void (async () => {
      try {
        const c = await window.lcode.readWorkspaceFile(p)
        if (c) {
          setFile(c)
          setFileErr('')
        } else {
          setFileErr('文件读取失败（文件已被删除或无法读取）')
        }
      } catch {
        /* 写入瞬间读取失败：等下一次变化事件 */
      }
    })()
  }, [filesVersion])

  const contentViewShell = (
    <div className="h-full min-w-0">
      <ContentView item={openItem} file={file} error={fileErr} onClose={() => setOpenItem(null)} />
    </div>
  )

  return (
    <ThreePaneLayout
      tree={
        <div className="h-full">
          <FileTreePane initialDir={''} onOpenFile={openFile} />
        </div>
      }
      middle={contentViewShell}
      chat={
        <div className="h-full">
          {/* 对话模式：activeSessionId 打开已有对话；否则新会话（工作区模式首屏引导） */}
          <ChatPane
            workspaceMode
            initialSessionId={activeSessionId ?? undefined}
            onOpenArtifact={openArtifact}
          />
        </div>
      }
    />
  )
}
