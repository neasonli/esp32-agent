/**
 * 应用外壳：顶栏导航（右上角，与窗口控制按钮同排）+ 全屏三栏工作区
 */
import { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { useT } from './i18n'
import { MenuBar } from './components/MenuBar'
import { HomeView } from './views/HomeView'
import { TaskDetailView } from './views/TaskDetailView'
import { WorkspaceView } from './views/WorkspaceView'
import { SettingsView } from './views/SettingsView'

export default function App(): JSX.Element {
  const { view, setView, setKernelStatus, activeTaskId } = useAppStore()
  const t = useT()

  useEffect(() => {
    window.lcode.getKernelStatus().then((s) => s && setKernelStatus(s))
    const offStatus = window.lcode.onKernelStatus(setKernelStatus)
    return () => offStatus()
  }, [setKernelStatus])

  const inTaskArea = view === 'task' || view === 'home'

  /**
   * 任务导航（保留现场）：
   * - 在任务详情 → 点"任务" = 回任务列表
   * - 在设置 → 点"任务" = 回到之前的任务详情（不丢现场）
   * - 工作区/首页 → 任务列表
   */
  const goTasks = (): void => {
    if (view === 'task') {
      setView('home')
    } else if (view === 'settings' && activeTaskId) {
      setView('task')
    } else {
      setView('home')
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* 顶栏：左侧自定义菜单栏(文件/编辑/视图)，右侧导航；窗口按钮由 titleBarOverlay 叠加在最右 */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card pl-1 pr-[150px] [-webkit-app-region:drag] select-none">
        <MenuBar />
        <nav className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <button
            onClick={goTasks}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              inTaskArea ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
            }`}
          >
            🏠 {t('navTasks')}
          </button>
          <button
            onClick={() => setView('workspace')}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              view === 'workspace' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
            }`}
          >
            📁 {t('navWorkspace')}
          </button>
          <button
            onClick={() => setView('settings')}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              view === 'settings' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
            }`}
          >
            ⚙️ {t('navSettings')}
          </button>
        </nav>
      </header>

      {/* 主体：任务详情/工作区 = 全屏三栏；首页/设置 = 居中滚动页 */}
      <main
        className={`min-h-0 flex-1 ${
          view === 'task' || view === 'workspace' ? 'overflow-hidden' : 'overflow-y-auto'
        }`}
      >
        {view === 'home' ? (
          <HomeView />
        ) : view === 'task' ? (
          <TaskDetailView />
        ) : view === 'workspace' ? (
          <WorkspaceView />
        ) : (
          <SettingsView />
        )}
      </main>
    </div>
  )
}
