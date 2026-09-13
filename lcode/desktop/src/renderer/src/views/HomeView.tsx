/**
 * 首页（opencode 主页风格两栏）：左栏 = 打开过的项目，右栏 = 选中项目的聊天记录
 *
 * 布局（模仿 opencode 主页）：
 *   [左栏 w-72]  项目列表，最多 10 条可见、超出滚轮滚动
 *               项目底座 = 持久化 openedDirs（打开过的工程目录历史，重启/切项目不消失），
 *               再叠加内核轮询到的 对话会话 cwd / 流水线任务 project_dir / 当前工作区。
 *   [右栏 flex-1] 选中项目的对话会话胶囊（最多 10 条可见、超出滚轮滚动）
 *                点胶囊 → 以该会话打开并跳转「工作区」；右键 → 删除（重命名暂缓）
 *
 * 防闪设计（2026-09 实测）：
 * - chatSessions 存全局 store（跨视图切换/重启保留），不再组件内 useState——
 *   从「工作区/设置」切回首页不会先清空列表再等 5s 轮询，历史项目不再闪没。
 * - 无聊天内容的文件夹靠 openedDirs 保留：点别的项目（切换工作区）后仍在列表。
 * - 内核重启/未就绪时 refresh 提前返回但不清旧数据（快照只成功才覆盖）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { Badge, Button } from '../components/ui'
import { useT } from '../i18n'
import { useKbAvailable } from '../useKbStatus'
import type { ChatSessionItem, WorkspaceItem } from '../../../shared/types'

/** 会话胶囊默认标题显示上限（未重命名时取会话标题/首条输入，超出加省略号） */
const LABEL_MAX = 50

/** 列表可见行数上限（超出 → 容器滚轮滚动） */
const MAX_ROWS = 10

function timeStr(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

/** Windows 路径归一化（大小写/分隔符不敏感；项目目录归属比较用） */
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

/** 目录 basename（无分隔符时原样返回） */
function baseName(p: string): string {
  const s = (p ?? '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

/** 标题截断：默认 = 会话标题（内核以首条用户输入自动生成），最多 LABEL_MAX 字 + 省略号 */
function clipLabel(s: string): string {
  const t = (s ?? '').trim()
  if (t === '') return t
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX)}…` : t
}

interface CtxMenu {
  x: number
  y: number
  sessionId: string
}

export function HomeView(): JSX.Element {
  const {
    activeProject,
    focusProject,
    openChatSession,
    openWorkspaceNewChat,
    kernelStatus,
    conversations,
    chatSessions,
    openedDirs,
    applyHomeSnapshot,
    workspaceRoot
  } = useAppStore()
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const t = useT()
  /** 手册检索能力（私有知识库包是否接管）：false = 通用模式，界面置灰 */
  const kbAvailable = useKbAvailable()

  /** 空壳/损坏会话不展示（同 ChatPane deadEmpty 口径：0 消息且非运行中） */
  const visibleChatSessions = useMemo(
    () => chatSessions.filter((s) => (s.msg_count ?? 0) > 0 || s.status === 'running'),
    [chatSessions]
  )

  /**
   * 项目列表（opencode 主页左栏）：
   * 底座 = openedDirs（持久化打开历史），叠加 对话会话 cwd / 流水线任务 project_dir / 当前工作区。
   * 排序：有会话/任务的按最新活动降序；仅打开过、无内容的目录按最近打开顺序排在后面（但始终保留）。
   */
  const projects = useMemo<WorkspaceItem[]>(() => {
    const map = new Map<string, WorkspaceItem>()
    const keyOf = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const ensure = (dir: string, at = ''): WorkspaceItem => {
      const key = keyOf(dir)
      let item = map.get(key)
      if (!item) {
        item = { dir, name: baseName(dir) || dir, updated_at: '', chat_count: 0 }
        map.set(key, item)
      }
      if (at && at > item.updated_at) item.updated_at = at
      return item
    }
    // ① 持久底座：打开过的目录（含无聊天内容的文件夹，最新打开在前）
    for (const dir of openedDirs) {
      if ((dir ?? '').trim() === '') continue
      ensure(dir)
    }
    // ② 对话会话 cwd（统计可见会话数 + 最近活动）
    for (const s of chatSessions) {
      const cwd = (s.cwd ?? '').trim()
      if (cwd === '') continue
      const item = ensure(cwd, s.updated_at)
      if ((s.msg_count ?? 0) > 0 || s.status === 'running') item.chat_count += 1
    }
    // ③ 流水线任务 project_dir
    for (const c of conversations) {
      if ((c.project_dir ?? '').trim() === '') continue
      ensure(c.project_dir, c.updated_at)
    }
    // ④ 当前工作区（即使还没有会话也保留为项目）
    const ws = (workspaceRoot ?? '').trim()
    if (ws !== '') ensure(ws)

    const openedIdx = new Map(openedDirs.map((d, i) => [keyOf(d), i]))
    return Array.from(map.values()).sort((a, b) => {
      // 有内容的按最近活动降序；两者都空按打开先后（新开的在前）
      if (a.updated_at && b.updated_at) {
        if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1
      } else if (a.updated_at) {
        return -1
      } else if (b.updated_at) {
        return 1
      }
      const ia = openedIdx.get(keyOf(a.dir)) ?? 9999
      const ib = openedIdx.get(keyOf(b.dir)) ?? 9999
      return ia - ib
    })
  }, [openedDirs, chatSessions, conversations, workspaceRoot])

  const activeDir = projects.find((p) => sameDir(p.dir, activeProject ?? ''))?.dir ?? null

  /** 选中项目的对话会话（仅对话会话；按 updated_at 降序） */
  const projectChats = useMemo(() => {
    if (!activeDir) return []
    return visibleChatSessions
      .filter((s) => sameDir(s.cwd, activeDir))
      .sort((a, b) => (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0))
  }, [activeDir, visibleChatSessions])

  const refresh = useCallback(async () => {
    // 内核未就绪时跳过刷新，但不清旧数据（快照只成功才覆盖 → 首页不闪空）
    if (kernelStatus && kernelStatus.status !== 'running') return
    try {
      const [convRes, chatRes] = await Promise.all([
        window.lcode.getConversations(),
        window.lcode.getChatSessions()
      ])
      if (convRes && chatRes) {
        applyHomeSnapshot(chatRes.sessions, convRes.conversations)
      }
    } catch {
      /* 内核未就绪时静默 */
    }
  }, [kernelStatus, applyHomeSnapshot])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  // 点击外部关闭右键菜单
  useEffect(() => {
    function onDocClick(): void {
      setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // 进入首页：无选中项目或选中失效时，优先选当前工作区，否则最近活动项目
  // （openedDirs 持久底座 → 即使切到别的项目，旧文件夹仍在列表可再选）
  useEffect(() => {
    if (projects.length === 0) return
    const stillValid = projects.some((p) => sameDir(p.dir, activeProject ?? ''))
    if (activeProject && stillValid) return
    const ws = (workspaceRoot ?? '').trim()
    const target = ws !== '' && projects.some((p) => sameDir(p.dir, ws)) ? ws : projects[0].dir
    focusProject(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.map((p) => p.dir).join('|'), workspaceRoot])

  /** 点胶囊：以该会话打开 → 跳转工作区视图（先绑定项目目录，ChatPane 按 cwd 校验） */
  function openCapsule(session: ChatSessionItem): void {
    if (activeDir) focusProject(activeDir)
    openChatSession(session.session_id)
  }

  /** 新建对话：进入工作区视图空会话引导（不自动加载旧会话），cwd 绑定当前项目目录 */
  function newChatInProject(): void {
    if (!activeDir) return
    openWorkspaceNewChat(activeDir)
  }

  /** 打开文件夹并登记为新项目（留在首页，不跳工作区） */
  async function openFolderAsProject(): Promise<void> {
    const dir = await window.lcode.pickDirectory()
    if (!dir) return
    focusProject(dir)
    refresh()
  }

  async function doDelete(sessionId: string): Promise<void> {
    setConfirmDel(null)
    setCtxMenu(null)
    setErr('')
    try {
      const res = await window.lcode.deleteChatSessions([sessionId])
      if (res.deleted === 0) {
        setErr(t('chatDelSkip') || '无法删除（会话可能正在运行）')
      }
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── 左栏：项目列表（最多 10 条可见，超出滚动） ── */}
      <div className="w-72 shrink-0 border-r bg-card">
        <div className="flex h-full min-w-0 flex-col">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[11px] font-semibold text-muted-foreground">
              {t('homeProjectTitle')}（{projects.length}）
            </span>
            <div className="flex items-center gap-1">
              {/* 手册检索能力标：私有知识库接管 = 可用；通用模式（stub）= 置灰 */}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  kbAvailable
                    ? 'bg-emerald-500/10 text-emerald-600'
                    : 'cursor-default bg-muted text-muted-foreground/50'
                }`}
                title={kbAvailable ? t('kbPrivateHint') : t('kbStubHint')}
              >
                🔍 {t('kbChip')}
                {kbAvailable ? '' : `（${t('kbRetrievalOff')}）`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void openFolderAsProject()} title={t('menuOpenFolderAsWorkspace')}>
                📂
              </Button>
            </div>
          </div>

          <div className="overflow-y-auto px-2 pb-2" style={{ maxHeight: MAX_ROWS * 50 }}>
            {projects.length === 0 ? (
              <div className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {t('homeProjectEmpty')}
              </div>
            ) : (
              projects.map((p) => {
                const active = !!activeDir && sameDir(p.dir, activeDir)
                return (
                  <button
                    key={p.dir}
                    className={`mb-1 flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-transparent text-foreground hover:bg-accent'
                    }`}
                    onClick={() => focusProject(p.dir)}
                  >
                    <span className="shrink-0 text-base leading-none">📁</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={p.dir}>
                        {p.name || p.dir}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground" title={p.dir}>
                        {p.dir}
                      </span>
                    </span>
                    {p.chat_count > 0 ? (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        {p.chat_count}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* ── 右栏：选中项目的聊天记录（胶囊，最多 10 条可见，超出滚动） ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeDir ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold" title={activeDir}>
                  💬 {t('homeChatRecords')}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground" title={activeDir}>
                  {activeDir}
                </div>
              </div>
              <Button size="sm" onClick={newChatInProject}>
                ✨ {t('homeNewChat')}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" style={{ maxHeight: MAX_ROWS * 56 }}>
              {projectChats.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {t('homeProjectNoChats')}
                  <div className="mt-2">
                    <Button size="sm" variant="outline" onClick={newChatInProject}>
                      ✨ {t('homeNewChat')}
                    </Button>
                  </div>
                </div>
              ) : (
                projectChats.map((s) => (
                  <div
                    key={s.session_id}
                    className="mb-1.5"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: s.session_id })
                    }}
                  >
                    <button
                      className="flex w-full items-center gap-2 rounded-full border border-input bg-background px-3 py-2 text-left shadow-sm transition-colors hover:bg-accent"
                      onClick={() => openCapsule(s)}
                      title={s.title || s.session_id}
                    >
                      <span className="w-1.5 shrink-0 self-stretch rounded-full bg-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {clipLabel(s.title || t('homeChatNoTitle'))}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {timeStr(s.updated_at)} · {s.msg_count ?? 0} {t('homeChatMsgs')}
                        </span>
                      </span>
                      {s.status === 'running' ? (
                        <Badge color="blue">{t('homeRunning')}</Badge>
                      ) : null}
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="px-8 text-center text-sm text-muted-foreground">
              <div className="text-3xl">📁</div>
              <p className="mt-2">{t('homeSelectProject')}</p>
              <p className="mt-1 text-xs text-muted-foreground/80">{t('homeSelectProjectHint')}</p>
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单：删除胶囊（重命名暂缓——用户明确先不做） */}
      {ctxMenu ? (
        <div
          className="fixed z-40 min-w-36 rounded-md border bg-background p-1 shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full rounded px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => setConfirmDel(ctxMenu.sessionId)}
          >
            🗑️ {t('chatDelConfirm')}
          </button>
        </div>
      ) : null}

      {/* 删除确认 */}
      {confirmDel ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-80 rounded-lg border bg-background p-4 shadow-xl">
            <h3 className="text-base font-semibold">{t('homeDelTitle')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('homeDelMsg')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDel(null)}>
                {t('cancel')}
              </Button>
              <Button variant="destructive" onClick={() => void doDelete(confirmDel)}>
                {t('chatDelConfirm')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {err ? (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border bg-background p-2 text-xs text-red-600 shadow-lg">
          {err}
        </div>
      ) : null}
    </div>
  )
}
