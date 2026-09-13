/**
 * 工作区目录服务（主进程本地 fs）
 *
 * 为什么不用内核接口（`/api/workspace_files`）：
 * - 「文件→打开文件夹」会 `kernel.setWorkspaceDir(dir)` 并**重启内核**让 `--outputs` 生效，
 *   而内核冷启动需 30~60s；旧实现文件树走内核 HTTP，重启窗口内请求必失败 →
 *   旧重试窗口（12×1.5s=18s）用尽即报“内核未就绪”，用户必须手点 ⟳ 才看到目录（实测 bug）。
 * - 文件树是纯本地浏览，与 Agent 无关：走主进程 fs 可**打开文件夹即显示**，
 *   并能用 `fs.watch` 把「目录内容变化」即时推给渲染层（内核接口没有变更推送能力）。
 *
 * 安全：与内核 `_safe_resolve` 同口径——解析后的路径必须位于工作区根内，越界即拒绝。
 * 工作区根 = 内核 `--outputs` 目录（`kernel.workspaceDirValue`），未设置时 = 内核默认 outputs。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { FileEntry } from '../shared/types'
import { logToFile } from './logger'

/** 单文件读取上限（与内核 /api/workspace_file 一致：>200KB 请用外部编辑器） */
const READ_LIMIT = 200 * 1024
/** 变化推送去抖：连续写入（生成工程/编译产物）只触发一次刷新 */
const WATCH_DEBOUNCE_MS = 200

export interface DirListing {
  path: string
  entries: FileEntry[]
}

export interface FileReadResult {
  path: string
  name: string
  size: number
  content: string
}

export class WorkspaceFs {
  private watcher: fs.FSWatcher | null = null
  private watchRoot = ''
  private debounceTimer: NodeJS.Timeout | null = null

  constructor(
    private getRoot: () => string,
    private getWindow: () => BrowserWindow | null
  ) {}

  get root(): string {
    return path.resolve(this.getRoot())
  }

  /**
   * 解析请求路径：'' = 工作区根；其余按「相对根」解析（也接受根内绝对路径）。
   * 解析结果必须仍在根内，否则抛错（防目录穿越，等价内核 _safe_resolve 的 403）。
   */
  private resolveInside(raw: string): string {
    const root = this.root
    const target = raw ? path.resolve(root, raw) : root
    const rel = path.relative(root, target)
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error('路径越界')
    }
    return target
  }

  /** 列目录（目录在前、名称升序；与旧内核接口同结构，渲染层零改动） */
  list(raw: string): DirListing {
    const target = this.resolveInside(raw)
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error('目录不存在')
    }
    if (!stat.isDirectory()) throw new Error('目录不存在')
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .map((d): FileEntry => {
        const p = path.join(target, d.name)
        let size = 0
        if (d.isFile()) {
          try {
            size = fs.statSync(p).size
          } catch {
            size = 0
          }
        }
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, path: p }
      })
      .sort((a, b) =>
        a.type === b.type
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a.type === 'dir'
            ? -1
            : 1
      )
    return { path: target, entries }
  }

  /** 读文本文件（UTF-8；>READ_LIMIT 拒绝） */
  read(raw: string): FileReadResult {
    const target = this.resolveInside(raw)
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error('文件不存在')
    }
    if (!stat.isFile()) throw new Error('文件不存在')
    if (stat.size > READ_LIMIT) throw new Error('文件过大（>200KB），请在外部编辑器打开')
    return {
      path: target,
      name: path.basename(target),
      size: stat.size,
      content: fs.readFileSync(target, 'utf8')
    }
  }

  /**
   * 递归监听工作区根：内容变化（新增/删除/改名/写入）去抖后推送 `workspace:changed`。
   * 根目录变化（重新打开文件夹）时调用本方法即可切换监听目标。
   */
  watch(): void {
    const root = this.root
    if (this.watcher && this.watchRoot === root) return
    this.unwatch()
    // 根可能尚未创建（首次使用默认 outputs）：先建出来，避免 watch ENOENT
    try {
      fs.mkdirSync(root, { recursive: true })
    } catch {
      /* 建不出来时交给 list() 报错 */
    }
    try {
      this.watcher = fs.watch(root, { recursive: true }, () => this.notifyChanged())
      this.watchRoot = root
      this.watcher.on('error', (e) => {
        logToFile('[workspace-fs] 监听异常，停止监听:', e instanceof Error ? e.message : String(e))
        this.unwatch()
      })
      logToFile('[workspace-fs] 已监听工作区目录:', root)
    } catch (e) {
      logToFile('[workspace-fs] 监听启动失败:', e instanceof Error ? e.message : String(e))
    }
  }

  unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* 忽略 */
      }
      this.watcher = null
    }
    this.watchRoot = ''
  }

  /** 立即向渲染层推送一次变化（打开/切换文件夹后主动刷新用） */
  notifyChanged(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      const w = this.getWindow()
      if (w && !w.isDestroyed()) w.webContents.send('workspace:changed', this.root)
    }, WATCH_DEBOUNCE_MS)
  }
}
