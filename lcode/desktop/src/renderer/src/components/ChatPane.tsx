/**
 * Agent 聊天框（对话模式，阶段2 W3 → W1 block 渲染）
 *
 * 形态：自由对话 / 按命令执行（类 DeepSeek Harness）：
 * - 用户消息 → 右气泡；Agent 回复 → 左对齐「助手回合」（text 块 + 工具卡片组三态）
 * - 消息区渲染 = 渲染层 block 组装（chatModel.assembleChat，事件/消息 → 展示模型，D19）
 * - 运行中：2s 轮询 + onKernelEvent 实时事件推送；文字流式在 assistant/chunk 桥接前
 *   退化为「回合级出现 + 光标占位」，实时工具卡由 __toolcalls__/tool 消息对还原
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import type { ChatMessage, ChatModeInfo, ChatSessionDetail, KernelEvent, PendingInteraction, QueuedChatItem, ReasoningEffort } from '../../../shared/types'
import { assembleChat, type ChatSection } from '../chatModel'
import { TurnBlocks } from './BlockViews'
import { Badge, Button } from './ui'
import { useT } from '../i18n'

/** 目录路径归一化比较（Windows 分隔符/大小写不敏感；用于会话 cwd 与工作区根绑定校验） */
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

interface Props {
  /** 打开已有对话会话 */
  initialSessionId?: string
  /** 工作区模式：无会话时先显示引导输入，提交后新建会话 */
  workspaceMode?: boolean
  onOpenArtifact: (path: string, name: string, sizeKb?: number) => void
}

/**
 * 结束后的事件时间线裁剪：已由消息还原成 block 的（tool/*、assistant/message、step/start、turn/start）
 * 不再重复铺行，只保留「系统通知」类（WARN/ERROR、goal/git/flash/agent/error、turn/end）供回看。
 */
const NOTICE_TYPES = new Set([
  'goal/change',
  'agent/error',
  'agent/status',
  'turn/end',
  'flash/requested',
  'flash/start',
  'flash/end',
  'flash/cancelled',
  'git/checkpoint',
  'git/rollback',
])
const CARD_TYPES = new Set([
  'tool/call',
  'tool/result',
  'assistant/message',
  'assistant/chunk',
  'step/start',
  'turn/start',
  'user/message',
])
function noticeEvents(events: KernelEvent[]): KernelEvent[] {
  return events.filter((ev) => {
    if (ev.level === 'WARN' || ev.level === 'ERROR') return true
    const t = ev.event_type ?? ''
    if (t === '') return false // 旧事件无字典类型 → 只按 WARN/ERROR 保留
    if (CARD_TYPES.has(t)) return false
    if (NOTICE_TYPES.has(t)) return true
    return false
  })
}

function StreamCaret(): JSX.Element {
  return (
    <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-sm bg-sky-500 align-middle" />
  )
}

/** 上下文占用圆环（参考 DSH ContextMeter：composer 输入条尾部的一枚占用圆环，
 *  14px viewBox / 2px 圆头端帽 / 自 12 点起顺时针）。
 *  LCode 语义保留：level 驱动 fill 色（ok 绿 / warn 黄 / danger 红）+ 百分比文本 + 将满红色提示；
 *  原本标题行的线性横条移除后迁入此处（位置：输入条底部行、发送/停止键左侧）。 */
function ContextMeter({
  context,
  warnText,
  title,
}: {
  context: NonNullable<ChatSessionDetail['context']>
  warnText: string | null
  title: string
}): JSX.Element {
  const RADIUS = 6
  const C = 2 * Math.PI * RADIUS
  const pct = Math.min(100, Math.max(0, context.ratio * 100))
  const level = context.level
  const fillCls = level === 'danger' ? 'stroke-red-500' : level === 'warn' ? 'stroke-yellow-500' : 'stroke-green-500'
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" title={title}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="shrink-0">
        <circle cx="8" cy="8" r={RADIUS} fill="none" className="stroke-muted" strokeWidth="2" />
        {pct > 0 ? (
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            className={fillCls}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(C * pct) / 100} ${C}`}
            transform="rotate(-90 8 8)"
          />
        ) : null}
      </svg>
      <span
        className={`text-[10px] tabular-nums ${
          level === 'danger'
            ? 'font-medium text-red-600'
            : level === 'warn'
              ? 'text-yellow-600'
              : 'text-muted-foreground'
        }`}
      >
        {pct.toFixed(0)}%
      </span>
      {warnText ? <span className="text-[10px] font-medium text-red-500">{warnText}</span> : null}
    </span>
  )
}

/**
 * W1 打字机尾巴（纯推导、幂等）：
 * - 取「最近一次 assistant/message（定型）之后」的 assistant/chunk 增量拼接 → 进行中回复的逐段文本；
 * - 若没有任何进行中增量、但最后一条定型文本尚未被消息区 text 块覆盖（2s 轮询未到），
 *   用该定型的完整事件 message 续显，避免「assistant/message 已落、块未刷」的空白窗口。
 */
function deriveStreamTail(events: KernelEvent[], sections: ChatSection[], running: boolean): string {
  if (!running) return ''
  const commits = events.filter((e) => e.event_type === 'assistant/message')
  let base = 0
  let lastCommit: KernelEvent | null = null
  for (const c of commits) {
    if (c.seq > base) {
      base = c.seq
      lastCommit = c
    }
  }
  const inFlight = events
    .filter((e) => e.event_type === 'assistant/chunk' && e.seq > base && typeof e.payload?.delta === 'string')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => String(e.payload!.delta))
    .join('')
  if (inFlight !== '') return inFlight
  // 定型已落但块未刷：查最后助手回合的最后一个 text 块是否已含该文本
  if (lastCommit?.message) {
    const target = lastCommit.message.trim()
    if (target === '') return ''
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i]
      if (s.role !== 'assistant') continue
      for (let j = s.turn.blocks.length - 1; j >= 0; j--) {
        const b = s.turn.blocks[j]
        if (b.kind === 'text') {
          return b.text.trim().endsWith(target) ? '' : lastCommit.message
        }
      }
      break // 只检查最近一个助手回合
    }
    return lastCommit.message
  }
  return ''
}

/** 运行中 live 事件行：已随消息成卡的 tool/call|result 事件不再重复铺行（卡为准） */
function LiveEventRows({
  events,
  sections,
  tr,
}: {
  events: KernelEvent[]
  sections: ChatSection[]
  tr: ReturnType<typeof useT>
}): JSX.Element {
  const doneTools = useMemo(() => {
    const names = new Set<string>()
    for (const s of sections) {
      if (s.role !== 'assistant') continue
      for (const b of s.turn.blocks) {
        if (b.kind !== 'tools') continue
        for (const t of b.tools) if (t.state !== 'running') names.add(t.name)
      }
    }
    return names
  }, [sections])
  const rows = events.filter(
    (ev) => {
      // assistant/* 由 text 块 + 打字机尾巴呈现；这里只保留工具/系统过程行
      if (ev.event_type === 'assistant/chunk' || ev.event_type === 'assistant/message') return false
      if (ev.event_type === 'tool/call' || ev.event_type === 'tool/result') {
        // 已闭合的工具不重复铺行；未成卡（进行中）的 tool/call 仍实时显示
        return !doneTools.has(ev.node ?? '')
      }
      return true
    }
  )
  return (
    <div className="space-y-1 border-t border-dashed pt-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        {tr('chatWorking')}
      </div>
      {rows.slice(-12).map((ev) => {
        const isTool = ev.event_type === 'tool/call' || ev.event_type === 'tool/result'
        return (
          <div
            key={ev.seq}
            className={`overflow-hidden font-mono text-[10px] leading-4 ${
              isTool ? 'text-sky-600/80' : ev.level === 'WARN' || ev.level === 'ERROR' ? 'text-red-500' : 'text-muted-foreground'
            }`}
          >
            {ev.node ? <span className="text-muted-foreground/70">[{ev.node}] </span> : null}
            {ev.message.length > 300 ? ev.message.slice(0, 300) + '…' : ev.message}
          </div>
        )
      })}
    </div>
  )
}

/** 复制文本到剪贴板（Electron/file:// 下 navigator.clipboard 可能受限，回退 execCommand） */
function writeClipboardText(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fallback = (): void => {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        resolve(ok)
      } catch {
        resolve(false)
      }
    }
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(() => resolve(true)).catch(fallback)
      } else {
        fallback()
      }
    } catch {
      fallback()
    }
  })
}

/**
 * 助手回复下的操作条（阶段4 W4 · 参考 DSH MessageIconActions）：
 * 复制（复制本条回复文字，成功后短暂显示 ✓）+ 在新对话中分支（复制锚点前的上下文开新会话）。
 */
function TurnActions({ text, branchable, onBranch }: {
  text: string
  branchable: boolean
  onBranch: () => void
}): JSX.Element {
  const tr = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = (): void => {
    void writeClipboardText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    })
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const btn =
    'flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
  return (
    <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={btn}
        onClick={copy}
        title={copied ? tr('chatCopied') : tr('chatCopy')}
        aria-label={copied ? tr('chatCopied') : tr('chatCopy')}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.4 6.4 11.3 12.5 4.7" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="5.4" y="5.4" width="8" height="8" rx="1.5" />
            <path d="M10.6 3H4.8A1.8 1.8 0 0 0 3 4.8v5.8" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={btn}
        onClick={onBranch}
        disabled={!branchable}
        title={tr('chatBranch')}
        aria-label={tr('chatBranch')}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4" cy="3.5" r="1.7" />
          <circle cx="4" cy="12.5" r="1.7" />
          <path d="M4 5.2v5.6" />
          <circle cx="12" cy="8.6" r="1.7" />
          <path d="M5.7 5.2c.6 2.1 1.6 3.4 3.6 3.4h1" />
        </svg>
      </button>
    </div>
  )
}

export function ChatPane({ initialSessionId, workspaceMode = false, onOpenArtifact }: Props): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [context, setContext] = useState<NonNullable<ChatSessionDetail['context']>>()
  const [confirmWaiting, setConfirmWaiting] = useState(false)
  const [fullAccess, setFullAccess] = useState(true)
  const [running, setRunning] = useState(false)
  // 阶段3 Phase2：待烧录请求（防误烧——会话确认后由用户显式确认端口执行）
  const [flashPending, setFlashPending] = useState<NonNullable<ChatSessionDetail['pending_flash']> | null>(null)
  const [flashPort, setFlashPort] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * 对话承载方式：planner = 规划器全功能；slim = 精简模式兜底（内核 Agent 承载）。
   * 打包版目前没有随包规划器 → 装完就能对话靠这条兜底；界面必须如实提示能力差异，
   * 否则用户会以为"功能坏了"（plan-mode 点了没反应）。
   */
  const [chatMode, setChatMode] = useState<ChatModeInfo | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 输入框自适应高度（2026-09 用户要求）：随内容长高，**上限 = 聊天面板总高度的一半**，
  // 再多文字就在输入框内部滚动（不做无限增高）。
  const rootRef = useRef<HTMLDivElement | null>(null)
  const heroTaRef = useRef<HTMLTextAreaElement | null>(null)
  const mainTaRef = useRef<HTMLTextAreaElement | null>(null)
  const [maxTaH, setMaxTaH] = useState(240)
  const tr = useT()
  const lang = useAppStore((s) => s.lang)
  // 设置页「发送方式」：enter = Enter 直接发送（默认，不显示提示）；ctrlEnter = Ctrl+Enter 发送（显示提示）
  const sendMode = useAppStore((s) => s.sendMode)
  // 阶段4 W4 · 分支成功后跳转到新会话（activeSessionId 变更 → ChatPane 按新会话重载）
  const openChatSession = useAppStore((s) => s.openChatSession)
  const closeChatSession = useAppStore((s) => s.closeChatSession)
  // 首页两栏：新建会话后同步 store 的 activeSessionId（选中高亮联动；不切换视图）
  const focusChatSession = useAppStore((s) => s.focusChatSession)
  // 聊天框标题行「新会话」按钮：清空当前会话 → 空会话引导（当前会话保留在项目里）
  const startNewChat = useAppStore((s) => s.startNewChat)
  // 死会话（不在规划器内）删除确认
  const [staleDel, setStaleDel] = useState(false)
  const [staleBusy, setStaleBusy] = useState(false)
  // 空壳/损坏会话（0 消息且非运行）：打开时弹删除确认，取消则回到新对话引导（不再停在"加载对话…"）
  const [deadEmpty, setDeadEmpty] = useState(false)
  // M3 · plan-mode 意图（true=先规划后执行）与待应答人机交互（approval/questions）
  const [planMode, setPlanMode] = useState(false)
  const [activeInteraction, setActiveInteraction] = useState<PendingInteraction | null>(null)
  // WorkBuddy 式权限控件：状态项弹层开关 + 「允许完全访问」红色风险确认
  const [permOpen, setPermOpen] = useState(false)
  const [permConfirm, setPermConfirm] = useState(false)
  const [riskAcked, setRiskAcked] = useState(false)
  // 推理等级（reasoning effort，参照 DSH effort 档位 off/high/max）+ 弹层开关
  const [effort, setEffort] = useState<ReasoningEffort>('high')
  const [effortOpen, setEffortOpen] = useState(false)
  // + 号命令菜单（DSH Command menu 子集：计划 / 执行权限 / 推理等级）
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false)
  /**
   * 运行中「待发送队列」（DSH QueueDock 同源：planner 侧 DSH agent inbox 投影）。
   * Enter 排队的消息停在服务端 inbox（next-turn），本轮结束后作为自己的一轮执行；
   * Ctrl+Enter（steer）注入当前轮，未消费前显示为 next-step。
   */
  const [queue, setQueue] = useState<QueuedChatItem[]>([])
  // 操作失败可见提示（safeIpc 失败返回 null / IPC 抛错时不再静默）
  const [opErr, setOpErr] = useState('')

  // 工作区根目录（会话 cwd 绑定校验 + 草稿分键）；声明靠前供 refresh 使用
  const workspaceRoot = useAppStore((s) => s.workspaceRoot)
  // 内核状态（启动窗口内消息区给出明确提示；历史会话此刻正在自动重试加载）
  const kernelStatus = useAppStore((s) => s.kernelStatus)

  /** 把操作失败转成可读文案（区分 null=后端未就绪 与 Error 消息） */
  const fail = useCallback((e: unknown, action: string): void => {
    if (e === null || e === undefined) {
      // safeIpc 吞错返回 null：渲染层拿不到具体原因，给通用提示（主进程日志有细节）
      setOpErr(
        lang === 'zh'
          ? `${action}失败：内核或规划器未就绪（请稍候重试；若持续失败请到设置页查看内核状态）`
          : `${action} failed: kernel/planner not ready (retry; check kernel status in Settings)`
      )
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[ChatPane] ${action}失败:`, msg)
    setOpErr(lang === 'zh' ? `${action}失败：${msg}` : `${action} failed: ${msg}`)
  }, [lang])

  // W1 · 渲染层 block 组装：消息 → 用户气泡/助手回合（text + 工具卡片组三态）
  const { sections } = useMemo(() => assembleChat(messages, { running }), [messages, running])

  // 输入框高度上限：面板总高度的一半（面板被拉伸/窗口缩放时同步刷新）
  // hero 空会话态与已有会话态是两棵不同的根节点 → 用 heroShell 作依赖重新挂观察器
  const heroShell = !!(workspaceMode && messages.length === 0 && !sessionId)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = (): void => setMaxTaH(Math.max(120, Math.round(el.clientHeight / 2)))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [heroShell])

  /** 按内容自适应输入框高度：min 96px（h-24）、max = 面板一半，超出由 textarea 内部滚动 */
  const autoGrow = useCallback((): void => {
    for (const el of [heroTaRef.current, mainTaRef.current]) {
      if (!el) continue
      el.style.height = 'auto'
      const next = Math.min(Math.max(el.scrollHeight, 96), maxTaH)
      el.style.height = `${next}px`
    }
  }, [maxTaH])

  useEffect(() => {
    autoGrow()
  }, [input, sessionId, maxTaH, autoGrow])

  /**
   * 拉取会话详情。
   * 返回三态，供调用方区分「该回落」与「该重试」：
   * - 'ok'      = 已加载；
   * - 'missing' = 会话不存在 / 不属于当前工作区 → 回落空会话引导（不重试）；
   * - 'error'   = 请求异常（典型：内核正在重启，冷启动 30~60s）→ **必须重试**。
   * 2026-09 实测 bug：「文件→打开文件夹」会重启内核（--outputs 生效），旧代码把重启窗口的
   * 异常当成 missing 立刻回落空会话 → 打开已有对话的文件夹时看不到最新会话、草稿也回填不了。
   */
  const refresh = useCallback(async (sid: string): Promise<'ok' | 'missing' | 'error'> => {
    try {
      const d = await window.lcode.getChatSession(sid)
      if (!d) return 'missing' // 会话不存在（已被启动清理删除等）→ 由调用方回落空会话
      // 工作区绑定：会话 cwd 与当前工作区根目录不匹配 → 视为他区会话，回落空会话引导
      // （workspaceRoot 为 null = 未打开文件夹/兼容旧数据，不校验）
      if (workspaceRoot && typeof d.cwd === 'string' && d.cwd.trim() !== '' && !sameDir(d.cwd, workspaceRoot)) {
        setSessionId(null)
        closeChatSession()
        return 'missing'
      }
      setSessionId(d.session_id)
      setTitle(d.title)
      setMessages(d.messages)
      setEvents(d.events)
      setContext(d.context)
      setConfirmWaiting(!!d.waiting_confirm)
      setFullAccess(d.full_access !== false)
      setRunning(d.status === 'running')
      const pending = d.pending_flash ?? null
      setFlashPending(pending)
      if (pending) setFlashPort(pending.port ?? '')
      // 空壳/损坏会话：0 条消息且非运行中（无内容可继续）→ 弹「删除无法继续的会话」确认，
      // 避免消息区永远停在「加载对话…」（用户选择删除或取消回到新对话引导）
      const emptyShell = d.messages.length === 0 && d.status !== 'running' && !d.waiting_confirm
      setDeadEmpty(emptyShell)
      if (emptyShell) setStaleDel(true)
      return 'ok'
    } catch {
      /* 内核未就绪/会话刚创建：交给调用方重试 */
      return 'error'
    }
  }, [workspaceRoot])

  // 初始化：打开已有会话（内核重启窗口内自动重试；确定不存在才回落空会话引导）
  useEffect(() => {
    setMessages([])
    setEvents([])
    setRunning(false)
    setDeadEmpty(false)
    setEffort('high') // 切会话重置为默认档位（稍后按 planner 实际值回填）
    if (!initialSessionId) {
      setSessionId(null)
      return
    }
    setSessionId(initialSessionId)
    let cancelled = false
    let attempts = 0
    // 覆盖「打开文件夹 → 内核重启」的引导窗口（冷启动可达 30~60s，杀软扫描/磁盘繁忙更久）：
    // 1.5s × 60 ≈ 90s。主进程已把 404 与「内核不可达」分开（见 main/index.ts kernel:getChatSession），
    // 所以这里的 'error' 就是"内核还没起来"，必须一直重试到它起来。
    const MAX_ATTEMPTS = 60
    const RETRY_MS = 1500
    const tryLoad = async (): Promise<void> => {
      const outcome = await refresh(initialSessionId)
      if (cancelled) return
      if (outcome === 'ok') return
      if (outcome === 'missing') {
        // 会话确实不存在（被启动清理删掉/他区会话）→ 回落空会话引导，并清掉 store 选中
        setSessionId(null)
        closeChatSession()
        return
      }
      attempts += 1
      if (attempts >= MAX_ATTEMPTS) {
        // 重试用尽：回落空会话引导并给可见提示（不再无声无息地停在「加载对话…」）
        setSessionId(null)
        closeChatSession()
        setOpErr(
          lang === 'zh'
            ? '内核长时间未就绪，历史会话暂时打不开；稍后重新打开该会话即可（或先新建对话）'
            : 'The kernel stayed unavailable, so this history session could not be opened; open it again later (or start a new chat)'
        )
        return
      }
      window.setTimeout(() => void tryLoad(), RETRY_MS)
    }
    void tryLoad()
    return () => {
      cancelled = true
    }
  }, [initialSessionId, refresh, closeChatSession, lang])

  /**
   * 对话承载方式：内核/规划器状态变化后重取。
   * 规划器冷启动十几秒，所以每次 planner 状态变化都重取一次（就绪后提示自动消失）。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const m = await window.lcode.chatMode()
      if (alive && m) setChatMode(m)
    })()
    return () => {
      alive = false
    }
  }, [kernelStatus?.status, kernelStatus?.kind])

  // 会话切换后：把 planner 记录的推理等级与 plan-mode 状态回填（仅一次，不走轮询；
  // plan 权威值 = planner agent 状态 —— HomeView /plan 建出的计划会话在此点亮 PlanChip）
  useEffect(() => {
    if (!sessionId) return
    window.lcode.getChatEffort(sessionId).then((v) => {
      if (v === 'off' || v === 'high' || v === 'max') setEffort(v)
    }).catch(() => { /* 规划器未就绪：保持默认 */ })
    window.lcode.getChatPlanState(sessionId).then((st) => {
      setPlanMode(st?.plan_active === true)
    }).catch(() => { /* 保持本地意图 */ })
  }, [sessionId])

  /** 拉取运行中待发送队列（DSH QueueDock 同源；无会话/规划器未就绪时静默为空） */
  const refreshQueue = useCallback(async (sid: string | null): Promise<void> => {
    if (!sid) {
      setQueue([])
      return
    }
    try {
      const r = await window.lcode.getChatQueue(sid)
      setQueue(r?.items ?? [])
    } catch {
      /* 规划器未就绪：保留现有展示 */
    }
  }, [])

  /** 从待发送队列删除一条（DSH QueueDock 删除项） */
  async function removeQueueItem(messageId: string): Promise<void> {
    if (!sessionId) return
    setOpErr('')
    try {
      const r = await window.lcode.removeChatQueueItem(sessionId, messageId)
      if (!r || r.removed === false) {
        setOpErr(lang === 'zh' ? '该待发送消息已不在队列中' : 'That queued message is no longer in the queue')
      }
      await refreshQueue(sessionId)
    } catch (e) {
      fail(e, lang === 'zh' ? '删除待发送消息' : 'Remove queued message')
    }
  }

  // 运行中轮询（2s）；暂停等待确认（waiting_confirm）时也继续轮询，确保弹窗一定出现
  useEffect(() => {
    if (!sessionId || (!running && !confirmWaiting)) return
    const timer = setInterval(() => {
      void refresh(sessionId)
      void refreshQueue(sessionId)
    }, 2000)
    return () => clearInterval(timer)
  }, [sessionId, running, confirmWaiting, refresh, refreshQueue])

  // 切会话/进出运行态：立即取一次队列（运行中显示待发送列表）
  useEffect(() => {
    void refreshQueue(sessionId)
  }, [sessionId, running, refreshQueue])

  // 实时事件流（主进程 poller 推送）
  useEffect(() => {
    const off = window.lcode.onKernelEvent((ev) => {
      if (ev.task_id === sessionId) {
        setEvents((prev) => (prev.some((e) => e.seq === ev.seq) ? prev : [...prev, ev]))
      }
    })
    return off
  }, [sessionId])

  // W1 打字机尾巴（纯推导，幂等）：进行中 assistant/chunk 增量或刚定型待刷文本
  const streamTail = useMemo(() => deriveStreamTail(events, sections, running), [events, sections, running])

  // 自动滚动到底
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, events, running])

  // ── 草稿持久化（WorkBuddy 参考：聊天框未发送内容不随切界面/关窗丢失）──
  // 按「工程(工作区根目录) + 会话」分键保存：hero 空会话草稿存工程级 new 键；
  // 已有会话草稿存会话键；切换界面/重挂载/重启后按当前键回填。
  const draftKey = useMemo(() => {
    const proj = (workspaceRoot ?? '').trim()
    const projPart = proj ? encodeURIComponent(proj) : 'default'
    const convPart = sessionId ? 'session:' + encodeURIComponent(sessionId) : 'new'
    return `lcode-chat-draft:${projPart}:${convPart}`
  }, [workspaceRoot, sessionId])
  // 写回锁：StrictMode dev 双挂载会先跑「读回→写回」两遍 effect，
  // 若写回 effect 在 input 还是 '' 时就执行会把已存草稿删掉——回填完成前禁止写回
  const [draftHydrated, setDraftHydrated] = useState(false)

  // 挂载/切换会话：先锁写回并读回该键草稿，再解锁
  useEffect(() => {
    setDraftHydrated(false)
    let next = ''
    try {
      const raw = window.localStorage.getItem(draftKey)
      if (raw) {
        const v = JSON.parse(raw) as { text?: unknown } | null
        if (v && typeof v.text === 'string') next = v.text
      }
    } catch {
      /* 损坏数据忽略，视为无草稿 */
    }
    setInput(next)
    setDraftHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // 回填完成后每次输入变化即时写回；清空输入即删除该键草稿
  useEffect(() => {
    if (!draftHydrated) return
    try {
      if (input) {
        window.localStorage.setItem(draftKey, JSON.stringify({ text: input, savedAt: Date.now() }))
      } else {
        window.localStorage.removeItem(draftKey)
      }
    } catch {
      /* 存储不可用则忽略（不影响聊天） */
    }
  }, [input, draftKey, draftHydrated])

  /**
   * 发送（照抄 DSH composer 语义）：
   * - 空闲：正常一轮（新建会话时带权限预设 / cwd 绑定）；
   * - 运行中：可继续输入并发送 —— delivery='queue'（Enter）排队到本轮结束后执行，
   *   delivery='steer'（Ctrl+Enter）立即投递给运行中的 Agent（最近 step 边界消费）。
   *   排队消息由服务端 inbox 持有，正文在它真正执行时进入对话（与 DSH 一致），
   *   期间以「待发送」列表展示，可单条删除。
   */
  async function send(delivery?: 'queue' | 'steer'): Promise<void> {
    let text = input.trim()
    if (!text || busy) return
    const queued = running && !!sessionId
    setBusy(true)
    setOpErr('')
    // DSH 原味斜杠命令（/plan 相关行不进对话本体，仅切计划模式意图；正文变体见下）：
    //   /plan         → 开启计划模式（仅本行，无正文）
    //   /plan off     → 退出计划模式（仅本行）
    //   /plan <正文>  → 开启计划模式并把正文作为首条计划请求消息发送（同 DSH /plan <message>）
    let sendPlanMode = planMode
    const planOffLine = /^\/plan\s+off\s*$/i.test(text)
    const planOnlyLine = /^\/plan$/i.test(text)
    const planWithBody = !planOffLine && /^\/plan\s+(.+)$/is.exec(text)
    if (planOffLine || planOnlyLine) {
      setBusy(false)
      setInput('')
      applyPlanMode(!planOffLine) // /plan 开、/plan off 关（会话内即时翻转 planner agent 状态）
      return
    }
    if (planWithBody) {
      applyPlanMode(true)
      sendPlanMode = true
      text = planWithBody[1].trim()
      if (!text) {
        setBusy(false)
        setInput('')
        return
      }
    }
    try {
      // 新建会话时带上权限预设；plan-mode 意图与推理等级随每次发送携带
      // （plan_mode：无会话 = 首条消息进入计划模式；有会话 = 切换本会话模式）
      // 工作区绑定：新建会话 cwd = 当前工作区根目录（未打开文件夹则空 → 主进程回落 outputs）
      const r = await window.lcode.chat(
        text,
        sessionId ?? undefined,
        sessionId ? undefined : fullAccess,
        sendPlanMode,
        effort,
        sessionId ? undefined : (workspaceRoot ?? undefined),
        queued ? (delivery ?? 'queue') : undefined
      )
      if (!r) {
        // 主进程明确返回 null（规划器/内核未就绪路径不发假消息）；发到内核未就绪时给出提示
        fail(null, lang === 'zh' ? '发送' : 'Send')
        return
      }
      const sid = r.session_id
      if (!sid) {
        fail(new Error(lang === 'zh' ? '未返回会话 ID' : 'no session id returned'), lang === 'zh' ? '发送' : 'Send')
        return
      }
      // 走了精简模式（内核 Agent 承载）→ 立刻更新提示条，不等状态事件
      if (r.mode) {
        void window.lcode.chatMode().then((m) => {
          if (m) setChatMode(m)
        })
      }
      if (!sessionId) {
        setSessionId(sid)
        // 首页两栏：新建会话同步 store activeSessionId（选中高亮联动，不切换视图）
        focusChatSession(sid)
        // 乐观追加用户消息，避免等轮询
        setMessages((prev) => [
          ...prev,
          {
            id: -Date.now(),
            session_id: sid,
            role: 'user',
            content: text,
            tool_name: '',
            tool_call_id: '',
            ts: new Date().toISOString()
          }
        ])
      } else if (queued) {
        // 排队/投递：正文要等它真正执行才进对话；先乐观挂一条待发送行（随后由服务端 inbox 校正）
        const placement = (delivery ?? 'queue') === 'steer' ? 'next-step' : 'next-turn'
        setQueue((prev) => [...prev, { id: `local-${Date.now()}`, text, placement }])
        void refreshQueue(sid)
      }
      setRunning(true)
      setInput('')
      void refresh(sid)
    } catch (e) {
      // chat:send 不再吞错：E_PLANNER_NOT_READY / E_KERNEL_UNREACHABLE → 通用未就绪提示；
      // 其它透传 planner 真实 detail（例如 500：…），让用户看到真正失败原因而不是“内核未就绪”
      const raw = e instanceof Error ? e.message : String(e)
      const detail = raw
        .replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^Error:\s*/, '')
        .trim()
      if (detail.startsWith('E_PLANNER_NOT_READY') || detail.startsWith('E_KERNEL_UNREACHABLE')) {
        fail(null, lang === 'zh' ? '发送' : 'Send')
      } else {
        fail(new Error(detail || raw), lang === 'zh' ? '发送' : 'Send')
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    if (!sessionId || busy) return
    setBusy(true)
    setOpErr('')
    try {
      const r = await window.lcode.cancelChat(sessionId)
      if (!r) {
        fail(null, lang === 'zh' ? '停止' : 'Stop')
        return
      }
      // 乐观显示停止中，等轮询拿到内核确认后由事件流覆盖
      setEvents((prev) => [
        ...prev,
        {
          seq: -Date.now(),
          task_id: sessionId,
          ts: new Date().toISOString(),
          level: 'WARN',
          node: 'agent',
          message: '正在停止…'
        }
      ])
    } catch (e) {
      fail(e, lang === 'zh' ? '停止' : 'Stop')
    } finally {
      setBusy(false)
    }
  }

  // 阶段4 W4 · 会话分支（参考 DSH session.fork）：复制锚点消息前的全部上下文开新对话
  const [forking, setForking] = useState(false)
  async function branchAt(msgId: number): Promise<void> {
    if (!sessionId || running || busy || forking) return
    setForking(true)
    setOpErr('')
    try {
      const r = await window.lcode.forkChat(sessionId, msgId)
      if (!r || !r.session_id) {
        setOpErr(
          lang === 'zh'
            ? '分支失败：规划器/内核未就绪，或该会话不在当前规划器内（请先在本轮继续一次该会话后再分支）'
            : 'Fork failed: planner/kernel not ready, or the session is not active in the current planner'
        )
        return
      }
      // 跳到新会话：store activeSessionId 变更 → ChatPane 重载该会话（含复制的前文）
      openChatSession(r.session_id)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      // 主进程按原因抛码：E_PLANNER_NOT_READY / E_KERNEL_UNREACHABLE / E_SESSION_NOT_REGISTERED，
      // 或带 planner 透传的内核 detail（如“会话正在执行中…”“锚点消息不存在…”）
      if (raw.includes('E_SESSION_NOT_REGISTERED') || raw.includes('源会话不在规划器中')) {
        // 死会话：当前规划器未登记，无法继续/分支 → 引导删除
        setStaleDel(true)
        return
      }
      // 剥掉 Electron 的 invoke 包装前缀，取出真正的 detail
      const detail = raw
        .replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^Error:\s*/, '')
        .replace(/^E_[A-Z_]+$/, '')
        .trim()
      const mapped =
        raw.includes('E_PLANNER_NOT_READY')
          ? tr('chatForkErrPlanner')
          : raw.includes('E_KERNEL_UNREACHABLE') || detail.includes('fetch failed')
            ? tr('chatForkErrKernel')
            : detail.includes('正在执行中') || detail.includes('409')
              ? tr('chatForkErrRunning')
              : detail.includes('锚点消息不存在') || detail.includes('at_message_id 无效')
                ? tr('chatForkErrAnchor')
                : detail.includes('会话不存在') || detail.includes('404')
                  ? tr('chatForkErrMissing')
                  : `${tr('chatForkErr')}：${detail}`
      setOpErr(mapped)
    } finally {
      setForking(false)
    }
  }

  /** 死会话删除（确认后不可恢复）：删除当前会话并回到空会话引导 */
  async function confirmDeleteStale(): Promise<void> {
    if (!sessionId || staleBusy) return
    setStaleBusy(true)
    setOpErr('')
    try {
      const r = await window.lcode.deleteChatSessions([sessionId])
      if (!r) {
        fail(null, lang === 'zh' ? '删除会话' : 'Delete session')
        setStaleDel(false)
        return
      }
      setStaleDel(false)
      setDeadEmpty(false)
      closeChatSession()
    } catch (e) {
      fail(e, lang === 'zh' ? '删除会话' : 'Delete session')
      setStaleDel(false)
    } finally {
      setStaleBusy(false)
    }
  }

  /** 空壳/死会话删除确认框关闭（取消）：空壳会话回到新对话引导，不再停留在"加载对话…" */
  function dismissStaleDel(): void {
    setStaleDel(false)
    if (deadEmpty) {
      setDeadEmpty(false)
      closeChatSession() // 空壳无内容可看，取消即返回空会话引导
    }
  }

  /** 每 100 轮暂停确认：继续执行 */
  async function confirmContinue(): Promise<void> {
    if (!sessionId) return
    setConfirmWaiting(false)
    setBusy(true)
    setOpErr('')
    try {
      const r = await window.lcode.chat('继续', sessionId)
      if (!r) {
        fail(null, lang === 'zh' ? '继续' : 'Continue')
        return
      }
      setRunning(true)
      void refresh(sessionId)
    } catch (e) {
      fail(e, lang === 'zh' ? '继续' : 'Continue')
    } finally {
      setBusy(false)
    }
  }

  /** 每 100 轮暂停确认：停止 */
  async function confirmStop(): Promise<void> {
    if (!sessionId) return
    setConfirmWaiting(false)
    setBusy(true)
    setOpErr('')
    try {
      const r = await window.lcode.cancelChat(sessionId)
      if (!r) {
        fail(null, lang === 'zh' ? '停止' : 'Stop')
        return
      }
    } catch (e) {
      fail(e, lang === 'zh' ? '停止' : 'Stop')
    } finally {
      setBusy(false)
    }
  }

  // M3 · 人机交互轮询：会话存在且（运行中或已有交互未答）时，拉取 approval/questions。
  // plan-mode exit_plan_mode 的审批与沙盒升级审批都走这里，桌面以弹窗应答。
  useEffect(() => {
    if (!sessionId) {
      setActiveInteraction(null)
      return
    }
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const { interactions } = await window.lcode.listInteractions(sessionId)
        if (cancelled) return
        // 功能性更新：轮询期不因 activeInteraction 变化重建 interval。
        setActiveInteraction((prev) => {
          if (interactions.length === 0) return null
          if (prev !== null && interactions.some((i) => i.id === prev.id)) return prev
          return interactions[0] ?? null
        })
      } catch (e) {
        if (!cancelled) console.error(e)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1200)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  /** M3 · 应答当前交互（approval outcome / questions answers）。 */
  async function answerCurrent(approve: boolean): Promise<void> {
    if (!sessionId || !activeInteraction) return
    const it = activeInteraction
    setBusy(true)
    try {
      if (it.kind === 'approval') {
        const r = await window.lcode.answerInteraction(it.id, {
          kind: 'approval',
          outcome: approve ? 'allowed-once' : 'rejected',
        })
        if (!r) {
          fail(null, lang === 'zh' ? '应答' : 'Answer')
          return
        }
      } else {
        const first = it.questions[0]
        const approveLabel = first?.intent?.approve ?? first?.options?.[0]?.label ?? 'yes'
        const r = await window.lcode.answerInteraction(it.id, {
          kind: 'questions',
          answers: [{
            id: first?.id ?? 'q',
            selected: approve ? [approveLabel] : [],
          }],
        })
        if (!r) {
          fail(null, lang === 'zh' ? '应答' : 'Answer')
          return
        }
      }
      setActiveInteraction(null)
      // 计划审阅通过（questions + approve）= agent 离开 plan 模式 → 复位本地 PlanChip
      if (it.kind === 'questions' && approve) setPlanMode(false)
      void refresh(sessionId)
    } catch (e) {
      fail(e, lang === 'zh' ? '应答' : 'Answer')
    } finally {
      setBusy(false)
    }
  }

  /** M3 · 按用户点选的选项精确应答 questions（非 approve 选项也原样上报）。 */
  async function answerQuestionsWith(selectedLabels: string[], custom?: string): Promise<void> {
    if (!sessionId || !activeInteraction || activeInteraction.kind !== 'questions') return
    const it = activeInteraction
    const first = it.questions[0]
    setBusy(true)
    try {
      const r = await window.lcode.answerInteraction(it.id, {
        kind: 'questions',
        answers: [{
          id: first?.id ?? 'q',
          selected: selectedLabels,
          ...custom !== undefined ? { custom } : {},
        }],
      })
      if (!r) {
        fail(null, lang === 'zh' ? '应答' : 'Answer')
        return
      }
      setActiveInteraction(null)
      // 选项点选路径：选中 plan-review 的 approve → 复位本地 PlanChip（agent 已离开 plan 模式）
      const approveLabel = first?.intent?.approve
      if (approveLabel && selectedLabels.includes(approveLabel)) setPlanMode(false)
      void refresh(sessionId)
    } catch (e) {
      fail(e, lang === 'zh' ? '应答' : 'Answer')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Plan-mode 切换统一入口（对齐 DSH /plan、/plan off）：本地 PlanChip 意图 + 有会话时
   * 即时翻转 planner agent 状态（空闲 committed；执行中 queued 至下一 pre-step）。
   *
   * Chip 语义对齐 DSH PlanChip 判定 `pending ? !active : active`：目标为 plan mode 时显示。
   * committed（已落账）→ 用权威 plan_active 刷新；queued（执行中等待）→ 目标是本请求的方向，
   * 保持本地 next（开 = 亮、off = 关，用户选择即所见）；其它 noop/cancelled → 后端当前值为准。
   * @param next 目标状态（true=开启先规划后执行；false=退出）
   */
  function applyPlanMode(next: boolean): void {
    setPlanMode(next)
    if (!sessionId) return
    window.lcode.setChatPlanMode(sessionId, next).then((st) => {
      if (!st) return
      // queued：选择已排队待 pre-step 落账 —— 用户意图即 chip 状态（本地 next 已设）。
      if (st.outcome === 'queued') return
      // committed / noop / cancelled：plan_active 已是权威最终态（open-turn 退出在 pending 里算 queued，
      // 不会走到这；committed 空闲会话立即落账）→ 用权威值校正本地。
      setPlanMode(st.plan_active === true)
    }).catch(() => { /* 规划器未就绪：保持本地意图（下一条消息随 chat 携带 plan_mode） */ })
  }

  /** M3 · 切换 plan-mode（先规划后执行；下次发送生效）。 */
  function togglePlanMode(): void {
    const next = !planMode
    applyPlanMode(next)
  }

  /**
   * DSH 原味计划 pill（对齐 ui-plan PlanChip）：仅在 plan-mode 开启时渲染琥珀
   * 「Plan ✕」，点击 = 退出（等价 /plan off）；OFF 态不渲染任何 pill——
   * 开启只走斜杠命令 /plan（send 前拦截，见 send()）或从 + 命令菜单选「计划模式」。
   */
  function planChip(): JSX.Element | null {
    if (!planMode) return null
    // 精简模式：内核对话 Agent 没有 plan-mode 状态机 → 不渲染计划 pill
    if (chatMode?.mode === 'slim') return null
    return (
      <button
        type="button"
        role="switch"
        aria-checked
        disabled={running || busy}
        onClick={() => applyPlanMode(false)}
        title={tr('planModeOnTitle')}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/25 disabled:pointer-events-none disabled:opacity-60"
      >
        Plan
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2.5 2.5 9.5 9.5 M9.5 2.5 2.5 9.5" />
        </svg>
      </button>
    )
  }

  /** 推理等级档位集合（off/high/max，llm-deepseek 支持；参照 DSH ModelSelect Effort 菜单）。 */
  const EFFORT_LEVELS: { v: ReasoningEffort; name: string; desc: string }[] = [
    { v: 'off', name: tr('effortOff'), desc: tr('effortOffDesc') },
    { v: 'high', name: tr('effortHigh'), desc: tr('effortHighDesc') },
    { v: 'max', name: tr('effortMax'), desc: tr('effortMaxDesc') },
  ]
  const effortName = (v: ReasoningEffort): string =>
    EFFORT_LEVELS.find((l) => l.v === v)?.name ?? v

  /** 推理等级即时切换：有会话立即持久（/api/planner/effort），无会话仅本地随发送携带。 */
  async function changeEffort(v: ReasoningEffort): Promise<void> {
    setEffortOpen(false)
    setEffort(v)
    if (!sessionId) return
    try {
      const r = await window.lcode.setChatEffort(sessionId, v)
      if (!r) fail(null, lang === 'zh' ? '切换推理等级' : 'Switch reasoning effort')
    } catch (e) {
      fail(e, lang === 'zh' ? '切换推理等级' : 'Switch reasoning effort')
    }
  }

  /**
   * 推理等级选择器（参照 DSH model seat 的 Effort 菜单）：小 pill 显示当前档位，
   * 点击弹三档菜单（off/high/max）。放输入条底部行左侧（+ 号旁）。
   */
  function effortPill(): JSX.Element | null {
    // 精简模式：内核对话 Agent 无推理等级概念 → 不渲染 pill（避免"点了没反应"）
    if (chatMode?.mode === 'slim') return null
    const locked = running || busy
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          aria-expanded={effortOpen}
          disabled={locked}
          title={`${tr('effortTitle')}：${effortName(effort)}`}
          onClick={() => { setEffortOpen((v) => !v); setCmdMenuOpen(false) }}
          className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
            effortOpen
              ? 'border-ring bg-accent text-foreground'
              : effort === 'max'
                ? 'border-indigo-300 bg-indigo-50 font-medium text-indigo-600 hover:bg-indigo-100'
                : effort === 'off'
                  ? 'border-input text-muted-foreground hover:bg-accent hover:text-foreground'
                  : 'border-input text-foreground hover:bg-accent'
          }`}
        >
          {effortName(effort)}
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>
        {effortOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setEffortOpen(false)} aria-hidden />
            <div className="absolute bottom-full left-0 z-30 mb-1.5 w-56 rounded-2xl border border-input bg-card p-1.5 shadow-2xl">
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">{tr('effortTitle')}</p>
              {EFFORT_LEVELS.map((l) => (
                <button
                  key={l.v}
                  type="button"
                  role="radio"
                  aria-checked={effort === l.v}
                  onClick={() => void changeEffort(l.v)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    effort === l.v ? 'bg-accent' : 'hover:bg-accent/60'
                  }`}
                >
                  <span className="min-w-0">
                    <span className={effort === l.v ? 'font-medium text-foreground' : 'text-foreground'}>{l.name}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground">{l.desc}</span>
                  </span>
                  {effort === l.v ? (
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-info">
                      <path d="M3.5 8.4 6.4 11.3 12.5 4.7" />
                    </svg>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    )
  }

  /** + 号命令菜单（照 DSH composer `.tools`：只列 DSH 同名命令 `/plan`）。
   *  用户 2026-09 拍板：菜单里只保留 /plan；执行权限/推理等级已从菜单移除
   *  （它们仍在输入条上有独立控件：权限状态行 + 推理等级 pill）。 */
  function plusMenu(): JSX.Element | null {
    // 精简模式：菜单里唯一命令是 /plan（plan-mode），不支持 → 整个 + 菜单隐藏
    if (chatMode?.mode === 'slim') return null
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          aria-label={tr('cmdMenuTitle')}
          aria-haspopup="listbox"
          aria-expanded={cmdMenuOpen}
          title={tr('cmdMenuTitle')}
          onClick={() => { setCmdMenuOpen((v) => !v); setEffortOpen(false) }}
          className={`grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
            cmdMenuOpen ? 'bg-accent text-foreground' : ''
          }`}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
        {cmdMenuOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setCmdMenuOpen(false)} aria-hidden />
            <div className="absolute bottom-full left-0 z-30 mb-1.5 w-56 rounded-2xl border border-input bg-card p-1.5 shadow-2xl" role="listbox" aria-label={tr('cmdMenuTitle')}>
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">{tr('cmdMenuTitle')}</p>
              {/* 计划模式 /plan：DSH 同名命令（等效 /plan、/plan off；OFF 态经此开启后 PlanChip 出现） */}
              <button
                type="button"
                role="option"
                aria-selected={planMode}
                onClick={() => { setCmdMenuOpen(false); togglePlanMode() }}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
              >
                <span className="min-w-0">
                  <code className="mr-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">/plan</code>
                  <span className="text-foreground">{planMode ? tr('cmdMenuPlanOn') : tr('cmdMenuPlan')}</span>
                </span>
                {planMode ? (
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-amber-500">
                    <path d="M3.5 8.4 6.4 11.3 12.5 4.7" />
                  </svg>
                ) : null}
              </button>
            </div>
          </>
        ) : null}
      </div>
    )
  }

  /** 阶段3 Phase2：会话确认后显式烧录（防误烧——用户核对端口后确认才执行） */
  async function confirmFlash(): Promise<void> {
    if (!sessionId || !flashPending) return
    setBusy(true)
    setOpErr('')
    try {
      const r = await window.lcode.confirmFlash(sessionId, flashPending.project_dir, flashPort.trim())
      if (!r) {
        fail(null, lang === 'zh' ? '烧录' : 'Flash')
        return
      }
      setFlashPending(null)
      setRunning(true)
      void refresh(sessionId)
    } catch (e) {
      fail(e, lang === 'zh' ? '烧录' : 'Flash')
    } finally {
      setBusy(false)
    }
  }

  /** 取消待烧录（不执行） */
  async function dismissFlash(): Promise<void> {
    if (!sessionId) return
    setBusy(true)
    try {
      const r = await window.lcode.dismissFlash(sessionId)
      if (!r) {
        fail(null, lang === 'zh' ? '取消烧录' : 'Dismiss flash')
        return
      }
      setFlashPending(null)
    } catch (e) {
      fail(e, lang === 'zh' ? '取消烧录' : 'Dismiss flash')
    } finally {
      setBusy(false)
    }
  }

  /** 切换执行权限（普通 / 全部执行 Full Access）；新会话无 sessionId 时仅预设，发送时生效 */
  async function changeAccess(fa: boolean): Promise<void> {
    if (fa === fullAccess) return
    setFullAccess(fa)
    if (!sessionId) return
    try {
      const r = await window.lcode.setChatAccess(sessionId, fa)
      if (!r) {
        setFullAccess(!fa)
        fail(null, lang === 'zh' ? '切换权限' : 'Change access')
      }
    } catch (e) {
      setFullAccess(!fa)
      fail(e, lang === 'zh' ? '切换权限' : 'Change access')
    }
  }

  /** WorkBuddy 式权限控件逻辑：切「默认权限」立即生效；切「允许完全访问」先弹红色风险确认 */
  function choosePerm(next: boolean): void {
    setPermOpen(false)
    if (next === fullAccess) return
    if (next) {
      setRiskAcked(false)
      setPermConfirm(true)
    } else {
      void changeAccess(false)
    }
  }

  function confirmPermFull(): void {
    setPermConfirm(false)
    void changeAccess(true)
  }

  /** 执行权限控件（空会话引导 / 常规输入区共用；WorkBuddy permission 模块复刻）：
   *  聊天框下方一行「权限」状态项 → 点击弹出小面板（当前态说明 + 默认权限 / 允许完全访问
   *  两行，26x16 迷你开关，完全访问 on 为红 #E54747）；开启「允许完全访问」先弹红色风险确认。
   *  视觉参数参照 workbuddy-app：面板 200+px/圆角16/0.5px 细边/双层投影、行高 32/圆角 8/hover #F2F2F2。 */
  function accessSelector(disabled: boolean): JSX.Element {
    const row = (next: boolean): JSX.Element => {
      const active = fullAccess === next
      return (
        <button
          key={next ? 'full' : 'default'}
          type="button"
          role="radio"
          aria-checked={active}
          onClick={() => choosePerm(next)}
          disabled={disabled}
          className={`flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-xs transition-colors disabled:opacity-50 disabled:pointer-events-none ${
            active ? (next ? 'bg-perm-soft' : 'bg-muted') : 'hover:bg-muted'
          }`}
        >
          <span className={active && next ? 'font-medium text-perm-full' : active ? 'font-medium' : 'text-muted-foreground'}>
            {next ? tr('chatAccessFull') : tr('chatAccessNormal')}
          </span>
          <span
            role="switch"
            aria-checked={active}
            className={`relative inline-block h-4 w-[26px] shrink-0 rounded-full transition-colors ${
              active ? (next ? 'bg-perm-full' : 'bg-foreground/80') : 'bg-foreground/10'
            } ${disabled ? 'opacity-60' : ''}`}
          >
            <span className={`absolute left-[2px] top-[2px] h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${active ? 'translate-x-[10px]' : ''}`} />
          </span>
        </button>
      )
    }

    return (
      <div className="relative flex items-center justify-between gap-2 border-t px-2 py-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setPermOpen((v) => !v)}
          aria-expanded={permOpen}
          title={fullAccess ? tr('chatAccessFullHint') : tr('chatAccessNormalHint')}
          className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50 disabled:pointer-events-none ${
            fullAccess ? 'text-perm-full hover:bg-perm-soft' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="currentColor"><path d="M8 1.3l6.2 2.1v4.6c0 3.5-2.5 5.9-6.2 7-3.7-1.1-6.2-3.5-6.2-7V3.4L8 1.3zm0 1.8L3 4.8v3.2c0 2.7 1.9 4.6 5 5.5 3.1-.9 5-2.8 5-5.5V4.8L8 3.1z" /></svg>
          <span className={fullAccess ? 'font-medium' : ''}>{fullAccess ? tr('chatAccessFull') : tr('chatAccessNormal')}</span>
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden fill="currentColor" className={`transition-transform ${permOpen ? 'rotate-180' : ''}`}><path d="M3 5.5 8 10.5 13 5.5l1.2 1.3L8 13 1.8 6.8 3 5.5z" /></svg>
        </button>
        {!disabled && permOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setPermOpen(false)} aria-hidden />
            <div className="absolute bottom-full right-0 z-30 mb-1.5 w-72 max-w-[calc(100vw-16px)] rounded-2xl border border-input bg-card p-2 shadow-2xl">
              <p className="whitespace-pre-line px-2 py-1 text-xs leading-5 text-muted-foreground">
                {fullAccess ? tr('chatAccessFullDesc') : tr('chatAccessNormalDesc')}
              </p>
              <div className="mt-1 flex flex-col gap-0.5">
                {row(false)}
                {row(true)}
              </div>
            </div>
          </>
        ) : null}
      </div>
    )
  }

  /** WorkBuddy 式「允许完全访问」红色风险确认弹窗（hero 空会话与主视图共用） */
  const permConfirmDialog = permConfirm ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[400px] max-w-[92vw] rounded-2xl border bg-background p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden className="shrink-0 text-perm-full" fill="currentColor">
            <path d="M10 1.4l6.8 2.3v5c0 3.9-2.8 6.9-6.8 7.9-4-1-6.8-4-6.8-7.9v-5L10 1.4zm-1 4.8v3.4h2V6.2H9zm0 5.1v1.7h2v-1.7H9z" />
          </svg>
          <h3 className="text-base font-semibold">{tr('permConfirmTitle')}</h3>
        </div>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">{tr('permConfirmDesc')}</p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-perm-full"
            checked={riskAcked}
            onChange={(e) => setRiskAcked(e.target.checked)}
          />
          {tr('permRiskLabel')}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setPermConfirm(false)} disabled={busy}>
            {tr('permCancel')}
          </Button>
          <Button variant="destructive" onClick={() => void confirmPermFull()} disabled={!riskAcked || busy}>
            {tr('permAllowFull')}
          </Button>
        </div>
      </div>
    </div>
  ) : null

  // 空会话引导（工作区/首页首次进入）
  if (heroShell) {
    return (
      <div className="flex h-full min-w-0 flex-col" ref={rootRef}>
        {/* WorkBuddy 参考：聊天框上方不再放任何引导文案，直接落到底部聊天卡 */}
        <div className="flex-1" />
        <div className="border-t p-3">
          {/* WorkBuddy 式输入卡：发送键放进「聊天框」内、右下角
              （对应 WorkBuddy conversation-render 的 .cr-input-container + .input-toolbar__send：
              卡片 = 细边框 + 圆角 + focus-within 环；内部 = 文本编辑区 + 底部行，行尾放圆形发送钮） */}
          <div className="flex flex-col rounded-capsule border border-input bg-background shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring">
            <textarea
              ref={heroTaRef}
              className="min-h-24 w-full resize-none overflow-y-auto bg-transparent p-3 pb-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:text-muted-foreground/70"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (sendMode === 'enter') {
                  // Enter 直接发送（WorkBuddy 语义）；Shift+Enter 保留换行
                  if (e.shiftKey) return
                  e.preventDefault()
                  void send()
                } else if (e.ctrlKey || e.metaKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={tr('wsChatPlaceholder')}
              disabled={busy}
            />
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              {/* 输入条左侧：+ 命令菜单（DSH composer .tools，运行前/新会话同样常驻）+
                  计划 chip（仅开启时出现）+ 推理等级 pill + 发送快捷键/状态提示 */}
              <div className="flex min-w-0 items-center gap-1.5">
                {plusMenu()}
                {planChip()}
                {effortPill()}
                <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                  {busy ? tr('chatStarting') : sendMode === 'ctrlEnter' ? tr('wsChatEnterHint') : ''}
                </span>
              </div>
              <Button
                variant="info"
                size="icon"
                className="shrink-0"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                title={tr('chatSend')}
                aria-label={tr('chatSend')}
              >
                <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              </Button>
            </div>
          </div>
          {opErr ? (
            <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-red-600">{opErr}</p>
          ) : null}
        </div>
        {/* 新会话同样可选执行权限（预设，发送时生效） */}
        {accessSelector(busy)}
        {permConfirmDialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col" ref={rootRef}>
      {/* 会话标题行：标题 + 运行状态徽章 + 「新会话」按钮
          （2026-09 用户要求：把原来的「空闲」状态位改成「新会话」按钮，点击即开一个空会话；
            当前会话不删除，仍留在项目里可从首页/项目列表再次打开） */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {title || tr('chatSessionTitle')}
        </span>
        {running ? <Badge color="blue">{tr('chatRunningBadge')}</Badge> : null}
        <button
          type="button"
          onClick={startNewChat}
          disabled={busy}
          title={tr('chatNewSessionTitle')}
          aria-label={tr('chatNewSession')}
          className="flex shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          {tr('chatNewSession')}
        </button>
        {/* plan-mode 开关已迁至输入条底部行左侧（DSH composer .modes 位置）；上下文圆环已迁至输入条底部行右侧 */}
      </div>

      {/* 精简模式提示条：对话由内核 Agent 承载（能力差异必须如实告诉用户，否则会以为功能坏了） */}
      {chatMode?.mode === 'slim' ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          <span className="font-medium">{tr('chatSlimModeTitle')}</span>
          {' · '}
          {tr('chatSlimModeBody')}
          {chatMode.planner_error ? <span className="ml-1 opacity-70">（{chatMode.planner_error}）</span> : null}
        </div>
      ) : null}

      {/* 消息区：渲染层 block 组装（用户右气泡 / 助手回合左对齐 text+工具卡组） */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && !running ? (
          deadEmpty ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {lang === 'zh'
                ? '该会话没有可继续的内容（空壳/已损坏），无法加载对话——请删除该会话后新建对话'
                : 'This session has no continuable content (empty shell / corrupted), so the conversation cannot load — delete it and start a new chat'}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {/* 内核启动窗口（打开文件夹会重启内核，冷启动 30~60s）→ 明确告诉用户在等什么，
                  此时历史会话正在自动重试加载，不要误以为“没加载出来” */}
              {kernelStatus && kernelStatus.status !== 'running' ? tr('chatKernelStarting') : tr('chatLoading')}
            </div>
          )
        ) : (
          sections.map((s, i) => {
            if (s.role === 'user') {
              return (
                <div key={s.key} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {s.text}
                  </div>
                </div>
              )
            }
            // assistant 回合：最后一个（尚无后续 user 消息）且运行中 → 文字尾部光标 = 流式占位
            const isLastAssistant = running && i === sections.length - 1
            // 本回合回复全文（复制用；工具卡不算文字）
            const copyText = s.turn.blocks.reduce<string>(
              (acc, b) => (b.kind === 'text' ? (acc ? `${acc}\n` : '') + b.text : acc),
              ''
            ).trim()
            return (
              <div key={s.key} className="flex justify-start">
                <div className="max-w-[95%] overflow-hidden rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
                  <TurnBlocks blocks={s.turn.blocks} streaming={isLastAssistant && running} />
                  {/* 阶段4 W4 · DSH MessageIconActions：复制 + 在新对话中分支（运行中禁用） */}
                  {copyText !== '' ? (
                    <TurnActions
                      text={copyText}
                      branchable={!!sessionId && !running && !busy && !forking}
                      onBranch={() => void branchAt(s.turn.lastMsgId)}
                    />
                  ) : null}
                </div>
              </div>
            )
          })
        )}

        {/* W1 打字机尾巴：assistant/chunk 增量 / 定型全文（已含进 text 块时隐藏） */}
        {running && streamTail !== '' ? (
          <div className="flex justify-start">
            <div className="max-w-[95%] whitespace-pre-wrap break-words rounded-lg border border-dashed border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm text-foreground">
              {streamTail}
              <StreamCaret />
            </div>
          </div>
        ) : null}

        {/* 运行中 · 实时事件行（工具卡落地前的过程细节；assistant/chunk|message 已由尾巴/块呈现，不再铺行） */}
        {running ? (
          <LiveEventRows events={events} sections={sections} tr={tr} />
        ) : null}

        {/* 结束后的系统通知（事件时间线改为工具卡后，仅保留非工具过程的通知；避免与卡片重复铺行） */}
        {!running && noticeEvents(events).length > 0 ? (
          <details className="pt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              {tr('chatEvents')}（{noticeEvents(events).length}）
            </summary>
            <div className="mt-1 max-h-56 overflow-y-auto rounded border bg-muted/20 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
              {noticeEvents(events).map((ev) => (
                <div key={ev.seq} className={ev.level === 'WARN' || ev.level === 'ERROR' ? 'text-red-600' : ''}>
                  {ev.node ? <span className="text-sky-600">[{ev.node}] </span> : null}
                  {ev.message.length > 300 ? ev.message.slice(0, 300) + '…' : ev.message}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      {/* 输入区：与空会话聊天卡同款（固定 h-24 文本卡 + 卡内底部行，外层 p-3 一致），
          不随有没有聊天内容而改变大小/位置。
          运行中（DSH 语义，2026-09 照抄）：输入框仍可选中/输入/发送 ——
          Enter = 排队（本轮结束后自动执行）、Ctrl+Enter = 立即投递给运行中的 Agent；
          右侧同时保留发送键与停止键。 */}
      <div className="border-t p-3">
        {/* 待发送队列（DSH QueueDock）：运行中排队/已 steer 未消费的消息，可单条删除 */}
        {queue.length > 0 ? (
          <div className="mb-2 rounded-xl border border-input bg-card/70 p-1.5">
            <p className="px-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {tr('queueTitle')}（{queue.length}）
            </p>
            {queue.map((it) => (
              <div key={it.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent/50">
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {it.placement === 'next-step' ? tr('queueSteering') : tr('queueQueued')}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={it.text}>
                  {it.text}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title={tr('queueRemove')}
                  aria-label={tr('queueRemove')}
                  onClick={() => void removeQueueItem(it.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col rounded-capsule border border-input bg-background shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring">
          <textarea
            ref={mainTaRef}
            className="min-h-24 w-full resize-none overflow-y-auto bg-transparent p-3 pb-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:text-muted-foreground/70"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (running) {
                // DSH：运行中 Enter=排队；Ctrl/Cmd+Enter=steer（立即投递）；Shift+Enter 换行
                if (e.shiftKey) return
                e.preventDefault()
                void send(e.ctrlKey || e.metaKey ? 'steer' : 'queue')
                return
              }
              if (sendMode === 'enter') {
                // Enter 直接发送（WorkBuddy 语义）；Shift+Enter 保留换行
                if (e.shiftKey) return
                e.preventDefault()
                void send()
              } else if (e.ctrlKey || e.metaKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={tr('wsChatPlaceholder')}
            readOnly={busy}
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            {/* 输入条左侧 = + 命令菜单（DSH composer .tools）· Plan chip（仅开启）· 推理等级 pill（Effort）· 状态提示 */}
            <div className="flex min-w-0 items-center gap-1.5">
              {plusMenu()}
              {planChip()}
              {effortPill()}
              <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                {running
                  ? tr('chatBusySendHint')
                  : busy
                    ? tr('chatStarting')
                    : sendMode === 'ctrlEnter'
                      ? tr('wsChatEnterHint')
                      : ''}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              {/* 上下文占用圆环（DSH ContextMeter 位置：输入条底部行、发送/停止键左侧） */}
              {context ? (
                <ContextMeter
                  context={context}
                  warnText={
                    context.level === 'warn' || context.level === 'danger'
                      ? lang === 'zh'
                        ? '上下文将满'
                        : 'ctx almost full'
                      : null
                  }
                  title={`上下文约 ${context.total_tokens_estimate.toLocaleString()} / ${context.window_tokens.toLocaleString()} tokens（估算：消息 ${context.message_tokens.toLocaleString()} + 系统/工具 ${context.envelope_tokens.toLocaleString()}；请求携带 ${context.message_count}/${context.total_messages} 条消息）`}
                />
              ) : null}
              {/* 运行中也保留发送键（DSH 的 continuable 布局：Send + Stop 并存）——
                  点击=排队，Ctrl+Enter=立即投递；停止仍在右侧红色键 */}
              <Button
                variant="info"
                size="icon"
                className="shrink-0"
                onClick={() => void send(running ? 'queue' : undefined)}
                disabled={busy || !input.trim()}
                title={running ? tr('chatSendQueued') : tr('chatSend')}
                aria-label={running ? tr('chatSendQueued') : tr('chatSend')}
              >
                <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              </Button>
              {running ? (
                <Button
                  variant="destructive"
                  size="icon"
                  className="shrink-0"
                  onClick={() => void stop()}
                  disabled={busy}
                  title={tr('chatStop')}
                  aria-label={tr('chatStop')}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.8" fill="currentColor" />
                  </svg>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {opErr ? (
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-red-600" role="alert">
            {opErr}
          </p>
        ) : null}
      </div>

      {/* 执行权限（WorkBuddy 权限模块复刻）：置于聊天输入框下方；运行中/busy 整组禁用 */}
      {accessSelector(running || !sessionId)}
      {permConfirmDialog}

      {/* 死会话删除确认：该会话不在规划器内 / 空壳会话（0 消息），删除后不可恢复 */}
      {staleDel ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[400px] max-w-[92vw] rounded-xl border bg-background p-5 shadow-2xl">
            <h3 className="text-base font-semibold">{tr('chatDelTitle')}</h3>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">{tr('chatDelDesc')}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => dismissStaleDel()} disabled={staleBusy}>
                {tr('chatDelCancel')}
              </Button>
              <Button variant="destructive" onClick={() => void confirmDeleteStale()} disabled={staleBusy}>
                {tr('chatDelConfirm')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 每 100 轮暂停：确认继续/停止（类 DeepSeek Harness 弹窗） */}
      {confirmWaiting ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[380px] rounded-xl border bg-background p-5 shadow-2xl">
            <h3 className="text-base font-semibold">{tr('chatConfirmTitle')}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{tr('chatConfirmMsg')}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => void confirmStop()} disabled={busy}>
                {tr('chatStop')}
              </Button>
              <Button onClick={() => void confirmContinue()} disabled={busy}>
                {tr('chatContinue')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 阶段3 Phase2：待烧录确认（防误烧——会话确认结束后显式启动） */}
      {!running && flashPending ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-xl border bg-background p-5 shadow-2xl">
            <h3 className="text-base font-semibold">{tr('flashConfirmTitle')}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{tr('flashConfirmMsg')}</p>
            <div className="mt-3 rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
              {flashPending.project_dir}
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs text-muted-foreground">{tr('flashConfirmPort')}</label>
              <input
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={flashPort}
                onChange={(e) => setFlashPort(e.target.value)}
                placeholder={tr('flashConfirmPortPlaceholder')}
                disabled={busy}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => void dismissFlash()} disabled={busy}>
                {tr('flashCancel')}
              </Button>
              <Button onClick={() => void confirmFlash()} disabled={busy}>
                {tr('flashFlashNow')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* M3 · 人机交互弹窗（plan 审阅 / 审批 / 问题）：exit_plan_mode 与沙盒升级审批在此应答 */}
      {activeInteraction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[460px] max-h-[70vh] overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl">
            {activeInteraction.kind === 'approval' ? (
              <>
                <h3 className="text-base font-semibold">
                  {lang === 'zh' ? '需要审批' : 'Approval required'}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-sky-600">
                    {activeInteraction.toolName}
                  </span>
                  {activeInteraction.reason ?? ''}
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="outline" onClick={() => void answerCurrent(false)} disabled={busy}>
                    {lang === 'zh' ? '拒绝' : 'Reject'}
                  </Button>
                  <Button onClick={() => void answerCurrent(true)} disabled={busy}>
                    {lang === 'zh' ? '允许本次' : 'Allow once'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {activeInteraction.questions.map((q, qi) => (
                  <div key={q.id ?? qi}>
                    <h3 className="text-base font-semibold">{q.header ?? (lang === 'zh' ? '请确认' : 'Please confirm')}</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {q.detail ? (qi === 0 ? `${q.question}\n\n${q.detail}` : q.question) : q.question}
                    </p>
                    <div className="mt-4 flex flex-col gap-1.5">
                      {(q.options ?? []).map((opt, oi) => (
                        <button
                          key={oi}
                          className="rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void answerQuestionsWith([opt.label])}
                        >
                          {opt.label}
                          {opt.description ? (
                            <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>
                          ) : null}
                        </button>
                      ))}
                      {(!q.options || q.options.length === 0) ? (
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" onClick={() => void answerQuestionsWith([])} disabled={busy}>
                            {lang === 'zh' ? '取消' : 'Cancel'}
                          </Button>
                          <Button onClick={() => void answerQuestionsWith(['yes'])} disabled={busy}>
                            {lang === 'zh' ? '确认' : 'OK'}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
