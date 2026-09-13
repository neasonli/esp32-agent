/**
 * 内核进程管理（W1 骨架）
 *
 * 职责（对应阶段2文档 4.1 core/kernel）：
 * 1. 拉起内核子进程（优先内核 EXE，否则 Python run_kernel.py）
 * 2. 健康检查（轮询 /api/health）
 * 3. 崩溃检测与自动重启（心跳失败连续 N 次 → 重启）
 * 4. 优雅停止（POST /api/shutdown → 兜底 kill）
 *
 * D19 铁律：本模块只存在于 Electron 主进程（child_process 仅主进程可用），
 * 渲染进程通过 preload 白名单 API 获取内核状态，绝不直接接触内核。
 */
import { spawn, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'
import { logToFile } from './logger'

export type KernelStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface KernelStatusInfo {
  status: KernelStatus
  port: number | null
  pid: number | null
  startedAt: number | null
  restarts: number
  lastError?: string
}

const HEALTH_INTERVAL_MS = 2000
const HEALTH_TIMEOUT_MS = 1500
// 内核启动需导入 torch 等重库，冷启动/杀软扫描/磁盘繁忙时可能 30~60 秒才就绪。
// 30 次 × 2s = 60s 启动宽限期；期间健康检查失败只计数，不判定内核死亡。
// （曾用 8 次 = 16s，导致内核冷启动偶发超时被误杀、进入重启死循环）
const MAX_FAILS_BEFORE_RESTART = 30
const MAX_RESTARTS = 5

export class KernelManager {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private token = ''
  private status: KernelStatus = 'stopped'
  private fails = 0
  private restarts = 0
  private startedAt: number | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private stopping = false

  /** 开发模式：内核源码在 lcode/kernel（桌面目录上一级） */
  private get kernelDir(): string {
    return process.env.LCODE_KERNEL_DIR ?? path.join(app.getAppPath(), '..', 'kernel')
  }

  /**
   * 生产模式：内核可执行文件由 electron-builder extraResources 放入 resources/kernel。
   *
   * 注意文件名按平台区分：Windows 是 `lcode-kernel.exe`，macOS/Linux 没有 `.exe` 后缀
   * （写死 `.exe` 会导致 mac/linux 装完永远走"回退到 Python 源码"分支 → 找不到解释器 → 内核起不来）。
   */
  private get kernelExe(): string {
    const exeName = process.platform === 'win32' ? 'lcode-kernel.exe' : 'lcode-kernel'
    return process.env.LCODE_KERNEL_EXE ?? path.join(process.resourcesPath, 'kernel', exeName)
  }

  /**
   * 开发模式：内核解释器候选（先命中先赢）。
   * 目录关系：desktop 在 lcode/ 下 →
   *   app.getAppPath()=…/lcode/desktop
   *   1) 环境变量 LCODE_KERNEL_PYTHON —— 最高优先，用于把解释器放到任意位置（如阶段1 目录已迁出仓库）
   *   2) lcode/kernel/.venv/Scripts/python.exe —— 内核自带虚拟环境（README 推荐，公开仓用户走这条）
   *   3) 仓库根的 embedded_agent_stage1/.venv/… —— 历史开发环境，仅作兼容保留
   */
  private get pythonExeCandidates(): { exe: string; why: string }[] {
    const list = [
      { exe: process.env.LCODE_KERNEL_PYTHON ?? '', why: 'LCODE_KERNEL_PYTHON' },
      { exe: path.join(this.kernelDir, '.venv', 'Scripts', 'python.exe'), why: '内核自带 lcode/kernel/.venv' },
      {
        exe: path.join(app.getAppPath(), '..', '..', 'embedded_agent_stage1', '.venv', 'Scripts', 'python.exe'),
        why: '阶段1 .venv（历史兼容）'
      }
    ]
    return list.filter((c) => c.exe !== '')
  }

  private get pythonExe(): string {
    const hit = this.pythonExeCandidates.find((c) => existsSync(c.exe))
    // 全部不存在时返回最后一个候选，交给日志/错误提示说明怎么修
    return hit?.exe ?? this.pythonExeCandidates[this.pythonExeCandidates.length - 1]!.exe
  }

  constructor(private onStatus: (info: KernelStatusInfo) => void) {}

  /** 自定义工作目录（生成的工程输出根；由桌面网关设置页传入） */
  private workspaceDir: string | null = null

  setWorkspaceDir(dir: string | null): void {
    this.workspaceDir = dir
  }

  /** 当前工作目录（可能为 null = 使用内核默认 outputs） */
  get workspaceDirValue(): string | null {
    return this.workspaceDir
  }

  get info(): KernelStatusInfo {
    return {
      status: this.status,
      port: this.port,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts
    }
  }

  /** 供事件轮询器使用的地址 */
  get baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  get authToken(): string {
    return this.token
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.stopping = false
    this.status = 'starting'
    // 每次新实例清零失败计数：否则上一次实例的失败数会带过来，
    // 新内核只活过 1 次健康检查就被误杀（已实测 fails=12/8 加速死循环）
    this.fails = 0
    this.emit()

    this.port = await this.pickFreePort()
    this.token = randomBytes(24).toString('hex')
    logToFile('[kernel-manager] start:')
    logToFile('  app.getAppPath() =', app.getAppPath())
    logToFile('  kernelDir        =', this.kernelDir, '(exists:', existsSync(this.kernelDir), ')')
    logToFile('  kernelExe        =', this.kernelExe, '(exists:', existsSync(this.kernelExe), ')')
    for (const c of this.pythonExeCandidates) {
      logToFile(`  python 候选 [${c.why}] =`, c.exe, '(exists:', existsSync(c.exe), ')')
    }
    logToFile('  pythonExe        =', this.pythonExe, '(exists:', existsSync(this.pythonExe), ')')
    if (!existsSync(this.kernelExe) && !existsSync(this.pythonExe)) {
      logToFile(
        '  [错误] 没有可用内核解释器：请设置环境变量 LCODE_KERNEL_PYTHON，' +
          '或在 lcode/kernel 下创建 .venv 并 pip install -r requirements.txt'
      )
    }
    logToFile('  port =', this.port, '| useExe =', existsSync(this.kernelExe))
    this.proc = this.spawnKernel(this.port, this.token)
    const pid = this.proc.pid ?? -1
    logToFile('[kernel-manager] 内核已启动 pid=', pid)

    this.proc.on('exit', (code, signal) => {
      const wasStopped = this.stopping
      this.proc = null
      this.startedAt = null
      this.stopHealthCheck()
      logToFile(
        '[kernel-manager] 内核进程退出 pid=',
        pid,
        'code=',
        code,
        'signal=',
        signal,
        '| stopping=',
        wasStopped
      )
      if (wasStopped) {
        this.status = 'stopped'
        this.emit()
        return
      }
      // 非主动停止 → 崩溃：自动重启
      this.status = 'crashed'
      this.restarts += 1
      this.lastError = `内核退出 code=${code} signal=${signal}`
      this.emit()
      if (this.restarts <= MAX_RESTARTS) {
        setTimeout(() => this.start(), 1500)
      } else {
        this.lastError = `连续重启超过 ${MAX_RESTARTS} 次，停止尝试`
        this.emit()
      }
    })
    // spawn 自身错误（如 ENOENT）走 'error' 事件
    this.proc.on('error', (err) => {
      logToFile('[kernel-manager] spawn error pid=', pid, err instanceof Error ? err.message : String(err))
    })

    this.startHealthCheck()
  }

  private lastError: string | undefined = undefined

  private spawnKernel(port: number, token: string): ChildProcess {
    const exe = this.kernelExe
    const useExe = existsSync(exe)
    const args = ['--port', String(port), '--token', token]
    // 自定义工作目录：生成的工程都放在该目录下
    if (this.workspaceDir) {
      args.push('--outputs', this.workspaceDir)
    }
    // 可写数据目录（会话库 tasks.db / 事件库）：
    // 打包安装后内核冻结产物的默认数据目录在安装目录内（Program Files 之类），既不可写、
    // 也会在升级时被清掉。因此打包模式强制指到用户目录；开发模式不传（沿用 lcode/kernel/data，
    // 现有会话不受影响）。
    const dataDir =
      process.env.LCODE_KERNEL_DATA ??
      (app.isPackaged ? path.join(app.getPath('userData'), 'kernel-data') : null)
    if (dataDir) {
      args.push('--data-dir', dataDir)
    }
    let cmd: string
    if (useExe) {
      cmd = `"${exe}" ${args.join(' ')}`
    } else {
      cmd = `"${this.pythonExe}" "${path.join(this.kernelDir, 'run_kernel.py')}" ${args.join(' ')}`
    }
    logToFile('[kernel-manager] spawn:', cmd)
    try {
      let child: ChildProcess
      if (useExe) {
        child = spawn(exe, args, { stdio: 'inherit', windowsHide: true })
      } else {
        // -u: 关闭 Python stdout 块缓冲，内核启动过程实时落盘（排查启动挂起必备）
        child = spawn(this.pythonExe, ['-u', path.join(this.kernelDir, 'run_kernel.py'), ...args], {
          cwd: this.kernelDir,
          stdio: 'pipe',
          windowsHide: true
        })
        // 内核自身输出落盘（证据留存：内核崩溃原因必看 kernel.log）
        child.stdout?.on('data', (d) => logToFile('[kernel]', String(d).trimEnd()))
        child.stderr?.on('data', (d) => logToFile('[kernel]', String(d).trimEnd()))
      }
      return child
    } catch (err) {
      logToFile('[kernel-manager] spawn FAILED:', err instanceof Error ? err.stack ?? String(err) : String(err))
      throw err
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck()
    this.healthTimer = setInterval(async () => {
      if (!this.proc) return
      const ok = await this.checkHealth()
      if (ok) {
        if (this.status !== 'running') {
          logToFile('[kernel-manager] 健康检查通过，内核就绪 pid=', this.proc.pid)
          this.status = 'running'
          this.startedAt = Date.now()
          this.fails = 0
          this.emit()
        } else {
          this.fails = 0
        }
      } else {
        this.fails += 1
        if (this.fails === 1 || this.fails % 4 === 0) {
          logToFile('[kernel-manager] 健康检查失败，fails=', this.fails, '/', MAX_FAILS_BEFORE_RESTART)
        }
        if (this.fails >= MAX_FAILS_BEFORE_RESTART) {
          this.lastError = '健康检查连续失败，判定内核无响应，重启'
          logToFile('[kernel-manager] 判定内核无响应，执行重启（health 失败）')
          this.killProc(this.proc)
        }
      }
    }, HEALTH_INTERVAL_MS)
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async checkHealth(): Promise<boolean> {
    if (!this.port) return false
    const url = `http://127.0.0.1:${this.port}/api/health`
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'X-Kernel-Token': this.token }
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const proc = this.proc
    if (proc) {
      try {
        if (this.port) {
          await fetch(`http://127.0.0.1:${this.port}/api/shutdown`, {
            method: 'POST',
            headers: { 'X-Kernel-Token': this.token }
          }).catch(() => undefined)
        }
      } finally {
        this.killProc(proc)
      }
    }
  }

  /**
   * 重启内核（stop → 等待旧进程真正退出 → start）
   *
   * 注意：stop() 发 SIGTERM 后立即返回，exit 事件异步触发。
   * 若不等待，start() 会因 this.proc 仍指向旧进程而早退，导致内核被杀后不再启动
   * （已实测：设置工作目录后内核挂死的根因）。
   */
  async restart(): Promise<void> {
    await this.stop()
    const deadline = Date.now() + 5000
    while (this.proc && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (this.proc) {
      logToFile('[kernel-manager] restart 等待旧进程退出超时，强制继续')
    }
    await this.start()
  }

  /**
   * 杀掉指定进程（必须捕获进程引用，禁止用 this.proc）：
   * 延迟 SIGKILL 定时器若读 this.proc，会误杀重启后的新进程（已实测的死亡螺旋根因）。
   */
  private killProc(proc: ChildProcess): void {
    logToFile('[kernel-manager] killProc pid=', proc.pid)
    proc.kill()
    setTimeout(() => {
      // 只杀"当时这个进程"，且只有它还活着时才杀
      if (this.proc === proc && proc.exitCode === null) {
        logToFile('[kernel-manager] killProc SIGKILL 兜底 pid=', proc.pid)
        proc.kill('SIGKILL')
      }
    }, 2000).unref()
  }

  private emit(): void {
    this.onStatus(this.info)
  }

  private pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })
  }
}
