/**
 * 事件轮询器（W1 骨架）
 *
 * 阶段2文档 6.IPC 契约：内核写 SQLite 事件表 → 主进程每 500ms 增量轮询
 * /api/events?after_seq=N → 通过 webContents.send 推给渲染进程实时渲染。
 * 内核不持有长连接（规避 GIL 瓶颈）。
 */
import { BrowserWindow } from 'electron'
import type { KernelEvent } from '../shared/types'

const POLL_INTERVAL_MS = 500

export class EventPoller {
  private timers = new Map<string, NodeJS.Timeout>()
  private lastSeq = new Map<string, number>()

  constructor(
    private getEvents: (taskId: string, afterSeq: number) => Promise<{ events: KernelEvent[] }>,
    private getWindow: () => BrowserWindow | null
  ) {}

  /** 开始轮询某任务的事件，推送到渲染进程 channel: 'kernel:event' */
  start(taskId: string): void {
    if (this.timers.has(taskId)) return
    this.lastSeq.set(taskId, 0)
    const timer = setInterval(() => this.pollOnce(taskId), POLL_INTERVAL_MS)
    this.timers.set(taskId, timer)
  }

  stop(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(taskId)
      this.lastSeq.delete(taskId)
    }
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) this.stop(id)
  }

  private async pollOnce(taskId: string): Promise<void> {
    try {
      const afterSeq = this.lastSeq.get(taskId) ?? 0
      const { events } = await this.getEvents(taskId, afterSeq)
      if (events.length > 0) {
        const win = this.getWindow()
        for (const ev of events) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('kernel:event', ev)
          }
        }
        this.lastSeq.set(taskId, events[events.length - 1].seq)
      }
    } catch {
      // 内核未就绪/任务不存在时静默跳过，下一轮重试
    }
  }
}
