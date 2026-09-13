/**
 * W1 · block 渲染组件（纯展示；Agent/LLM/编译逻辑零，D19）
 *
 * 依据《Agent聊天窗口设计文档》§1.3/§2：
 * - 助手回合 = 左对齐多 block 纵向排列（文本段落 + 工具卡片组 + 诊断卡(后置)/通知）；
 * - 工具调用链按模型顺序渲染为可折叠工具卡片组，卡片三态（执行中/成功/失败），
 *   失败时错误摘要直接可见（不藏在详情里）；展开详情截断显示。
 */
import { useMemo, useState } from 'react'
import type { ChatBlock, ToolCallBlock } from '../chatModel'
import { useAppStore } from '../stores/useAppStore'

const DETAIL_MAX = 3000

function truncate(s: string, max = DETAIL_MAX): string {
  return s.length > max ? s.slice(0, max) + '\n…（已截断）' : s
}

/** 极简 fenced-code 切分：``` 块 → 等宽代码段；其余 → 普通文本（保留换行/空白） */
function TextWithCode({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => {
    const out: { code: boolean; text: string }[] = []
    const re = /```([\w-]*)\n?([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) })
      out.push({ code: true, text: m[2] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ code: false, text: text.slice(last) })
    return out
  }, [text])
  return (
    <div className="space-y-2 text-sm leading-6">
      {parts.map((p, i) =>
        p.code ? (
          <pre
            key={i}
            className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11.5px] leading-5 text-foreground"
          >
            {p.text.replace(/^\n/, '')}
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words">
            {p.text}
          </p>
        )
      )}
    </div>
  )
}

// ---------- 工具卡片 ----------

function fmtElapsed(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return ''
  const end = endedAt ?? Date.now()
  const ms = Math.max(0, end - startedAt)
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function ToolCard({ tool }: { tool: ToolCallBlock }): JSX.Element {
  const lang = useAppStore((s) => s.lang)
  const zh = lang === 'zh'
  const { state } = tool
  const color =
    state === 'running'
      ? 'border-sky-500/40 bg-sky-500/5'
      : state === 'failed'
        ? 'border-red-400/60 bg-red-500/5'
        : 'border-green-500/40 bg-green-500/5'

  return (
    <div className={`overflow-hidden rounded-md border-l-2 ${color}`}>
      {/* 卡头：状态 + 工具名 + 参数摘要 + 耗时 + 展开 */}
      <details className="group">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-xs">
          <span className="shrink-0 text-sm leading-none">
            {state === 'running' ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent align-middle" />
            ) : state === 'failed' ? (
              <span className="text-red-600">✕</span>
            ) : (
              <span className="text-green-600">✓</span>
            )}
          </span>
          <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-[10px] text-sky-700 dark:text-sky-300">
            {tool.name}
          </span>
          {tool.argsPreview ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {tool.argsPreview}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {fmtElapsed(tool.startedAt, tool.endedAt) ? (
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{fmtElapsed(tool.startedAt, tool.endedAt)}</span>
          ) : null}
          <span className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90">▸</span>
        </summary>
        <div className="border-t px-2 py-1.5">
          {state === 'running' ? (
            <p className="text-[10px] text-sky-600">{zh ? '执行中…' : 'running…'}</p>
          ) : (
            <div className="space-y-1.5">
              {state === 'failed' ? (
                <p className="whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-red-600">
                  {tool.result ? previewOrAll(tool.result) : zh ? '执行失败（无详情）' : 'failed (no detail)'}
                </p>
              ) : tool.result ? (
                <p className="whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-foreground/80">
                  {previewOrAll(tool.result)}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function previewOrAll(text: string): string {
  return truncate(text)
}

/** 工具卡片组（一次 __toolcalls__ 的一组调用；可整体折叠） */
export function ToolChainGroup({ tools }: { tools: ToolCallBlock[] }): JSX.Element {
  const lang = useAppStore((s) => s.lang)
  const zh = lang === 'zh'
  const done = tools.filter((t) => t.state !== 'running').length
  const running = tools.length - done
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-lg border bg-card/60">
      <div className="flex items-center justify-between border-b bg-muted/20 px-2 py-1">
        <button
          className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          title={zh ? '折叠/展开工具调用链' : 'Collapse/expand tool chain'}
        >
          <span className={`inline-block text-[8px] transition-transform ${open ? '' : '-rotate-90'}`}>▾</span>
          {zh ? '工具调用链' : 'Tool chain'}
          <span className="rounded bg-muted px-1 font-mono text-[9px]">
            {done}/{tools.length}
          </span>
        </button>
        <span className="text-[9px] text-muted-foreground">
          {running > 0 ? (zh ? `执行中 ${running}` : `${running} running`) : zh ? '已完成' : 'done'}
        </span>
      </div>
      {open ? (
        <div className="space-y-1 p-1">
          {tools.map((t) => (
            <ToolCard key={t.key} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------- 文本 / 通知 ----------

function TextBlock({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  return (
    <div className="text-sm">
      <TextWithCode text={text} />
      {streaming ? <StreamingCaret /> : null}
    </div>
  )
}

function StreamingCaret(): JSX.Element {
  return (
    <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-sm bg-sky-500 align-middle" />
  )
}

function NoticeBlock({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }): JSX.Element {
  const color =
    level === 'error' ? 'text-red-600' : level === 'warn' ? 'text-amber-600' : 'text-muted-foreground'
  return <div className={`py-0.5 text-center text-[10px] ${color}`}>{text}</div>
}

/** 回合内 block 列表（左对齐助手回合）；streaming 时仅在最后一段 text 尾加流式光标 */
export function TurnBlocks({
  blocks,
  streaming,
}: {
  blocks: ChatBlock[]
  streaming?: boolean
}): JSX.Element {
  const lastTextIdx = (() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'text') return i
    return -1
  })()
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'text':
            return (
              <TextBlock key={b.key} text={b.text} streaming={streaming && i === lastTextIdx} />
            )
          case 'tools':
            return <ToolChainGroup key={b.key} tools={b.tools} />
          case 'notice':
            return <NoticeBlock key={b.key} level={b.level} text={b.text} />
        }
      })}
    </div>
  )
}
