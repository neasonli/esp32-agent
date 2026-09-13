/**
 * 任务会话面板（流水线任务模式，W2 保留）
 *
 * 展示单次 run_task 流水线的：需求气泡 → 事件时间线 → 结果状态/用量/产物。
 * 与对话模式（ChatPane）并存：任务详情视图用于回看历史流水线任务。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import type { ArtifactInfo, KernelEvent, UsageSummary } from '../../../shared/types'
import { Badge, Button, statusBadgeColor } from './ui'
import { statusText, useT } from '../i18n'

const EMPTY_USAGE: UsageSummary = {
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
  total_tokens: 0,
  cost: 0,
  by_node: []
}

interface Props {
  taskId: string
  onOpenArtifact: (path: string, name: string, sizeKb?: number) => void
}

export function TaskChatPane({ taskId, onOpenArtifact }: Props): JSX.Element {
  const [requirement, setRequirement] = useState('')
  const [status, setStatus] = useState('PENDING')
  const [chip, setChip] = useState('')
  const [error, setError] = useState('')
  const [events, setEvents] = useState<KernelEvent[]>([])
  const [usage, setUsage] = useState<UsageSummary>(EMPTY_USAGE)
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const lang = useAppStore((s) => s.lang)
  const tr = useT()

  const refresh = useCallback(async () => {
    try {
      const d = await window.lcode.getConversation(taskId)
      if (!d) return
      setRequirement(d.user_requirement)
      setStatus(d.status)
      setChip(d.chip_model)
      setError(d.error_msg)
      setEvents(d.events)
      setUsage(d.usage)
      setArtifacts(
        ((d.result as { artifacts?: ArtifactInfo[] } | undefined)?.artifacts ?? []) as ArtifactInfo[]
      )
    } catch {
      /* 静默重试 */
    }
  }, [taskId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!status || status === 'PENDING' || status === 'RUNNING') {
      const timer = setInterval(() => void refresh(), 2500)
      return () => clearInterval(timer)
    }
    return undefined
  }, [status, refresh])

  useEffect(() => {
    const off = window.lcode.onKernelEvent((ev) => {
      if (ev.task_id === taskId) {
        setEvents((prev) => (prev.some((e) => e.seq === ev.seq) ? prev : [...prev, ev]))
      }
    })
    return off
  }, [taskId])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [events, status])

  const running = status === 'PENDING' || status === 'RUNNING'

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3" ref={listRef}>
        {requirement ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              {requirement}
            </div>
          </div>
        ) : null}

        <div className="flex justify-start">
          <div className="max-w-[92%] rounded-lg border bg-card px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={statusBadgeColor(status)}>{statusText(status, lang)}</Badge>
              {chip ? <span className="text-xs text-muted-foreground">芯片 {chip}</span> : null}
              {usage.total_tokens > 0 ? (
                <span className="text-xs text-muted-foreground">Token {usage.total_tokens}</span>
              ) : null}
              {artifacts.length > 0 ? (
                <div className="group relative">
                  <button className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent" title={tr('chatArtifacts')}>
                    📦 {tr('chatArtifacts')}
                  </button>
                  <div className="absolute right-0 z-20 hidden w-64 rounded-md border bg-background p-1.5 shadow-lg group-hover:block">
                    {artifacts.map((a) => (
                      <button
                        key={a.path}
                        className="w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-accent"
                        onClick={() => onOpenArtifact(a.path, a.name, a.size_kb)}
                      >
                        {a.name}（{a.size_kb} KB）
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
            <details open={running}>
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                {running ? tr('chatWorking') : `${tr('chatEvents')}（${events.length}）`}
              </summary>
              <div className="mt-1 max-h-72 overflow-y-auto font-mono text-[11px] leading-4 text-muted-foreground">
                {events.map((ev) => (
                  <div key={ev.seq}>
                    {ev.node ? `[${ev.node}] ` : ''}
                    {ev.message}
                  </div>
                ))}
              </div>
            </details>
            {status === 'CANCELED' || status === 'FAILED' || status === 'INTERRUPTED' ? (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => window.lcode.resumeTask(taskId)}>
                  {tr('chatResume')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => window.lcode.resumeTask(taskId, true)}>
                  {tr('chatRestartFull')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="border-t p-2 text-center text-[10px] text-muted-foreground">
        {tr('chatFollowUpHint')}
      </div>
    </div>
  )
}
