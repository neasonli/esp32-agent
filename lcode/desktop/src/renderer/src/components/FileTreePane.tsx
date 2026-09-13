/**
 * 工程源码文件树（左/右栏，V1.5 4.2.1 只读）
 *
 * 层级树：根 = 当前工作区目录（始终显示），
 * 每个子文件夹前面有 > / ⌄ 箭头，点击原地展开/收起（惰性加载子项），
 * 不会再把子文件夹"重新生根"顶替整棵树（此前回不去的根因）。
 *
 * 数据源：主进程本地 fs（`workspace:listFiles`，见 main/workspace-fs.ts）——
 * 「文件→打开文件夹」会重启内核（冷启动 30~60s），旧实现走内核 HTTP 在重启窗口必失败，
 * 用户必须手点 ⟳ 才看到目录（实测 bug）；本地 fs 打开即显示。
 *
 * 自动刷新：主进程 `fs.watch` 递归监听工作区，内容变化去抖推送 `workspace:changed`，
 * 本组件据此重载根 + 重新拉取已展开目录（保留展开状态）；工作区切换（store workspaceRoot）
 * 也会立即重载。因而已移除「⟳ 刷新」与「📦 导出 zip」两个按钮（用户 2026-09 拍板）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../../shared/types'
import { en, useT, zh } from '../i18n'
import { useAppStore } from '../stores/useAppStore'

interface Props {
  initialDir: string
  onOpenFile: (path: string, name: string) => void
}

/**
 * 异步回调里的取词（不进 useCallback 依赖）：
 * useT() 每次渲染都返回新函数，若放进依赖会让 loadRoot 每次渲染都变
 * → useEffect 反复触发 → 无限重载循环。故异步/副作用代码按需读当前语言。
 */
function tNow(key: 'treeLoadFailed' | 'treeRetryHint' | 'treeLoading' | 'treeEmpty' | 'treeOpenExplorer'): string {
  return useAppStore.getState().lang === 'zh' ? zh[key] : en[key]
}

export function FileTreePane({ initialDir, onOpenFile }: Props): JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [err, setErr] = useState('')
  const [rootPath, setRootPath] = useState('')
  // 层级树状态：expanded=已展开目录集合；children=各目录子项缓存（undefined=未加载）
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, FileEntry[] | undefined>>({})
  const [childErr, setChildErr] = useState<Record<string, string>>({})
  const tr = useT()
  // 工作区根（打开文件夹/切换项目时变化）→ 立即重载；也用于根标题先行显示
  const workspaceRoot = useAppStore((s) => s.workspaceRoot)
  // 已展开目录集合的 ref：变化推送回调里读取最新值（避免闭包过期）
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  /** 加载根目录（本地 fs 即时返回；失败只提示，无内核重启窗口需长重试） */
  const loadRoot = useCallback(async (): Promise<void> => {
    setErr('')
    try {
      const r = await window.lcode.listWorkspaceFiles(initialDir)
      if (!r) {
        setErr(tNow('treeLoadFailed'))
        setEntries([])
        return
      }
      setRootPath(r.path)
      setEntries(r.entries)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setEntries([])
    }
  }, [initialDir])

  /** 惰性加载某个目录的子项；失败缓存错误、再次展开可重试 */
  const loadChildren = useCallback(
    (dir: string): void => {
      setChildErr((prev) => ({ ...prev, [dir]: '' }))
      void (async () => {
        try {
          const r = await window.lcode.listWorkspaceFiles(dir)
          if (!r) {
            setChildErr((prev) => ({ ...prev, [dir]: tNow('treeLoadFailed') }))
            return
          }
          setChildren((prev) => ({ ...prev, [dir]: r.entries }))
        } catch (e) {
          setChildErr((prev) => ({
            ...prev,
            [dir]: e instanceof Error ? e.message : String(e)
          }))
        }
      })()
    },
    []
  )

  /** 全量重载：根 + 已展开目录（保留展开状态，内容变化时不打断用户） */
  const reloadAll = useCallback((): void => {
    void loadRoot()
    setChildErr({})
    setChildren({})
    for (const dir of expandedRef.current) loadChildren(dir)
  }, [loadRoot, loadChildren])

  // 初次挂载 + 工作区切换（打开文件夹/切换项目）→ 立即重载
  useEffect(() => {
    void loadRoot()
  }, [loadRoot, workspaceRoot])

  // 工作区内容变化（主进程 fs.watch 推送）→ 立即刷新
  useEffect(() => {
    return window.lcode.onWorkspaceChanged(() => reloadAll())
  }, [reloadAll])

  function toggleDir(dir: string): void {
    const isOpen = expanded.has(dir)
    const next = new Set(expanded)
    if (isOpen) {
      next.delete(dir)
    } else {
      next.add(dir)
      if (children[dir] === undefined) loadChildren(dir) // 含失败重试（再次展开）
    }
    setExpanded(next)
  }

  function pathLabel(p: string): string {
    const idx = p.indexOf('\\main')
    return idx >= 0 ? p.slice(idx + 1) : p.split('\\').pop() ?? p
  }

  function renderNode(e: FileEntry, depth: number): JSX.Element {
    const pad = { paddingLeft: `${depth * 14 + 6}px` }
    if (e.type === 'file') {
      return (
        <button
          key={e.path}
          className="flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent"
          style={pad}
          onClick={() => onOpenFile(e.path, e.name)}
        >
          <span className="w-3 shrink-0" />
          <span className="shrink-0">📄</span>
          <span className="truncate">{e.name}</span>
        </button>
      )
    }
    const isOpen = expanded.has(e.path)
    const kids = children[e.path]
    const eErr = childErr[e.path]
    return (
      <div key={e.path}>
        <button
          className="flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
          style={pad}
          onClick={() => toggleDir(e.path)}
        >
          <span className="w-3 shrink-0 text-[10px] text-muted-foreground">
            {isOpen ? '⌄' : '>'}
          </span>
          <span className="shrink-0">📁</span>
          <span className="truncate">{e.name}</span>
        </button>
        {isOpen ? (
          <div>
            {eErr ? (
              <div
                className="px-2 py-0.5 text-[11px] text-red-600"
                style={{ paddingLeft: `${depth * 14 + 18}px` }}
              >
                {eErr}
                {tr('treeRetryHint')}
              </div>
            ) : null}
            {kids === undefined ? (
              <div
                className="px-2 py-0.5 text-[11px] text-muted-foreground"
                style={{ paddingLeft: `${depth * 14 + 18}px` }}
              >
                {tr('treeLoading')}
              </div>
            ) : null}
            {(kids ?? []).map((k) => renderNode(k, depth + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
        {/* 根目录显示真实路径（工作区根，始终为树顶）；未加载完先用 store 的工作区名占位 */}
        <span className="truncate" title={rootPath || (workspaceRoot ?? '')}>
          📁 {rootPath ? pathLabel(rootPath) : workspaceRoot ? pathLabel(workspaceRoot) : '…'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className="rounded px-1.5 hover:bg-accent"
            title={tr('treeOpenExplorer')}
            onClick={() => void window.lcode.openWorkspaceFolder()}
          >
            📂
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {err ? <div className="px-2 py-1 text-xs text-red-600">{err}</div> : null}
        {entries.map((e) => renderNode(e, 0))}
        {entries.length === 0 && !err ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">{tr('treeEmpty')}</div>
        ) : null}
      </div>
    </div>
  )
}
