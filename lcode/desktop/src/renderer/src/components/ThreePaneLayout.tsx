/**
 * 三栏可拖拽布局（文件树 | 内容窗 | 聊天），2026-09 用户要求“可用鼠标左右拉伸比例”。
 *
 * 布局沿用设置页的 `layout`（treeLeft = 源码在左 / chatLeft = 聊天在左），
 * 两侧宽度来自 store（`treeWidth` / `chatWidth`，持久化），中间内容窗吃剩余空间。
 *
 * 拖拽约定（与用户直觉一致：往哪边拖，那一栏就变宽）：
 * - treeLeft： [树 | 内容 | 聊天] —— 树分隔条取 +Δ，聊天分隔条取 −Δ
 * - chatLeft： [聊天 | 内容 | 树] —— 聊天分隔条取 +Δ，树分隔条取 −Δ
 * 夹取：两侧最小 160/220px，中间窗至少留 320px（窄窗口下先保中间窗）。
 */
import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'

/** 中间内容窗最小宽度（拖拽时优先保证） */
const MIDDLE_MIN = 320
/** 两侧最小宽度 */
const TREE_MIN = 160
const CHAT_MIN = 220

interface Props {
  tree: ReactNode
  chat: ReactNode
  middle: ReactNode
}

export function ThreePaneLayout({ tree, chat, middle }: Props): JSX.Element {
  const { layout, treeWidth, chatWidth, setTreeWidth, setChatWidth } = useAppStore()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState<'tree' | 'chat' | null>(null)
  const dragRef = useRef<{ kind: 'tree' | 'chat'; startX: number; startW: number } | null>(null)

  /** 夹取：不小于各自最小宽度，且给中间窗留 MIDDLE_MIN */
  const clamp = useCallback(
    (kind: 'tree' | 'chat', w: number): number => {
      const total = containerRef.current?.clientWidth ?? 1200
      const other = kind === 'tree' ? chatWidth : treeWidth
      const min = kind === 'tree' ? TREE_MIN : CHAT_MIN
      const max = Math.max(min, total - other - MIDDLE_MIN)
      return Math.min(Math.max(w, min), max)
    },
    [treeWidth, chatWidth]
  )

  const startDrag = useCallback(
    (kind: 'tree' | 'chat') =>
      (e: React.MouseEvent): void => {
        e.preventDefault()
        dragRef.current = {
          kind,
          startX: e.clientX,
          startW: kind === 'tree' ? treeWidth : chatWidth
        }
        setDragging(kind)
        // 方向：树在左(treeLeft)/聊天在左(chatLeft) → 该栏向右拖是变宽
        const dir = (kind === 'tree') === (layout === 'treeLeft') ? 1 : -1
        const onMove = (ev: MouseEvent): void => {
          const d = dragRef.current
          if (!d) return
          const next = clamp(d.kind, d.startW + (ev.clientX - d.startX) * dir)
          if (d.kind === 'tree') setTreeWidth(next)
          else setChatWidth(next)
        }
        const onUp = (): void => {
          dragRef.current = null
          setDragging(null)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      },
    [layout, treeWidth, chatWidth, clamp, setTreeWidth, setChatWidth]
  )

  /** 分隔条（视觉 4px，命中区左右各外扩 4px，便于点中） */
  function handle(kind: 'tree' | 'chat'): JSX.Element {
    const active = dragging === kind
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整宽度"
        onMouseDown={startDrag(kind)}
        className={`group relative w-1 shrink-0 cursor-col-resize transition-colors ${
          active ? 'bg-info/70' : 'bg-border hover:bg-info/50'
        }`}
      >
        <span className="absolute inset-y-0 -left-1 -right-1" aria-hidden />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" ref={containerRef}>
      {layout === 'treeLeft' ? (
        <>
          <div className="min-h-0 shrink-0 overflow-hidden bg-card" style={{ width: treeWidth }}>
            {tree}
          </div>
          {handle('tree')}
          <div className="min-w-0 flex-1">{middle}</div>
          {handle('chat')}
          <div className="min-h-0 shrink-0 overflow-hidden bg-card" style={{ width: chatWidth }}>
            {chat}
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 shrink-0 overflow-hidden bg-card" style={{ width: chatWidth }}>
            {chat}
          </div>
          {handle('chat')}
          <div className="min-w-0 flex-1">{middle}</div>
          {handle('tree')}
          <div className="min-h-0 shrink-0 overflow-hidden bg-card" style={{ width: treeWidth }}>
            {tree}
          </div>
        </>
      )}
    </div>
  )
}
