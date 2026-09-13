/**
 * LCode Electron 主进程入口（W1 骨架）
 *
 * 职责：
 * 1. 创建主窗口（安全默认：contextIsolation + sandbox + preload 白名单）
 * 2. 拉起/守护 Agent 内核（KernelManager）
 * 3. 事件轮询推送（EventPoller）
 * 4. 暴露最小 IPC 接口给渲染进程
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { KernelManager } from './kernel-manager'
import { PlannerManager } from './planner-manager'
import { IpClient, KernelHttpError } from './ipc-client'
import { EventPoller } from './event-poller'
import { WorkspaceFs } from './workspace-fs'
import { logToFile } from './logger'
import {
  COMPONENT_NAMES,
  allComponentStatus,
  applyComponentEnv,
  autoInstallBundledComponents,
  bundledZipFor,
  componentDir,
  componentEnv,
  componentStatus,
  pickAndInstallComponent,
  type ComponentName
} from './components'

// 全局兜底：未捕获异常/拒绝全部落盘（弹窗可能截断信息，日志保留完整证据）
process.on('uncaughtException', (err) => {
  logToFile('[uncaughtException]', err instanceof Error ? err.stack ?? String(err) : String(err))
})
process.on('unhandledRejection', (reason) => {
  logToFile('[unhandledRejection]', String(reason))
})

let win: BrowserWindow | null = null
let kernel: KernelManager | null = null
let planner: PlannerManager | null = null
let ipc: IpClient | null = null
let poller: EventPoller | null = null
/** 工作区目录服务（本地 fs 列目录/读文件 + 变更监听推送；不依赖内核，见 workspace-fs.ts） */
let workspaceFs: WorkspaceFs | null = null

/** 内核默认 outputs 目录（未自定义工作目录时的工作区根） */
function defaultOutputsDir(): string {
  return path.join(app.getAppPath(), '..', 'kernel', 'outputs')
}

/** 官网地址（「帮助 → 打开官网」；固定在此，不接受渲染层传入的 URL） */
const OFFICIAL_SITE_URL = 'https://www.lcode.ai.info'

/** 「收款码」目录候选（按顺序取第一个存在的） */
function paymentQrDirs(): string[] {
  const dirs: string[] = []
  if (process.env.LCODE_QR_DIR) dirs.push(process.env.LCODE_QR_DIR)
  // dev：app.getAppPath() = <repo>/lcode/desktop → ../.. = <repo>（收款码在仓库根）
  dirs.push(path.join(app.getAppPath(), '..', '..', '收款码'))
  dirs.push(path.join(app.getAppPath(), '..', '..', '..', '收款码'))
  // 打包：extraResources 放到 resources 下
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, '收款码'))
  return dirs
}

/**
 * 读取收款码图片（帮助 →「支持开发者」弹窗用）。
 * 只读固定目录里的图片文件、单张上限 5MB、最多 6 张；返回 data URL（渲染层直接 <img> 展示）。
 */
function readPaymentQr(): { dir: string; images: { name: string; dataUrl: string }[] } {
  const exts: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
  }
  const MAX_BYTES = 5 * 1024 * 1024
  const candidates = paymentQrDirs()
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue
      const images = fs
        .readdirSync(dir)
        .filter((f) => exts[path.extname(f).toLowerCase()] !== undefined)
        .sort()
        .slice(0, 6)
        .flatMap((f) => {
          const file = path.join(dir, f)
          try {
            const stat = fs.statSync(file)
            if (!stat.isFile() || stat.size > MAX_BYTES) return []
            return [{
              name: f,
              dataUrl: `data:${exts[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(file).toString('base64')}`
            }]
          } catch (e) {
            logToFile('[help] 收款码读取失败:', f, e instanceof Error ? e.message : String(e))
            return []
          }
        })
      if (images.length > 0) return { dir, images }
    } catch (e) {
      logToFile('[help] 收款码目录扫描失败:', dir, e instanceof Error ? e.message : String(e))
    }
  }
  logToFile('[help] 未找到收款码图片，候选目录:', candidates.join(' | '))
  return { dir: candidates[0] ?? '', images: [] }
}

/** 当前工作区根：自定义工作目录优先，否则内核默认 outputs */
function workspaceRootDir(): string {
  return kernel?.workspaceDirValue ?? defaultOutputsDir()
}

/** 中文应用菜单（替换 Electron 默认英文 File/Edit 菜单；隐藏标题栏下不显示，仅提供快捷键） */
function setupChineseMenu(): void {
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        ...(isDev
          ? ([{ role: 'toggleDevTools', label: '开发者工具' }] as Electron.MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 安全 IPC 包装：内核未就绪/请求失败时记录日志并返回 null，不再抛到终端刷屏 */
function safeIpc(fn: (...args: any[]) => Promise<unknown> | unknown) {
  return async (...args: unknown[]): Promise<unknown> => {
    try {
      return await fn(...args)
    } catch (e) {
      logToFile('[ipc] 调用失败:', e instanceof Error ? e.message : String(e))
      return null
    }
  }
}

/**
 * 窗口/任务栏图标。
 *
 * 开发模式下 Electron 默认用自带图标（任务栏显示的就不是 LCode），所以必须显式指定；
 * 打包后 exe 自带图标（electron-builder 取 build/icon.ico），这里只作兜底：若把图标随
 * extraResources 放到了 resources/ 下也能命中。
 */
function appIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon-256.png'), path.join(process.resourcesPath, 'icon.png')]
    : [
        path.join(app.getAppPath(), 'build', 'icon-256.png'),
        path.join(app.getAppPath(), 'build', 'icon.png')
      ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return undefined
}

function createWindow(): void {
  const icon = appIconPath()
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'LCode',
    show: false,
    // 任务栏/窗口图标：缺省 Electron 自带图标（用户看到的就是"没有 LCode 的小图标"）
    ...(icon ? { icon } : {}),
    // 隐藏系统标题栏，让顶栏与窗口控制按钮同排（Windows/macOS）
    titleBarStyle: 'hidden',
    // Windows: 以叠加层恢复 最小化/最大化/关闭(- □ x) 按钮
    titleBarOverlay:
      process.platform === 'win32'
        ? { height: 40, color: '#ffffff', symbolColor: '#333333' }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  logToFile('[window] 已创建，图标 =', icon ?? '(未找到，将使用 Electron 默认图标)')

  win.on('ready-to-show', () => {
    logToFile('[window] ready-to-show 触发，执行 show()')
    win?.show()
  })
  win.on('show', () => logToFile('[window] 已显示 show 事件'))
  win.webContents.on('did-finish-load', () => logToFile('[window] 渲染页加载完成 did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logToFile('[window] 渲染页加载失败 did-fail-load code=', code, desc, url)
    // 即使加载失败也显示窗口（避免"无窗口"假死）
    if (win && !win.isVisible()) win.show()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    logToFile('[window] 渲染进程异常 render-process-gone:', JSON.stringify(details))
  })
  // 兜底：ready-to-show 迟迟不触发（渲染页加载卡住）时 3 秒后强制显示窗口
  setTimeout(() => {
    if (win && !win.isVisible()) {
      logToFile('[window] ready-to-show 3 秒未触发，兜底显示窗口')
      win.show()
    }
  }, 3000)
  win.on('close', () => logToFile('[window] close 事件'))
  win.on('closed', () => logToFile('[window] closed 事件'))

  // 开发模式加载 vite dev server，生产模式加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function setupIpc(): void {
  ipcMain.handle('kernel:getStatus', () => kernel?.info ?? null)
  ipcMain.handle('kernel:restart', safeIpc(async () => {
    await kernel?.stop()
    await kernel?.start()
    return kernel?.info ?? null
  }))
  ipcMain.handle('task:submit', safeIpc(async (_evt, requirement: string, workspaceId = '') => {
    if (!ipc || !kernel) throw new Error('内核未就绪')
    const result = await ipc.submitTask(requirement, workspaceId)
    poller?.start(result.task_id)
    return result
  }))
  ipcMain.handle('task:cancel', safeIpc(async (_evt, taskId: string) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.cancelTask(taskId)
  }))
  ipcMain.handle('task:resume', safeIpc(async (_evt, taskId: string, fullRestart: boolean) => {
    if (!ipc) throw new Error('内核未就绪')
    const result = await ipc.resumeTask(taskId, fullRestart)
    poller?.start(taskId)
    return result
  }))
  ipcMain.handle('task:delete', safeIpc(async (_evt, taskIds: string[]) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.deleteTasks(taskIds)
  }))
  ipcMain.handle('task:stopPoll', (_evt, taskId: string) => {
    poller?.stop(taskId)
  })

  // 会话记录 / 工程源码浏览 / 配置（V1.5）——内核未就绪时安全返回 null，不抛到终端
  ipcMain.handle('kernel:getConversations', safeIpc(() => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.getConversations()
  }))
  ipcMain.handle('kernel:getConversation', safeIpc((_evt, taskId: string) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.getConversation(taskId)
  }))
  // 对话式 Agent（阶段3 Phase1）：对话由规划器进程承载（规划循环），
  // 事件/消息/状态由规划器写入内核（task_id=session_id），桌面端轮询内核不变。
  // 注意：不走 safeIpc（不吞错）——失败原因必须精确传回渲染层（同 chat:fork）：
  //   E_PLANNER_NOT_READY=规划器未就绪 / E_KERNEL_UNREACHABLE=内核连不上 / 其它 = planner detail
  ipcMain.handle('chat:send', async (_evt, message: string, sessionId = '', fullAccess?: boolean, planMode?: boolean, reasoningEffort?: string, cwd?: string, delivery?: 'queue' | 'steer') => {
    // 精简模式兜底：没有规划器运行时（打包版未随包）→ 交给内核对话 Agent
    const slim = chatSlimMode()
    if (slim.slim) {
      logToFile('[chat] 走精简模式，原因 =', slim.reason)
      return sendViaKernel(message, sessionId, fullAccess, cwd)
    }
    if (!planner) throw new Error('E_PLANNER_NOT_READY')
    // 规划器冷启动中：等一会儿再发（否则会直接 fetch failed 甩给用户）
    if (!(await waitPlannerReady(20_000))) {
      logToFile('[chat] 规划器未在 20s 内就绪（status =', planner.info.status, '）→ 本次走精简模式')
      return sendViaKernel(message, sessionId, fullAccess, cwd)
    }
    try {
      // 工作区绑定：渲染层传当前工作区根目录；空则回落到主进程工作目录
      // （未传时后台新建的会话也应归属当前工作区，避免散落到默认 outputs）
      const boundCwd = cwd || kernel?.workspaceDirValue || undefined
      const result = await planner.chat(message, sessionId, fullAccess, planMode, reasoningEffort, boundCwd, delivery)
      poller?.start(result.session_id) // 事件流：task_id = session_id（仍轮询内核）
      return { ...result, mode: 'planner' as const }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('fetch failed') || /ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(msg)) {
        throw new Error('E_KERNEL_UNREACHABLE')
      }
      throw new Error(msg)
    }
  })
  /** 当前对话承载方式（渲染层据此提示"精简模式"并隐藏规划器专属控件） */
  ipcMain.handle('chat:mode', safeIpc(async () => {
    const m = chatSlimMode()
    return {
      mode: m.slim ? 'slim' : 'planner',
      reason: m.reason,
      planner_status: planner?.info.status ?? 'stopped',
      planner_available: planner?.available ?? false,
      planner_error: planner?.info.lastError ?? ''
    }
  }))
  // 运行中待发送队列（DSH QueueDock 同源）：查询 + 删除一条
  // 精简模式：内核对话 Agent 无 inbox 队列（同一会话串行）→ 返回空表，界面不显示队列坞
  ipcMain.handle('chat:queue', safeIpc((_evt, sessionId: string) => {
    if (chatSlimMode().slim) return { session_id: sessionId, items: [], supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.getChatQueue(sessionId)
  }))
  ipcMain.handle('chat:queueRemove', safeIpc((_evt, sessionId: string, messageId: string) => {
    if (chatSlimMode().slim) return { session_id: sessionId, message_id: messageId, removed: false, supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.removeChatQueueItem(sessionId, messageId)
  }))
  ipcMain.handle('chat:cancel', safeIpc((_evt, sessionId: string) => {
    // 精简模式：内核侧同名的停止接口（每轮 LLM 调用前/每个工具执行前检查标志）
    if (chatSlimMode().slim) {
      if (!ipc) throw new Error('内核未就绪')
      return ipc.cancelChat(sessionId)
    }
    if (!planner) throw new Error('规划器未就绪')
    return planner.cancelChat(sessionId)
  }))
  // 阶段4 W4 · 会话分支（复制锚点前上下文开新对话；内核 + 规划器双侧登记）
  // 注意：不走 safeIpc（不吞错）——失败原因必须精确传回渲染层：
  //   E_PLANNER_NOT_READY=规划器未就绪 / E_KERNEL_UNREACHABLE=内核连不上 /
  //   E_SESSION_NOT_REGISTERED=会话不在当前规划器内（死会话）/ 其它 = planner 消息里已带内核 detail
  ipcMain.handle('chat:fork', async (_evt, sessionId: string, atMessageId: number) => {
    // 精简模式：分支走内核侧实现（同样是复制前缀开新会话），语义一致
    if (chatSlimMode().slim) {
      if (!ipc) throw new Error('E_KERNEL_UNREACHABLE')
      return ipc.forkChat(sessionId, atMessageId)
    }
    if (!planner) throw new Error('E_PLANNER_NOT_READY')
    try {
      return await planner.forkChat(sessionId, atMessageId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('fetch failed') || /ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(msg)) {
        throw new Error('E_KERNEL_UNREACHABLE')
      }
      if (msg.includes('源会话不在规划器中') || msg.includes('E_SESSION_NOT_REGISTERED')) {
        throw new Error('E_SESSION_NOT_REGISTERED')
      }
      throw new Error(msg)
    }
  })
  ipcMain.handle('chat:access', safeIpc((_evt, sessionId: string, fullAccess: boolean) => {
    // 精简模式：权限由内核会话表承载（/api/chat_access），语义等价
    if (chatSlimMode().slim) {
      if (!ipc) throw new Error('内核未就绪')
      return ipc.setChatAccess(sessionId, fullAccess)
    }
    if (!planner) throw new Error('规划器未就绪')
    return planner.setChatAccess(sessionId, fullAccess)
  }))
  // 推理等级（reasoning effort）：会话级即时切换（off/high/max），不随消息发送也可生效
  // 精简模式：内核对话 Agent 无此概念 → 回显请求值（不报错，界面不弹错）
  ipcMain.handle('chat:effort', safeIpc((_evt, sessionId: string, reasoningEffort: string) => {
    if (chatSlimMode().slim) return { session_id: sessionId, reasoning_effort: reasoningEffort, supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.setChatEffort(sessionId, reasoningEffort)
  }))
  // 读取会话当前推理等级（规划器登记内存态；无记录返回 'high'）
  ipcMain.handle('chat:effortGet', safeIpc(async (_evt, sessionId: string) => {
    if (chatSlimMode().slim) return 'high'
    if (!planner) throw new Error('规划器未就绪')
    const sessions = ((await planner.listSessions())?.sessions) ?? []
    return sessions.find((s) => s.session_id === sessionId)?.reasoning_effort ?? 'high'
  }))
  // 会话 plan-mode 当前状态（planner agent 权威值，PlanChip 仅开启时出现）
  ipcMain.handle('chat:planState', safeIpc(async (_evt, sessionId: string) => {
    if (chatSlimMode().slim) return { session_id: sessionId, plan_active: false, supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.getChatPlanState(sessionId)
  }))
  // Plan-mode 即时切换（/plan、/plan off、PlanChip ✕：直接翻转 agent 状态）
  ipcMain.handle('chat:planMode', safeIpc(async (_evt, sessionId: string, planActive: boolean) => {
    if (chatSlimMode().slim) {
      // 精简模式的对话 Agent 没有 plan-mode 状态机：明确回报"不支持"，界面据此不起琥珀色 pill
      logToFile('[chat] 精简模式忽略 plan-mode 切换（请求 =', planActive, '）')
      return { session_id: sessionId, plan_active: false, plan_pending: false, outcome: 'unsupported', supported: false }
    }
    if (!planner) throw new Error('规划器未就绪')
    return planner.setChatPlanMode(sessionId, planActive)
  }))
  // 阶段4 W4 · 删除对话会话（清理不在规划器内、无法继续/分支的死会话；不可恢复）
  ipcMain.handle('chat:delete', safeIpc(async (_evt, sessionIds: string[]) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.deleteChatSessions(sessionIds)
  }))
  // 阶段3 Phase2：会话确认结束后显式烧录（防误烧）——桌面弹窗确认端口 → 规划器 → 内核执行
  // 精简模式：内核对话 Agent 自己会烧录（无需规划器二次确认）→ 回报 unsupported，界面不弹确认框
  ipcMain.handle('flash:confirm', safeIpc(async (_evt, sessionId: string, projectDir: string, port: string) => {
    if (chatSlimMode().slim) {
      logToFile('[chat] 精简模式：忽略烧录二次确认（内核对话 Agent 自行处理）session =', sessionId)
      return { session_id: sessionId, status: 'unsupported' }
    }
    if (!planner) throw new Error('规划器未就绪')
    const result = await planner.confirmFlash(sessionId, projectDir, port)
    poller?.start(sessionId) // 烧录事件流：task_id = session_id（仍轮询内核）
    return result
  }))
  ipcMain.handle('flash:dismiss', safeIpc((_evt, sessionId: string) => {
    if (chatSlimMode().slim) return { session_id: sessionId, status: 'unsupported' }
    if (!planner) throw new Error('规划器未就绪')
    return planner.dismissFlash(sessionId)
  }))
  // M3 · 人机交互（approval/questions）：桌面轮询取件与应答
  // 精简模式：内核对话 Agent 的审批走内核自己的策略（不产生 planner 交互队列）→ 返回空表
  ipcMain.handle('planner:interactions', safeIpc((_evt, sessionId?: string) => {
    if (chatSlimMode().slim) return { interactions: [], supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.listInteractions(sessionId)
  }))
  ipcMain.handle('planner:interactionsAnswer', safeIpc((
    _evt,
    id: string,
    answer: { kind: 'approval'; outcome: string } | { kind: 'questions'; answers: { id: string; selected: string[]; custom?: string }[] },
  ) => {
    if (chatSlimMode().slim) return { answered: false, supported: false }
    if (!planner) throw new Error('规划器未就绪')
    return planner.answerInteraction(id, answer)
  }))
  ipcMain.handle('kernel:getChatSessions', safeIpc(() => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.getChatSessions()
  }))
  /**
   * 会话详情：**必须区分「会话不存在(404)」与「内核暂时不可达」**——
   * 旧实现用 safeIpc 包裹，任何失败都变成 null，而渲染层把 null 当「会话不存在」立即回落空会话；
   * 「文件→打开文件夹」会重启内核（冷启动 30~60s），于是打开已有对话的文件夹时永远看不到历史
   * （草稿能出来、消息不出来——2026-09 实测）。
   * 现在：404 → null（真的是死会话，渲染层回落）；其它异常 → 抛 E_KERNEL_UNREACHABLE，
   * 渲染层据此重试直到内核就绪。
   */
  ipcMain.handle('kernel:getChatSession', async (_evt, sessionId: string) => {
    if (!ipc) throw new Error('E_KERNEL_NOT_READY')
    try {
      return await ipc.getChatSession(sessionId)
    } catch (e) {
      if (e instanceof KernelHttpError && e.status === 404) return null
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('内核未就绪')) throw new Error('E_KERNEL_NOT_READY')
      throw new Error('E_KERNEL_UNREACHABLE')
    }
  })
  // 工作区文件浏览：主进程本地 fs（不走内核 HTTP）——「打开文件夹」会重启内核（冷启动 30~60s），
  // 旧实现走内核接口在重启窗口必失败，用户必须手点刷新才看到目录（实测 bug）。
  // 本地 fs 与内核 _safe_resolve 同口径（越界拒绝），且支持 fs.watch 变化推送。
  ipcMain.handle('workspace:listFiles', safeIpc((_evt, dir: string) => {
    if (!workspaceFs) throw new Error('工作区服务未就绪')
    return workspaceFs.list(dir ?? '')
  }))
  ipcMain.handle('workspace:readFile', safeIpc((_evt, filePath: string) => {
    if (!workspaceFs) throw new Error('工作区服务未就绪')
    return workspaceFs.read(filePath ?? '')
  }))
  ipcMain.handle('kernel:getKernelConfig', safeIpc(() => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.getKernelConfig()
  }))
  /**
   * 环境配置（ESP-IDF + LLM）读写。
   * 读：内核 /api/config 为准（含 idf_py 解析结果）；内核未就绪时回退到本地持久化文件。
   * 写：先落盘（userData/kernel-env.json，保证重启后仍在），再热更新到内核（立即生效）。
   */
  ipcMain.handle('kernel:getEnvConfig', safeIpc(async () => {
    const saved = readKernelEnv()
    if (!ipc || !kernel || kernel.info.status !== 'running') {
      logToFile('[env] 内核未就绪，返回本地持久化配置（idf_path =', saved.idf_path ?? '-', '）')
      return { ...saved, idf_py: null, kernel_ready: false }
    }
    const live = await ipc.getKernelConfig()
    // 证据留存：设置页读到的 ESP-IDF 状态（idf_py 是否解析成功）看这一行
    logToFile(
      '[env] 环境配置: idf_path =',
      String(live['idf_path'] ?? '-'),
      '| idf_py =',
      String(live['idf_py'] ?? '-'),
      '| target =',
      String(live['idf_target'] ?? '-')
    )
    return { ...saved, ...live, idf_py: live['idf_py'] ?? null, kernel_ready: true }
  }))
  ipcMain.handle('kernel:updateEnvConfig', safeIpc(async (_evt, cfg: Record<string, unknown>) => {
    const before = readKernelEnv()
    const patch: KernelEnvStore = {}
    const keys: (keyof KernelEnvStore)[] = [
      'idf_path',
      'idf_tools_path',
      'idf_python_env_path',
      'idf_target',
      'llm_api_key',
      'llm_base_url',
      'llm_model',
      'llm_temperature'
    ]
    for (const k of keys) {
      if (cfg[k] !== undefined) (patch as Record<string, unknown>)[k] = cfg[k]
    }
    patchKernelEnv(patch)
    const after = readKernelEnv()
    const llmChanged = (['llm_api_key', 'llm_base_url', 'llm_model', 'llm_temperature'] as const).some(
      (k) => before[k] !== after[k]
    )
    logToFile('[env] 已保存环境配置:', Object.keys(patch).join(','), '| LLM 有变化 =', llmChanged)
    const out: Record<string, unknown> = { status: 'saved', kernel_ready: false, ...after }
    if (ipc && kernel && kernel.info.status === 'running') {
      Object.assign(out, await ipc.updateLlmConfig(cfg))
      // 内核侧解析出的 idf.py（保存后立刻回报，界面可即时显示"已找到/未找到"）
      out.kernel_ready = true
    }
    out.planner_restarting = llmChanged ? restartPlannerForConfig('环境配置里的 LLM 项已更改') : false
    return out
  }))
  /** ESP-IDF 环境检测（deep=true 会真跑 idf.py --version，较慢） */
  ipcMain.handle('kernel:probeIdf', safeIpc(async (_evt, deep = false) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.probeEnv(Boolean(deep))
  }))
  /** 拉取当前 LLM 端点的可用模型列表（把"手填模型名"变成"下拉选择"） */
  /** 组件载荷（ESP-IDF / 知识库）状态与安装 */
  ipcMain.handle('components:status', safeIpc(() => allComponentStatus()))
  ipcMain.handle('components:install', safeIpc(async (_evt, name: ComponentName) => {
    if (!COMPONENT_NAMES.includes(name)) throw new Error(`未知组件: ${name}`)
    const res = await pickAndInstallComponent(name)
    if (res === null) return { ok: false, cancelled: true, message: '已取消' }
    logToFile('[components] 手动安装', name, ':', res.message)
    if (res.ok) {
      const env = applyComponentEnv()
      if (name === 'esp-idf') {
        const idf = componentEnv('esp-idf')
        patchKernelEnv({
          idf_path: idf.IDF_PATH ?? '',
          idf_tools_path: idf.IDF_TOOLS_PATH ?? '',
          idf_python_env_path: idf.IDF_PYTHON_ENV_PATH ?? ''
        })
        if (ipc && kernel?.info.status === 'running') {
          await ipc.updateLlmConfig({
            idf_path: idf.IDF_PATH ?? '',
            idf_tools_path: idf.IDF_TOOLS_PATH ?? '',
            idf_python_env_path: idf.IDF_PYTHON_ENV_PATH ?? ''
          })
        }
      }
      logToFile('[components] 安装后环境变量:', Object.keys(env).join(', '))
    }
    return res
  }))
  ipcMain.handle('components:openDir', safeIpc(async (_evt, name: ComponentName) => {
    const dir = componentDir(name)
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  }))
  ipcMain.handle('kernel:listModels', safeIpc(async () => {
    if (!ipc) throw new Error('内核未就绪')
    const r = await ipc.listLlmModels()
    logToFile(
      '[llm] 模型列表: source =',
      String(r['source'] ?? '-'),
      '| 端点登记 =',
      Array.isArray(r['endpoint_models']) ? (r['endpoint_models'] as unknown[]).join('/') : '-',
      '| 当前值在端点清单内 =',
      r['current_from_endpoint']
    )
    return r
  }))
  /** 测试 LLM 连接（一次极小真实调用；返回 served_model = 服务端实际服务的模型） */
  ipcMain.handle('kernel:probeLlm', safeIpc(async (_evt, model?: string) => {
    if (!ipc) throw new Error('内核未就绪')
    const r = await ipc.probeLlm(model)
    logToFile(
      '[llm] 连接测试: 请求 =',
      String(r['requested_model'] ?? '-'),
      '| 实际 =',
      String(r['served_model'] ?? '-'),
      '| ok =',
      r['ok'],
      r['error'] ? `| ${String(r['error'])}` : ''
    )
    return r
  }))
  /**
   * 知识库状态（公开仓方案 A 的接缝投影）：
   * 内核 /api/health 的 kb_* 字段 → 界面据此区分「私有知识库已启用」与「通用模式（无手册检索）」。
   */
  ipcMain.handle('kernel:kbStatus', safeIpc(async () => {
    if (!ipc) throw new Error('内核未就绪')
    const h = await ipc.health()
    const kb = {
      kb_backend: String(h['kb_backend'] ?? 'unknown'),
      kb_available: Boolean(h['kb_available']),
      kb_docs: Number(h['kb_docs'] ?? 0),
      kb_note: h['kb_note'] ? String(h['kb_note']) : '',
      kb_store_dir: h['kb_store_dir'] ? String(h['kb_store_dir']) : '',
      kb_version: h['kb_version'] ? String(h['kb_version']) : ''
    }
    // 证据留存：「手册检索」为什么亮/灰，看这一行（stub = 公开版通用模式）
    logToFile(
      '[kb] 后端 =',
      kb.kb_backend,
      '| 可用 =',
      kb.kb_available,
      '| 向量数 =',
      kb.kb_docs,
      kb.kb_note ? `| ${kb.kb_note}` : ''
    )
    return kb
  }))
  ipcMain.handle('kernel:updateKernelConfig', safeIpc((_evt, cfg: { kernel_concurrency: number }) => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.updateLlmConfig({ kernel_concurrency: cfg.kernel_concurrency })
  }))
  /**
   * 规划器（真正跑对话的 DSH 进程）当前生效的模型与 Key 末 4 位。
   * 设置页用它把"我填的"和"实际在用的"并排显示 —— "设置不生效"这类问题一眼可见。
   */
  ipcMain.handle('planner:llmInfo', safeIpc(async () => {
    if (!planner) return null
    return planner.llmInfo()
  }))
  ipcMain.handle('kernel:updateLlmConfig', safeIpc(async (_evt, cfg: Record<string, unknown>) => {
    // 落盘（否则重启后丢；打包版没有 .env，丢了就每次都要重填 Key）
    const before = readKernelEnv()
    const patch: KernelEnvStore = {}
    if (typeof cfg['llm_api_key'] === 'string') patch.llm_api_key = cfg['llm_api_key']
    if (typeof cfg['llm_base_url'] === 'string') patch.llm_base_url = cfg['llm_base_url']
    if (typeof cfg['llm_model'] === 'string') patch.llm_model = cfg['llm_model']
    if (typeof cfg['llm_temperature'] === 'number') patch.llm_temperature = cfg['llm_temperature']
    if (Object.keys(patch).length > 0) patchKernelEnv(patch)
    const after = readKernelEnv()
    const llmChanged = (['llm_api_key', 'llm_base_url', 'llm_model', 'llm_temperature'] as const).some(
      (k) => before[k] !== after[k]
    )
    // 证据留存：设置页每次保存都留痕（此前这条路径不写日志，"保存了没生效"无从查证）
    logToFile(
      '[env] 已保存 LLM 配置:',
      Object.keys(patch).join(',') || '(空)',
      '| key =',
      keyTail(after.llm_api_key),
      '| model =',
      after.llm_model ?? '-',
      '| base =',
      after.llm_base_url ?? '-',
      '| 有变化 =',
      llmChanged
    )
    const out: Record<string, unknown> = { status: 'saved', kernel_ready: false, ...after }
    if (ipc && kernel && kernel.info.status === 'running') {
      Object.assign(out, await ipc.updateLlmConfig(cfg))
      out.kernel_ready = true
    } else {
      logToFile('[env] 内核未就绪：LLM 配置已落盘，内核就绪后自动补推')
    }
    if (out['model'] === undefined) out['model'] = after.llm_model ?? ''
    out.planner_restarting = llmChanged ? restartPlannerForConfig('LLM 配置已更改') : false
    return out
  }))
  ipcMain.handle('kernel:getWorkspaces', safeIpc(() => {
    if (!ipc) throw new Error('内核未就绪')
    return ipc.getWorkspaces()
  }))

  // 自定义菜单栏动作（隐藏标题栏后原生菜单不可见）
  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('app:reload', () => win?.reload())
  ipcMain.handle('app:devtools', () => win?.webContents.toggleDevTools())

  // 工作目录：文件夹选择器 + 设置（持久化到 userData/workspace.json）
  ipcMain.handle('app:pickDirectory', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  ipcMain.handle('app:setWorkspaceDir', async (_evt, dir: string | null) => {
    const file = path.join(app.getPath('userData'), 'workspace.json')
    try {
      fs.writeFileSync(file, JSON.stringify({ workspaceDir: dir }), 'utf-8')
    } catch (e) {
      logToFile('[workspace] 保存失败:', e instanceof Error ? e.message : String(e))
    }
    kernel?.setWorkspaceDir(dir)
    // 文件树根目录立即切到新工作区并刷新监听（不等内核重启：冷启动 30~60s，文件浏览是本地 fs）
    workspaceFs?.watch()
    workspaceFs?.notifyChanged()
    await kernel?.restart() // 重启内核使 --outputs 生效
    return dir
  })
  ipcMain.handle('app:getWorkspaceDir', () => getWorkspaceDir())

  // 文件菜单：打开工作目录（自定义工作目录或内核默认 outputs）
  ipcMain.handle(
    'app:openWorkspaceFolder',
    safeIpc(() => {
      const dir = workspaceRootDir()
      shell.openPath(dir)
      return dir
    })
  )

  // ── 帮助菜单 ──────────────────────────────────────────────────────────────
  /**
   * 「支持开发者」：读取本地「收款码」目录里的图片，转成 data URL 交给渲染层弹窗展示
   * （渲染层 sandbox + contextIsolation，不直接读磁盘；也不暴露任意路径读取能力）。
   * 目录解析：env 覆盖 → 仓库根（dev：desktop/../..）→ 打包 resources。
   */
  ipcMain.handle('app:paymentQr', safeIpc(() => readPaymentQr()))
  /** 「打开官网」：URL 固定在主进程（渲染层不传地址，避免被利用成任意链接跳板） */
  ipcMain.handle('app:openOfficialSite', safeIpc(async () => {
    await shell.openExternal(OFFICIAL_SITE_URL)
    logToFile('[help] 打开官网:', OFFICIAL_SITE_URL)
    return OFFICIAL_SITE_URL
  }))
}

/**
 * 一次性迁移：应用显示名从 "LCode" 改为 "LCode" 后，Electron 的 userData 目录也跟着变
 * （%APPDATA%\L-CODE → %APPDATA%\LCode）。把旧目录里的**设置文件**搬过来，避免用户
 * 看到"设置全没了"；Chromium 的缓存/本地存储不值得搬（会重建）。
 */
function migrateLegacyUserData(): void {
  try {
    // 注意：这里的 'L-CODE' 是**旧目录名，连字符必须保留**（品牌改名前的 userData 目录）。
    // 别被"全局把 L-CODE 批量替换成 LCode"带走，否则新旧目录同名 → 迁移静默失效（已踩过）。
    const legacyDir = path.join(app.getPath('appData'), 'L-CODE')
    const targetDir = app.getPath('userData')
    if (path.resolve(legacyDir) === path.resolve(targetDir) || !fs.existsSync(legacyDir)) return
    const files = ['workspace.json', 'kernel-env.json']
    const moved: string[] = []
    for (const f of files) {
      const from = path.join(legacyDir, f)
      const to = path.join(targetDir, f)
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(targetDir, { recursive: true })
        fs.copyFileSync(from, to)
        moved.push(f)
      }
    }
    if (moved.length > 0) logToFile('[app] 已从旧 userData 迁移设置:', moved.join(', '), '→', targetDir)
  } catch (e) {
    logToFile('[app] userData 迁移失败（忽略）:', e instanceof Error ? e.message : String(e))
  }
}

/** 读取持久化的工作目录 */
function getWorkspaceDir(): string | null {
  try {
    const file = path.join(app.getPath('userData'), 'workspace.json')
    if (!fs.existsSync(file)) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { workspaceDir?: string | null }
    return data.workspaceDir ?? null
  } catch {
    return null
  }
}

/**
 * 内核环境配置持久化（userData/kernel-env.json）。
 *
 * 为什么需要它：这些配置以前只能写在 `lcode/kernel/.env` 里——开发期可行，
 * 打包后安装目录不该带 .env（含密钥、也不可写），于是"装完即用"必须靠这里：
 *   1) LLM：`POST /api/config` 只做内存热更新、不落盘，不持久化就每次启动都要重填 Key；
 *   2) ESP-IDF：编译固件必需，且必须能在设置页改（用户机器上的 IDF 路径各不相同）。
 * 启动时把这些注入 process.env，内核/规划器子进程直接继承：
 *   IDF_PATH / IDF_TOOLS_PATH / IDF_PYTHON_ENV_PATH / IDF_TARGET
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / LLM_TEMPERATURE（pydantic-settings 认这些名字）
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（规划器用）
 */
interface KernelEnvStore {
  idf_path?: string
  idf_tools_path?: string
  idf_python_env_path?: string
  idf_target?: string
  llm_api_key?: string
  llm_base_url?: string
  llm_model?: string
  llm_temperature?: number
}

function kernelEnvFile(): string {
  return path.join(app.getPath('userData'), 'kernel-env.json')
}

function readKernelEnv(): KernelEnvStore {
  try {
    const file = kernelEnvFile()
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as KernelEnvStore
  } catch (e) {
    logToFile('[env] 读取 kernel-env.json 失败:', e instanceof Error ? e.message : String(e))
    return {}
  }
}

function patchKernelEnv(patch: KernelEnvStore): KernelEnvStore {
  const merged: KernelEnvStore = { ...readKernelEnv(), ...patch }
  try {
    fs.mkdirSync(path.dirname(kernelEnvFile()), { recursive: true })
    fs.writeFileSync(kernelEnvFile(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (e) {
    logToFile('[env] 写入 kernel-env.json 失败:', e instanceof Error ? e.message : String(e))
  }
  applyKernelEnvToProcess(merged)
  return merged
}

/**
 * 把持久化配置注入本进程环境（子进程 spawn 时继承）。
 *
 * 红线（2026-09-13 实测教训）：**设置页保存的值必须无条件写入**。
 * 旧写法是 `if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = cfg.llm_api_key`
 * —— 本进程启动时已从 kernel-env.json 填过一次，之后在设置页改 Key 就再也进不了进程环境；
 * 而规划器（真正跑对话的 DSH 子进程）正是从这里取 `DEEPSEEK_API_KEY`
 * （Node 改不了别的进程的环境变量，只能重启规划器重建环境）。
 * 现象就是用户看到的："设置页填了新 Key、看着保存成功，对话仍用旧 Key（重置后已失效）报 401"。
 * 现在改为"设置页有值就覆盖、清空就删除"，配置变化后重启规划器（见 restartPlannerForConfig）。
 */
function applyKernelEnvToProcess(cfg: KernelEnvStore = readKernelEnv()): void {
  const set = (key: string, val: string | number | undefined): void => {
    if (val === undefined || val === null) return
    const s = String(val).trim()
    if (s !== '') process.env[key] = s
    else delete process.env[key] // 设置页清空 → 交回 .env / 系统环境兜底
  }
  set('IDF_PATH', cfg.idf_path)
  set('IDF_TOOLS_PATH', cfg.idf_tools_path)
  set('IDF_PYTHON_ENV_PATH', cfg.idf_python_env_path)
  set('IDF_TARGET', cfg.idf_target)
  set('LLM_API_KEY', cfg.llm_api_key)
  set('LLM_BASE_URL', cfg.llm_base_url)
  set('LLM_MODEL', cfg.llm_model)
  set('LLM_TEMPERATURE', cfg.llm_temperature)
  // 规划器（DSH）读的是 DEEPSEEK_*：跟随设置页，不再"已存在就跳过"
  set('DEEPSEEK_API_KEY', cfg.llm_api_key)
  set('DEEPSEEK_BASE_URL', cfg.llm_base_url)
  set('LCORE_LLM_MODEL', cfg.llm_model)
  // 告诉内核：上面这些注入值是权威配置，.env 只当缺省（见 kernel/config/settings.py）
  process.env.LCODE_CONFIG_AUTHORITY = 'desktop'
}

/** 密钥只留末 4 位用于日志比对（DeepSeek 自己的 401 报文也是这么打的），绝不整串落盘。 */
function keyTail(key: string | undefined): string {
  if (!key) return '(未设置)'
  return key.length > 4 ? `****${key.slice(-4)}` : '****'
}

/**
 * 配置变化后重启规划器。
 *
 * 规划器的环境变量是 spawn 那一刻定格的，Node 无法改别的进程的 envp —— 不重启，设置页
 * 改的 Key/模型对"真正跑对话的进程"就永远无效。只在 LLM 相关配置变化时调用（重启会打断
 * 正在跑的一轮对话，其余配置变化不值得付这个代价）。
 */
function restartPlannerForConfig(reason: string): boolean {
  const status = planner?.info.status
  if (!planner || !kernel) return false
  if (status !== 'running' && status !== 'starting') return false
  const url = kernel.baseUrl
  if (!url) return false
  logToFile('[env]', reason, '→ 重启规划器以重建环境（新 Key/模型生效）')
  void planner
    .restart(url, kernel.authToken)
    .catch((e) => logToFile('[env] 规划器重启失败:', e instanceof Error ? e.message : String(e)))
  return true
}

/**
 * 把持久化配置推给**正在运行的内核**（POST /api/config 热更新，不必重启内核）。
 * 内核未就绪时什么都不做：落盘的值会在内核就绪时由 bootKernel 侧的调用补推，且内核
 * 下次 spawn 也会继承同一份 process.env。
 */
async function pushEnvConfigToKernel(): Promise<void> {
  if (!ipc || kernel?.info.status !== 'running') return
  const cfg = readKernelEnv()
  const payload: Record<string, unknown> = {}
  for (const k of [
    'llm_api_key',
    'llm_base_url',
    'llm_model',
    'idf_path',
    'idf_tools_path',
    'idf_python_env_path',
    'idf_target'
  ] as const) {
    const v = cfg[k]
    if (typeof v === 'string' && v.trim() !== '') payload[k] = v
  }
  if (typeof cfg.llm_temperature === 'number') payload.llm_temperature = cfg.llm_temperature
  if (Object.keys(payload).length === 0) return
  try {
    await ipc.updateLlmConfig(payload)
    logToFile('[env] 已把持久化配置推给运行中的内核:', Object.keys(payload).join(','))
  } catch (e) {
    logToFile('[env] 推送配置给内核失败（不致命）:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * 组件载荷（ESP-IDF / 知识库）：见 main/components.ts 的说明。
 *
 * 首次运行：若随包归档存在（带 ESP-IDF 的安装包里有 esp-idf-payload.zip），**在后台解压安装**
 * 到 %APPDATA%\LCode\components\esp-idf（2.4 GB 约 2 分钟），完成后把 IDF 三路径写进
 * kernel-env.json 并热更新给内核 —— 用户不需要做任何操作，这就是"装完即可编译"。
 * 用户自己配过 IDF 的（kernel-env.json 里有 idf_path）则完全不动。
 */
function applyComponentsOnStartup(): void {
  try {
    // 1) 已安装的组件先把环境变量注入（内核/规划器子进程继承）
    const env = applyComponentEnv()
    if (Object.keys(env).length > 0) logToFile('[components] 已注入环境变量:', Object.keys(env).join(', '))

    // 2) 用户没配过 IDF 时，用已安装的组件路径持久化（设置页可改）
    const saved = readKernelEnv()
    if (!saved.idf_path || saved.idf_path.trim() === '') {
      const idf = componentEnv('esp-idf')
      if (idf.IDF_PATH) {
        patchKernelEnv({
          idf_path: idf.IDF_PATH,
          idf_tools_path: idf.IDF_TOOLS_PATH,
          idf_python_env_path: idf.IDF_PYTHON_ENV_PATH
        })
        logToFile('[components] 采用组件内 ESP-IDF:', idf.IDF_PATH)
      }
    }

    // 3) 后台自动安装随包组件（不阻塞窗体显示）
    const pending = COMPONENT_NAMES.filter((n) => !componentStatus(n).installed && bundledZipFor(n) !== '')
    if (pending.length === 0) return
    logToFile('[components] 待自动安装:', pending.join(', '))
    setTimeout(() => {
      const installedVars = autoInstallBundledComponents((...args) => logToFile(...args))
      const idf = componentEnv('esp-idf')
      if (idf.IDF_PATH) {
        // 用户没配过才写入（与上面同口径）
        const cur = readKernelEnv()
        if (!cur.idf_path || cur.idf_path.trim() === '') {
          patchKernelEnv({
            idf_path: idf.IDF_PATH,
            idf_tools_path: idf.IDF_TOOLS_PATH,
            idf_python_env_path: idf.IDF_PYTHON_ENV_PATH
          })
          logToFile('[components] ESP-IDF 组件就绪:', idf.IDF_PATH)
        }
        // 热更新给正在运行的内核（不必重启）
        if (ipc && kernel?.info.status === 'running') {
          void ipc
            .updateLlmConfig({
              idf_path: idf.IDF_PATH ?? '',
              idf_tools_path: idf.IDF_TOOLS_PATH ?? '',
              idf_python_env_path: idf.IDF_PYTHON_ENV_PATH ?? '',
              idf_target: 'esp32s3'
            })
            .catch((e) => logToFile('[components] 热更新 IDF 配置失败:', String(e)))
        }
      }
      if (Object.keys(installedVars).length > 0 && win && !win.isDestroyed()) {
        win.webContents.send('components:changed', installedVars)
      }
      logToFile('[components] 自动安装流程结束')
    }, 1500)
  } catch (e) {
    logToFile('[components] 初始化失败（忽略）:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * 对话承载方式判定（**精简模式兜底**）。
 *
 * 为什么需要：规划器（DSH 子进程）是"全功能"对话的承载者，但它需要一个 DSH 运行时；
 * 打包版目前没有随包规划器（`resources/planner` 只有占位 README）→ 用户装完点开对话
 * 只会看到"规划器未就绪"。兜底方案是把这类情况改路由到**内核自带的对话 Agent**
 * （`POST /api/chat` → `agent.chat_agent.run_chat_turn`，事件走 /api/events，
 * 消息历史走 /api/chat_session）—— 能力上少了 plan-mode/子代理/推理等级，
 * 但"能对话、能改代码、能编译"这条主线是通的。
 *
 * 判定口径（宁可用规划器，不可静默降级）：
 * - `planner.available === false`：运行时根本不存在 → 精简
 * - status === 'crashed'：连续重启失败 → 精简
 * - 其余（含 starting）：按规划器走；starting 会先等一小会儿（见 waitPlannerReady）
 */
function chatSlimMode(): { slim: boolean; reason: string } {
  if (!planner) return { slim: true, reason: 'planner-manager-missing' }
  if (!planner.available) return { slim: true, reason: 'planner-runtime-missing' }
  if (planner.info.status === 'crashed') return { slim: true, reason: 'planner-crashed' }
  return { slim: false, reason: '' }
}

/** 规划器冷启动等待（starting 阶段的发送不要立刻报错）。 */
async function waitPlannerReady(timeoutMs: number): Promise<boolean> {
  if (!planner) return false
  const st = planner.info.status
  if (st === 'running') return true
  if (st === 'starting') return planner.waitRunning(timeoutMs)
  return false
}

/** 精简模式兜底：把一条消息交给内核对话 Agent（与规划器共用同一套会话/事件表）。 */
async function sendViaKernel(
  message: string,
  sessionId: string,
  fullAccess: boolean | undefined,
  cwd: string | undefined
): Promise<{ session_id: string; status: string; mode: 'slim' }> {
  if (!ipc) throw new Error('E_KERNEL_UNREACHABLE')
  const boundCwd = cwd || kernel?.workspaceDirValue || undefined
  try {
    const r = await ipc.chat(message, sessionId, fullAccess, boundCwd)
    poller?.start(r.session_id)
    logToFile('[chat] 精简模式：已交给内核对话 Agent session =', r.session_id)
    return { ...r, mode: 'slim' as const }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('fetch failed') || /ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(msg)) {
      throw new Error('E_KERNEL_UNREACHABLE')
    }
    throw new Error(msg)
  }
}

async function bootstrap(): Promise<void> {
  logToFile('[app] app ready，开始 bootstrap')
  migrateLegacyUserData()
  applyComponentsOnStartup()
  setupChineseMenu()
  setupIpc()

  kernel = new KernelManager((info) => {
    if (win && !win.isDestroyed()) win.webContents.send('kernel:status', info)
    // 内核就绪/重启后确保规划器绑定到当前内核地址（内核崩了自动重启换端口/token 时联动）
    if (info.status === 'running') {
      const kUrl = kernel?.baseUrl
      const kTok = kernel?.authToken
      if (kUrl && kTok) void syncPlannerToKernel(kUrl, kTok)
      // 内核就绪后补跑启动清理（早退的 fetch failed 清理会在内核 running 后自动重试）
      void purgeUnsupportedSessions()
      // 设置页在"内核未就绪"时保存的 LLM/IDF 配置，这里补推给刚起来的内核（热更新）
      void pushEnvConfigToKernel()
    }
  })
  // 规划器：与内核同生命周期（内核重启换地址时联动重启，见 syncPlannerToKernel）
  planner = new PlannerManager((info) => {
    if (win && !win.isDestroyed()) win.webContents.send('kernel:status', { ...info, kind: 'planner' })
    // 规划器就绪后补跑启动清理（内核 running 但规划器还在冷启动时，等待规划器 running 再判定未登记会话）
    if (info.status === 'running') void purgeUnsupportedSessions()
  })
  ipc = new IpClient(
    () => (kernel ? kernel.baseUrl : null),
    () => (kernel ? kernel.authToken : '')
  )
  poller = new EventPoller(
    (taskId, afterSeq) => ipc!.getEvents(taskId, afterSeq),
    () => win
  )

  // 启动前应用持久化的内核环境（ESP-IDF / LLM）：子进程 spawn 时继承
  applyKernelEnvToProcess()
  // 启动前应用持久化的工作目录（内核 --outputs）
  kernel.setWorkspaceDir(getWorkspaceDir())
  // 工作区目录服务：本地 fs 浏览 + 递归变更监听（打开文件夹后立即刷新，不依赖内核就绪）
  workspaceFs = new WorkspaceFs(() => workspaceRootDir(), () => win)
  workspaceFs.watch()
  await kernel.start()
  if (kernel.baseUrl) {
    await syncPlannerToKernel(kernel.baseUrl, kernel.authToken)
  }
  // 开启窗体前：仅清空「损坏/空壳」历史会话（0 条消息且非运行中）。有内容的历史会话
  // （msg_count>0）一律保留 —— 用户拍板（2026-09）：会话历史跨重启保留，重开 LCode 后
  // Home 列表仍可见、可打开继续/分支（planner 侧对登记表缺失的旧会话做懒恢复，见 server）。
  // 内核冷启动可能需几十秒：最多等待 25s 做首次清理，超时则先开窗体，由就绪回调补跑。
  await waitKernelRunning(25_000)
  await purgeUnsupportedSessions()
  // 清理完成后再创建/显示主窗口（用户不可见清理过程）
  createWindow()
}

/**
 * 启动清理：仅删除「损坏/空壳」的历史会话（0 条消息且非运行中）——打开后只会显示
 * "加载对话…"永不停的那种残留（中断/测试/崩溃遗留），与规划器登记与否无关。
 *
 * 语义红线（2026-09 拍板）：
 * - 只删 msg_count == 0 且 status != 'running' 的会话；
 * - **绝不删有内容（msg_count > 0）的历史会话**——即使当前 planner 登记表里没有
 *   （planner 登记表是进程内存态，重启即空 ≠ 会话作废；旧会话由 planner 懒恢复继续）。
 *
 * 可靠性：失败不置 done，由「内核/规划器就绪回调」再次触发（startupPurgeDone 仅成功后置位），
 * 避免早期内核未就绪时一次 fetch failed 就让清理永久跳过。
 */
let startupPurgeDone = false
async function purgeUnsupportedSessions(): Promise<void> {
  if (startupPurgeDone) return
  if (!ipc) return
  // 内核不可达时无法枚举/删除（fetch failed），等就绪回调再试
  if (kernel?.info.status !== 'running') {
    logToFile('[startup-purge] 内核未就绪，等待 running 后再清理')
    return
  }
  try {
    // 空壳会话清理：msg_count == 0 且 status != 'running'（只依赖内核，不依赖规划器）
    const kernelSessions: { session_id?: string; status?: string; msg_count?: number }[] =
      (((await ipc.getChatSessions())?.sessions as unknown[]) ?? []).map((s) => {
        const row = s as { session_id?: unknown; status?: unknown; msg_count?: unknown }
        return {
          session_id: typeof row.session_id === 'string' ? row.session_id : undefined,
          status: typeof row.status === 'string' ? row.status : undefined,
          msg_count: typeof row.msg_count === 'number' ? row.msg_count : undefined
        }
      })
    const shells = kernelSessions.filter(
      (s) => (s.msg_count ?? 0) === 0 && s.status !== 'running'
    ).map((s) => s.session_id ?? '').filter((id) => id !== '')
    const stale = [...new Set(shells)]

    if (stale.length === 0) {
      startupPurgeDone = true
      logToFile(`[startup-purge] 无待清理的空壳会话（保留全部有内容历史会话）`)
      return
    }
    const del = await ipc.deleteChatSessions(stale)
    startupPurgeDone = true
    logToFile(
      `[startup-purge] 清除 ${stale.length} 个空壳会话（0 消息非运行；内核已删 ${del?.deleted ?? 0}；有内容会话全部保留）`
    )
  } catch (e) {
    // 失败不置 done：下次「内核/规划器 running」回调会重试，确保窗体打开前清干净
    logToFile('[startup-purge] 清理失败（等待就绪后重试）:', e instanceof Error ? e.message : String(e))
  }
}

/** 等待内核就绪（bootstrap 冷启动内核可能需 30~60s，窗体仍按时显示，清理就绪后自动执行）。 */
function waitKernelRunning(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (kernel?.info.status === 'running' || Date.now() - started >= timeoutMs) resolve()
      else setTimeout(tick, 250)
    }
    tick()
  })
}

/** 规划器 → 内核绑定同步（幂等）：内核换地址后重启规划器，避免 chat 打到旧内核 URL */
let plannerSyncPromise: Promise<void> | null = null
async function syncPlannerToKernel(kernelUrl: string, kernelToken: string): Promise<void> {
  // 串行化：内核健康回调与 bootstrap/工作目录重启可能并发触发
  if (plannerSyncPromise) {
    await plannerSyncPromise
    // 串行后仍需判断（并发期间地址可能再变）
    if (planner && planner.isBoundTo(kernelUrl, kernelToken)) return
  }
  plannerSyncPromise = (async () => {
    try {
      if (!planner) return
      if (planner.isBoundTo(kernelUrl, kernelToken)) return
      await planner.restart(kernelUrl, kernelToken)
    } catch (e) {
      logToFile('[app] syncPlannerToKernel 失败:', e instanceof Error ? e.message : String(e))
    } finally {
      plannerSyncPromise = null
    }
  })()
  await plannerSyncPromise
}

app.whenReady().then(bootstrap)

app.on('window-all-closed', () => {
  logToFile('[app] window-all-closed → quit')
  app.quit()
})

app.on('before-quit', async (e) => {
  logToFile('[app] before-quit，内核状态=', kernel?.info.status ?? 'null')
  workspaceFs?.unwatch()
  if (kernel && kernel.info.status !== 'stopped') {
    e.preventDefault()
    await planner?.stop()
    await kernel.stop()
    logToFile('[app] 内核与规划器已停止，再次 quit')
    app.quit()
  }
})
