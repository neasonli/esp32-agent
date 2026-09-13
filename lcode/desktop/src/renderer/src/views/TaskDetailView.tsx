/**
 * 任务详情：三栏 IDE 布局（V1.5 4.2.1/4.2.2）
 *
 *   [源码文件树] [中间内容窗] [Agent 聊天框]
 *   源码树与聊天框可左右对调（设置页 layout，持久化）；分隔条可鼠标拖拽调宽（ThreePaneLayout）
 * 所有"点击打开"（文件/产物）都在中间窗显示。
 */
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { FileTreePane } from '../components/FileTreePane'
import { ContentView, type OpenItem } from '../components/ContentView'
import { TaskChatPane } from '../components/TaskChatPane'
import { ThreePaneLayout } from '../components/ThreePaneLayout'
import type { FileContent } from '../../../shared/types'

export function TaskDetailView(): JSX.Element {
  const { activeTaskId } = useAppStore()

  const [openItem, setOpenItem] = useState<OpenItem | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [fileErr, setFileErr] = useState('')

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
    // 产物（二进制）在中间窗以提示展示
    setOpenItem({ kind: 'artifact', path, name, size_kb: sizeKb })
    setFile(null)
    setFileErr('')
  }, [])

  // 切换任务 → 中间窗关闭上一个任务的打开文件（避免残留旧内容显示“无法读取”）
  useEffect(() => {
    setOpenItem(null)
    setFile(null)
    setFileErr('')
  }, [activeTaskId])

  if (!activeTaskId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        未选择任务
      </div>
    )
  }

  // 中间内容窗
  const contentViewShell = (
    <div className="h-full min-w-0">
      <ContentView item={openItem} file={file} error={fileErr} onClose={() => setOpenItem(null)} />
    </div>
  )

  // 三栏（源码树 | 内容窗 | 任务聊天）：分隔条可鼠标拖拽调宽（与工作区视图同一实现）
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
          <TaskChatPane taskId={activeTaskId} onOpenArtifact={openArtifact} />
        </div>
      }
    />
  )
}
