/**
 * 规划器进程管理（阶段3 Phase1：对话模式切换到规划循环）
 *
 * 职责（与 KernelManager 同构，agent核心开发文档 §1.1/§1.9）：
 * 1. 拉起规划器子进程（开发模式：node + dsh CLI --profile lcode-planner）
 * 2. 健康检查（GET /api/planner/health，X-Planner-Token）
 * 3. 崩溃检测与自动重启（心跳失败连续 N 次 → 重启，最多 MAX_RESTARTS）
 * 4. 优雅停止（POST /api/planner/shutdown → 兜底 kill）
 * 5. 对话 API 客户端（chat / cancelChat / setChatAccess）——事件流仍走内核
 *    /api/events 轮询（规划器经内核 HTTP 落库，桌面端事件轮询不变）
 *
 * 规划器需要的环境变量：
 *   LCORE_KERNEL_URL / LCORE_KERNEL_TOKEN —— 内核地址与鉴权（由 KernelManager 提供）
 *   LCORE_PLANNER_PORT / LCORE_PLANNER_TOKEN —— 规划器自身 HTTP 服务
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / LCORE_LLM_MODEL —— LLM 配置（优先读内核 .env）
 */
import { spawn, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'
import { logToFile } from './logger'

export type PlannerStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface PlannerStatusInfo {
  status: PlannerStatus
  port: number | null
  pid: number | null
  startedAt: number | null
  restarts: number
  /** 规划器自报的**实际生效**模型（来自 /api/planner/health；与设置页请求值可能不同）。 */
  effectiveModel?: string
  lastError?: string
}

/** 规划器 /api/planner/health 里与 LLM 身份有关的字段。 */
export interface PlannerLlmInfo {
  model: string
  requested_model: string
  llm_base_url: string
  api_key_tail: string
  api_key_source: string
}

const HEALTH_INTERVAL_MS = 2000
const HEALTH_TIMEOUT_MS = 1500
const MAX_FAILS_BEFORE_RESTART = 30
const MAX_RESTARTS = 5

/** DSH checkout 根（开发模式：mcu_ai_agent 的兄弟目录 deepseek/） */
function dshRepoDir(): string {
  if (process.env.LCORE_DSH_REPO) return process.env.LCORE_DSH_REPO
  // app.getAppPath() = …/lcode/desktop → ../../.. = D:\1_ai_project → deepseek\deepseek-harness-master
  return path.join(app.getAppPath(), '..', '..', '..', 'deepseek', 'deepseek-harness-master')
}

/** 随包规划器运行时根目录（路线 B 的产物落点，见 docs/打包发布指南.md §3）。 */
function bundledPlannerDir(): string {
  if (process.env.LCORE_PLANNER_DIR) return process.env.LCORE_PLANNER_DIR
  // 打包后 process.resourcesPath = <安装目录>\resources；extraResources 把 resources/planner 投到 planner/
  return path.join(process.resourcesPath, 'planner')
}

/**
 * 随包运行时入口的候选文件名（按顺序取第一个存在的）。
 * `apps/cli/lib/bin.js` 是 tools/planner-bundle 构建出的真实入口；
 * 其余几条是容错（万一将来改成单文件启动器）。manifest.json 里的 `entry` 优先于本列表。
 * ⚠️ 一个都找不到 → `available=false` → 精简模式兜底（不会静默坏掉）。
 */
const BUNDLED_PLANNER_ENTRIES = ['apps/cli/lib/bin.js', 'run-planner.mjs', 'runner.mjs', 'index.mjs']

/** 随包闭包清单（`tools/planner-bundle/build-bundle.mjs` 产出）。 */
interface PlannerBundleManifest {
  version?: string
  entry?: string
  dsh_home?: string
  built_at?: string
}

function readBundleManifest(dir: string): PlannerBundleManifest | null {
  try {
    const f = path.join(dir, 'manifest.json')
    if (!existsSync(f)) return null
    return JSON.parse(readFileSync(f, 'utf-8')) as PlannerBundleManifest
  } catch {
    return null
  }
}

/**
 * 当前 Electron 自带的 Node 是否满足 DSH 的 engines（`^22.19.0 || >=24`）。
 *
 * 为什么必须判：DSH 静态 import 了 Node 22.15 才有的 `zlib.createZstdDecompress`，
 * Node 20 下是**模块链接期**报错（`does not provide an export named 'createZstdDecompress'`），
 * 与配置无关。Electron 33 = Node 20.18.3 跑不了；≥36.9（Node 22.19）才行。
 * 开发机上若 Electron 还没升，但有 DSH checkout，就继续用 checkout（避免"闭包一放进
 * resources 就把开发环境弄坏"）。
 */
function nodeSatisfiesDsh(): boolean {
  const parts = process.versions.node.split('.').map((n) => parseInt(n, 10))
  const maj = parts[0] ?? 0
  const min = parts[1] ?? 0
  if (maj > 22) return true
  if (maj === 22) return min >= 19
  return false
}

/**
 * 把随包闭包**整份**拷到用户目录（首次约 15 s / 28 MB），幂等（按 manifest 版本与构建时间戳）。
 *
 * 为什么必须拷到用户目录：
 * ① 安装目录可能只读（Program Files），而 DSH 要往 DSH_HOME 写 sessions/skills/settings/凭据；
 * ② 整份拷贝保留 bundle 内 `node_modules/` 与 `home/` 的相对布局 ——
 *    profile 里的 `import('@lcode/planner')` **不**按 `$DSH_HOME/profiles/node_modules` farm 解析，
 *    而是靠父目录上溯命中 `<bundle>/node_modules`（tools/planner-bundle 的 REPORT 坑 3）。
 *    少拷一层目录就会 `Cannot find package '@lcode/planner'`。
 */
function ensurePlannerRuntime(srcDir: string, manifest: PlannerBundleManifest | null): string | null {
  const dest = path.join(app.getPath('userData'), 'planner-runtime')
  const entryRel = manifest?.entry ?? BUNDLED_PLANNER_ENTRIES[0]
  const stamp = path.join(dest, '.bundle-stamp')
  const want = `${manifest?.version ?? '0'}@${manifest?.built_at ?? 'unknown'}`
  try {
    if (
      existsSync(path.join(dest, entryRel)) &&
      existsSync(stamp) &&
      readFileSync(stamp, 'utf-8').trim() === want
    ) {
      return dest
    }
    const t0 = Date.now()
    rmSync(dest, { recursive: true, force: true })
    cpSync(srcDir, dest, { recursive: true })
    writeFileSync(stamp, want, 'utf-8')
    logToFile(
      '[planner-manager] 随包运行时已就位:',
      dest,
      `(${Math.round((Date.now() - t0) / 1000)} s, 版本 ${manifest?.version ?? '?'})`
    )
    return dest
  } catch (e) {
    logToFile(
      '[planner-manager] 随包运行时拷贝失败（退回只读源目录，DSH 可能无法写状态）:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
}

/** 规划器运行时：随包闭包（路线 B）或开发用 DSH checkout。 */
interface PlannerRuntime {
  kind: 'bundled' | 'dev'
  /** 入口文件绝对路径 */
  entry: string
  /** 子进程 cwd（随包 = 闭包根；开发 = DSH 仓根） */
  cwd: string
  /** 用哪个可执行文件：随包用 Electron 自带 Node；开发用系统 node + tsx */
  launcher: 'electron-node' | 'node-tsx'
  /** 随包模式的 DSH_HOME（闭包内的可写 home/，已拷到用户目录） */
  dshHome?: string
}

/**
 * 规划器要用哪个 DSH_HOME。
 * - 随包模式：闭包内 `home/`（已随整份拷贝落到用户目录）——**可写**，且父目录上溯能命中
 *   `<bundle>/node_modules`（`@lcode/planner` 靠这个解析，见 REPORT 坑 3）。
 *   ⚠️ 必须**无视**继承来的 `DSH_HOME`：实测踩过——桌面上若环境里带着 `DSH_HOME=~/.dsh`
 *   （装了 DSH GUI 的机器很常见），profile 会解析到**开发源码** `lcode/planner/src/*.ts`，
 *   在 Node 22 strip-only 模式下直接炸：
 *   `TypeScript parameter property is not supported in strip-only mode`
 *   （而且 profile 里没有随包闭包的入口）。测试要用别的 DSH_HOME 请显式给
 *   `LCORE_PLANNER_DSH_HOME`，那是刻意的覆盖。
 * - 开发模式：不设，保持 `~/.dsh` 不变（与用户已有 DSH GUI 环境一致，避免行为漂移）。
 */
function plannerDshHome(runtime: PlannerRuntime): string | undefined {
  if (runtime.kind === 'dev') return process.env.DSH_HOME
  if (process.env.LCORE_PLANNER_DSH_HOME) return process.env.LCORE_PLANNER_DSH_HOME
  if (process.env.DSH_HOME && process.env.DSH_HOME !== runtime.dshHome) {
    logToFile(
      '[planner-manager] 忽略继承的 DSH_HOME =',
      process.env.DSH_HOME,
      '（随包运行时用自己的 home：',
      runtime.dshHome ?? '-',
      '）'
    )
  }
  return runtime.dshHome
}

/** 内核侧 LLM 配置（开发模式读 kernel/.env；读不到则返回空，规划器走 $DSH_HOME/.credentials.yaml） */
function kernelLlmEnv(): Record<string, string> {
  const envFile = process.env.LCODE_KERNEL_DIR
    ? path.join(process.env.LCODE_KERNEL_DIR, '.env')
    : path.join(app.getAppPath(), '..', 'kernel', '.env')
  try {
    if (!existsSync(envFile)) return {}
    const out: Record<string, string> = {}
    for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

export class PlannerManager {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private token = ''
  private status: PlannerStatus = 'stopped'
  private fails = 0
  private restarts = 0
  private startedAt: number | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private stopping = false
  private lastError: string | undefined
  private effectiveModel: string | undefined
  /** 规划器当前绑定的内核地址/令牌（内核重启换端口后用于联动重启判断） */
  private kernelUrl = ''
  private kernelToken = ''

  constructor(private onStatus: (info: PlannerStatusInfo) => void) {}

  get info(): PlannerStatusInfo {
    return {
      status: this.status,
      port: this.port,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      effectiveModel: this.effectiveModel,
      lastError: this.lastError
    }
  }

  get baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  get authToken(): string {
    return this.token
  }

  /**
   * 规划器是否已绑定到指定内核地址（用于内核重启后联动重启）。
   *
   * `starting` 也算已绑定：冷启动时 bootstrap 会先按当时的内核地址把规划器拉起来，
   * 内核健康检查通过后 `syncPlannerToKernel` 会再同步一次；若此时把"启动中"判成未绑定，
   * 就会把刚起的规划器杀掉重启（实测：17:15:32 起 pid 6208 → 17:15:38 被杀 → 又起 7308，
   * 白等一轮规划器冷启动，期间发消息还可能打到即将被杀的进程）。
   * 只有地址/令牌确实变了，或已 stopped/crashed，才需要重启。
   */
  isBoundTo(kernelUrl: string, kernelToken: string): boolean {
    if (this.status !== 'running' && this.status !== 'starting') return false
    return this.kernelUrl === kernelUrl && this.kernelToken === kernelToken
  }

  /**
   * 规划器运行时入口。
   * 优先级：随包闭包（路线 B，需 Electron 自带 Node ≥22.19）→ 开发用 DSH checkout。
   * 随包目录存在但入口缺失 / Node 太老时**继续回落**到 dev 入口（本地开发不受影响），
   * 两者都没有 → `available=false` → 精简模式兜底。
   */
  private resolveRuntime(): PlannerRuntime {
    const bundled = bundledPlannerDir()
    const manifest = readBundleManifest(bundled)
    const candidates = manifest?.entry
      ? [manifest.entry, ...BUNDLED_PLANNER_ENTRIES.filter((r) => r !== manifest.entry)]
      : BUNDLED_PLANNER_ENTRIES
    const hit = candidates.find((rel) => existsSync(path.join(bundled, rel)))
    if (hit) {
      if (!nodeSatisfiesDsh()) {
        logToFile(
          '[planner-manager] 随包运行时存在（入口 =',
          hit,
          '），但当前 Electron 自带 Node',
          process.versions.node,
          '< 22.19（DSH engines 要求）→ 本次改用 DSH checkout；升级 Electron ≥36.9 后随包运行时才会启用'
        )
      } else {
        const root = ensurePlannerRuntime(bundled, manifest) ?? bundled
        return {
          kind: 'bundled',
          entry: path.join(root, hit),
          cwd: root,
          launcher: 'electron-node',
          dshHome: path.join(root, manifest?.dsh_home ?? 'home')
        }
      }
    }
    return {
      kind: 'dev',
      entry: path.join(dshRepoDir(), 'apps', 'cli', 'src', 'bin.ts'),
      cwd: dshRepoDir(),
      launcher: 'node-tsx'
    }
  }

  /**
   * 规划器运行时是否**存在**（不是"是否已就绪"）。
   *
   * 用途：没有随包运行时且没有 DSH checkout（= 用户装完的机器）→ `available=false`
   * → 对话改由内核 `/api/chat` 承载（精简模式兜底，见 main/index.ts 的 chatSlimMode）。
   * 注意 `start()` 在入口不存在时会提前 return 并只写 lastError，status 一直停在 `stopped`
   * —— 所以不能用 status 判断。
   */
  get available(): boolean {
    return existsSync(this.resolveRuntime().entry)
  }

  /** 供日志/界面显示：当前用的是哪种运行时、入口在哪。 */
  get runtimeInfo(): { kind: string; entry: string; cwd: string; launcher: string } {
    const r = this.resolveRuntime()
    return { kind: r.kind, entry: r.entry, cwd: r.cwd, launcher: r.launcher }
  }

  /**
   * 等规划器进入 running（冷启动十几秒）。
   * 返回 false = 超时或明确不可用（调用方据此决定报错还是走兜底）。
   */
  async waitRunning(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.status === 'running') return true
      if (this.status === 'stopped' && this.lastError) return false
      await new Promise((r) => setTimeout(r, 300))
    }
    return this.status === 'running'
  }

  async start(kernelUrl: string, kernelToken: string): Promise<void> {
    if (this.proc) return
    const runtime = this.resolveRuntime()
    if (!existsSync(runtime.entry)) {
      this.lastError =
        runtime.kind === 'bundled'
          ? `规划器不可用：随包运行时缺入口（${runtime.entry}）`
          : `规划器不可用：未找到 DSH checkout（${runtime.entry}）。请设置 LCORE_DSH_REPO、LCORE_PLANNER_DIR，或安装 deepseek-harness-master。`
      logToFile('[planner-manager]', this.lastError, '→ 对话将走精简模式（内核 /api/chat）')
      this.emit()
      return
    }
    this.stopping = false
    this.status = 'starting'
    this.fails = 0
    this.kernelUrl = kernelUrl
    this.kernelToken = kernelToken
    this.emit()

    this.port = await this.pickFreePort()
    this.token = randomBytes(24).toString('hex')
    const llm = kernelLlmEnv()
    // 优先级：桌面进程环境（= 设置页/kernel-env.json，由 applyKernelEnvToProcess 注入）> kernel/.env。
    // 规划器是**真正跑对话**的进程，它拿到哪把 Key 决定对话成不成功 —— 所以这里把来源与末 4 位
    // 写进日志（Key 本体绝不落盘）。排查"设置页填了新 Key、对话仍 401"时先看这一行。
    const apiKey = process.env.DEEPSEEK_API_KEY ?? llm.LLM_API_KEY
    const baseUrl = process.env.DEEPSEEK_BASE_URL ?? llm.LLM_BASE_URL
    const modelName = process.env.LCORE_LLM_MODEL ?? llm.LLM_MODEL
    const dshHome = plannerDshHome(runtime)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LCORE_KERNEL_URL: kernelUrl,
      LCORE_KERNEL_TOKEN: kernelToken,
      LCORE_PLANNER_PORT: String(this.port),
      LCORE_PLANNER_TOKEN: this.token,
      LCORE_CWD: kernelUrl && process.env.LCORE_PLANNER_CWD
        ? process.env.LCORE_PLANNER_CWD
        : undefined,
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: baseUrl,
      LCORE_LLM_MODEL: modelName,
      // 随包模式：DSH_HOME 指向用户目录（安装目录不可写；sessions/skills/settings 都写这里）
      DSH_HOME: dshHome
    }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]

    const keySource = process.env.DEEPSEEK_API_KEY
      ? '桌面设置页（kernel-env.json）'
      : llm.LLM_API_KEY
        ? 'kernel/.env'
        : '无（退回 DSH 凭据文件 $DSH_HOME/.credentials.yaml）'
    logToFile(
      '[planner-manager] LLM: key =',
      apiKey ? `****${apiKey.slice(-4)}` : '(未设置)',
      '| 来源 =',
      keySource,
      '| base =',
      baseUrl ?? '(默认)',
      '| 请求模型 =',
      modelName ?? '(默认)'
    )

    logToFile(
      '[planner-manager] start: 运行时 =',
      runtime.kind,
      '| 入口 =',
      runtime.entry,
      '| launcher =',
      runtime.launcher,
      '| cwd =',
      runtime.cwd,
      '| DSH_HOME =',
      dshHome ?? '(默认 ~/.dsh)',
      '| port =',
      this.port
    )
    // 随包闭包用 Electron 自带 Node（用户机器上没有 node）：
    // ELECTRON_RUN_AS_NODE=1 后 process.execPath 就是 Node 运行时，无需安装 Node、无需 tsx。
    const spawnCmd =
      runtime.launcher === 'electron-node'
        ? { file: process.execPath, args: [runtime.entry, '--profile', 'lcode-planner'] }
        : { file: 'node', args: ['--import', 'tsx/esm', runtime.entry, '--profile', 'lcode-planner'] }
    if (runtime.launcher === 'electron-node') env.ELECTRON_RUN_AS_NODE = '1'
    this.proc = spawn(spawnCmd.file, spawnCmd.args, {
      cwd: runtime.cwd,
      env,
      stdio: 'pipe',
      windowsHide: true
    })
    const pid = this.proc.pid ?? -1
    logToFile('[planner-manager] 规划器已启动 pid=', pid)
    this.proc.stdout?.on('data', (d) => logToFile('[planner]', String(d).trimEnd()))
    this.proc.stderr?.on('data', (d) => logToFile('[planner]', String(d).trimEnd()))

    this.proc.on('exit', (code, signal) => {
      const wasStopped = this.stopping
      this.proc = null
      this.startedAt = null
      this.stopHealthCheck()
      logToFile('[planner-manager] 规划器进程退出 pid=', pid, 'code=', code, 'signal=', signal, '| stopping=', wasStopped)
      if (wasStopped) {
        this.status = 'stopped'
        this.emit()
        return
      }
      this.status = 'crashed'
      this.restarts += 1
      this.lastError = `规划器退出 code=${code} signal=${signal}`
      this.emit()
      if (this.restarts <= MAX_RESTARTS) {
        setTimeout(() => void this.start(kernelUrl, kernelToken), 1500)
      } else {
        this.lastError = `连续重启超过 ${MAX_RESTARTS} 次，停止尝试`
        this.emit()
      }
    })
    this.proc.on('error', (err) => {
      logToFile('[planner-manager] spawn error pid=', pid, err instanceof Error ? err.message : String(err))
    })
    this.startHealthCheck()
  }

  private startHealthCheck(): void {
    this.stopHealthCheck()
    this.healthTimer = setInterval(async () => {
      if (!this.proc) return
      const ok = await this.checkHealth()
      if (ok) {
        if (this.status !== 'running') {
          logToFile('[planner-manager] 健康检查通过，规划器就绪 pid=', this.proc.pid)
          this.status = 'running'
          this.startedAt = Date.now()
          this.fails = 0
          this.emit()
          // 就绪后拉一次 LLM 身份：这才是"对话真正在用"的模型与 Key（设置页只是请求值）
          void this.logLlmIdentity()
        } else {
          this.fails = 0
        }
      } else {
        this.fails += 1
        if (this.fails >= MAX_FAILS_BEFORE_RESTART) {
          this.lastError = '健康检查连续失败，判定规划器无响应，重启'
          logToFile('[planner-manager] 判定规划器无响应，执行重启（health 失败）')
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
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
      const res = await fetch(`http://127.0.0.1:${this.port}/api/planner/health`, {
        signal: ctrl.signal,
        headers: { 'X-Planner-Token': this.token }
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  /** 规划器自报的 LLM 身份（模型 / base / Key 末 4 位）；不可用时返回 null。 */
  async llmInfo(): Promise<PlannerLlmInfo | null> {
    if (!this.port) return null
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/planner/health`, {
        headers: { 'X-Planner-Token': this.token }
      })
      if (!res.ok) return null
      const j = (await res.json()) as Partial<PlannerLlmInfo>
      return {
        model: String(j.model ?? ''),
        requested_model: String(j.requested_model ?? ''),
        llm_base_url: String(j.llm_base_url ?? ''),
        api_key_tail: String(j.api_key_tail ?? ''),
        api_key_source: String(j.api_key_source ?? '')
      }
    } catch {
      return null
    }
  }

  /** 把"对话实际在用什么"写进日志：排查 Key/模型不生效时，这一行是权威结论。 */
  private async logLlmIdentity(): Promise<void> {
    const info = await this.llmInfo()
    if (!info) return
    logToFile(
      '[planner-manager] 规划器生效配置: 模型 =',
      info.model || '-',
      '| 设置页请求 =',
      info.requested_model || '(未设置)',
      '| key =',
      info.api_key_tail || '(无，走 DSH 凭据文件)',
      '| base =',
      info.llm_base_url || '(默认)'
    )
    if (info.requested_model && info.requested_model !== info.model) {
      logToFile(
        '[planner-manager] 注意: 设置页选的模型',
        info.requested_model,
        '在规划器侧被改写为',
        info.model,
        '（规划器只认 v4 型号；服务端两者解析到同一档位）'
      )
    }
    this.effectiveModel = info.model || undefined
    this.emit()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const proc = this.proc
    if (proc) {
      try {
        if (this.port) {
          await fetch(`http://127.0.0.1:${this.port}/api/planner/shutdown`, {
            method: 'POST',
            headers: { 'X-Planner-Token': this.token }
          }).catch(() => undefined)
        }
      } finally {
        this.killProc(proc)
      }
    }
  }

  /**
   * 重启规划器（内核重启后联动：换地址/令牌重建规划器子进程）。
   * stop() 发 shutdown+kill 后立即返回、exit 异步触发；须等旧进程真正退出，
   * 否则 start() 会因 this.proc 仍指向旧进程而早退（同 kernel-manager restart 教训）。
   */
  async restart(kernelUrl: string, kernelToken: string): Promise<void> {
    // 日志区分三种场景，便于读 main.log 时定位（此前一律写"地址变更"，冷启动首次绑定也被写成变更）
    const why =
      this.kernelUrl === ''
        ? '首次绑定内核 → 启动规划器'
        : this.kernelUrl === kernelUrl
          ? '规划器未就绪 → 按同一内核地址重建'
          : '内核地址变更 → 联动重启规划器'
    logToFile(`[planner-manager] restart: ${why}（内核地址 =`, kernelUrl, '）')
    await this.stop()
    const deadline = Date.now() + 5000
    while (this.proc && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (this.proc) {
      logToFile('[planner-manager] restart 等待旧进程退出超时，强制继续')
    }
    this.kernelUrl = ''
    this.kernelToken = ''
    await this.start(kernelUrl, kernelToken)
  }

  /** 规划器未就绪时返回 null（调用方走错误分支） */
  private client(): PlannerHttpClient | null {
    return this.baseUrl ? new PlannerHttpClient(this.baseUrl, this.token) : null
  }

  async chat(message: string, sessionId = '', fullAccess?: boolean, planMode?: boolean, reasoningEffort?: string, cwd?: string, delivery?: 'queue' | 'steer'): Promise<{ session_id: string; status: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.chat(message, sessionId, fullAccess, planMode, reasoningEffort, cwd, delivery)
  }

  /** 运行中待发送队列（DSH QueueDock 同源数据：agent inbox 投影）。 */
  async getChatQueue(sessionId: string): Promise<{ session_id: string; items: { id: string; text: string; placement: 'next-turn' | 'next-step' }[] }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.getChatQueue(sessionId)
  }

  /** 删除待发送队列中的一条消息。 */
  async removeChatQueueItem(sessionId: string, messageId: string): Promise<{ session_id: string; message_id: string; removed: boolean }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.removeChatQueueItem(sessionId, messageId)
  }

  async cancelChat(sessionId: string): Promise<{ status: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.cancelChat(sessionId)
  }

  /** 会话分支（阶段4 W4）：内核复制前缀开新会话 + 规划器登记 agent，返回新会话 ID。 */
  async forkChat(sessionId: string, atMessageId: number): Promise<{ session_id: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.forkChat(sessionId, atMessageId)
  }

  async setChatAccess(sessionId: string, fullAccess: boolean): Promise<{ status: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.setChatAccess(sessionId, fullAccess)
  }

  /** 会话级推理等级即时切换（off/high/max）。 */
  async setChatEffort(sessionId: string, reasoningEffort: string): Promise<{ session_id: string; reasoning_effort: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.setChatEffort(sessionId, reasoningEffort)
  }

  /** 会话 plan-mode 当前状态（planner agent 权威值；未登记=false）。 */
  async getChatPlanState(sessionId: string): Promise<{ session_id: string; plan_active: boolean }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.getChatPlanState(sessionId)
  }

  /** Plan-mode 即时切换（对齐 DSH /plan、/plan off：直接翻转 agent 状态，无需等下一条消息）。 */
  async setChatPlanMode(sessionId: string, planActive: boolean): Promise<{ session_id: string; plan_active: boolean; plan_pending: boolean; outcome: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.setChatPlanMode(sessionId, planActive)
  }

  /** 会话确认结束后显式启动烧录（防误烧；Phase 2）。 */
  async confirmFlash(sessionId: string, projectDir: string, port: string): Promise<{ session_id: string; status: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.confirmFlash(sessionId, projectDir, port)
  }

  /** 取消待烧录（清除登记，不执行）。 */
  async dismissFlash(sessionId: string): Promise<{ session_id: string; status: string }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.dismissFlash(sessionId)
  }

  /** M3 · 轮询取件：待应答人机交互（approval/questions）。 */
  async listInteractions(sessionId?: string): Promise<{ interactions: unknown[] }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.listInteractions(sessionId)
  }

  /** 规划器当前登记的会话列表（内存态；启动时为空 —— 用于启动清理判断）。 */
  async listSessions(): Promise<{ sessions: { session_id: string; busy: boolean; reasoning_effort?: string }[] }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.listSessions()
  }

  /** M3 · 桌面应答：approval outcome 或 questions answers。 */
  async answerInteraction(
    id: string,
    answer: { kind: 'approval'; outcome: string } | { kind: 'questions'; answers: { id: string; selected: string[]; custom?: string }[] },
  ): Promise<{ answered: boolean }> {
    const c = this.client()
    if (!c) throw new Error('规划器未就绪')
    return c.answerInteraction(id, answer)
  }

  private killProc(proc: ChildProcess): void {
    logToFile('[planner-manager] killProc pid=', proc.pid)
    proc.kill()
    setTimeout(() => {
      if (this.proc === proc && proc.exitCode === null) {
        logToFile('[planner-manager] killProc SIGKILL 兜底 pid=', proc.pid)
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

/** 规划器本地 HTTP 客户端（对话路由；事件/消息/状态由规划器写入内核，桌面轮询内核不变） */
class PlannerHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Planner-Token': this.token
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const j = (await res.json()) as { detail?: string }
        if (typeof j.detail === 'string') detail = j.detail
      } catch { /* keep status text */ }
      throw new Error(`planner ${method} ${path} -> ${res.status}: ${detail}`)
    }
    return (await res.json()) as T
  }

  chat(message: string, sessionId: string, fullAccess?: boolean, planMode?: boolean, reasoningEffort?: string, cwd?: string, delivery?: 'queue' | 'steer'): Promise<{ session_id: string; status: string }> {
    const body: Record<string, unknown> = { message }
    if (sessionId) body.session_id = sessionId
    else {
      if (fullAccess !== undefined) body.full_access = fullAccess
      // 新建会话绑定工作区（否则规划器回落到内核 outputs_dir）
      if (cwd !== undefined && cwd !== '') body.cwd = cwd
    }
    if (planMode !== undefined) body.plan_mode = planMode
    if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
    // 运行中投递方式（DSH：queue=Enter 排队 / steer=Ctrl+Enter 立即投递）；空闲会话忽略
    if (sessionId && delivery !== undefined) body.delivery = delivery
    return this.request('POST', '/api/planner/chat', body)
  }

  /** 运行中待发送队列（agent inbox 投影）。 */
  getChatQueue(sessionId: string): Promise<{ session_id: string; items: { id: string; text: string; placement: 'next-turn' | 'next-step' }[] }> {
    return this.request('GET', `/api/planner/queue?session_id=${encodeURIComponent(sessionId)}`)
  }

  /** 删除待发送队列中的一条消息（DSH QueueDock 删除项）。 */
  removeChatQueueItem(sessionId: string, messageId: string): Promise<{ session_id: string; message_id: string; removed: boolean }> {
    return this.request('POST', '/api/planner/queue_remove', { session_id: sessionId, message_id: messageId })
  }

  cancelChat(sessionId: string): Promise<{ status: string }> {
    return this.request('POST', '/api/planner/cancel', { session_id: sessionId })
  }

  forkChat(sessionId: string, atMessageId: number): Promise<{ session_id: string }> {
    return this.request('POST', '/api/planner/fork', { session_id: sessionId, at_message_id: atMessageId })
  }

  setChatAccess(sessionId: string, fullAccess: boolean): Promise<{ status: string }> {
    return this.request('POST', '/api/planner/access', { session_id: sessionId, full_access: fullAccess })
  }

  /** 会话级推理等级即时切换（off/high/max）。 */
  setChatEffort(sessionId: string, reasoningEffort: string): Promise<{ session_id: string; reasoning_effort: string }> {
    return this.request('POST', '/api/planner/effort', { session_id: sessionId, reasoning_effort: reasoningEffort })
  }

  /** 会话 plan-mode 当前状态（planner agent 权威值；未登记=false）。 */
  getChatPlanState(sessionId: string): Promise<{ session_id: string; plan_active: boolean }> {
    return this.request('GET', `/api/planner/plan_state?session_id=${encodeURIComponent(sessionId)}`)
  }

  /** Plan-mode 即时切换（对齐 DSH /plan、/plan off：直接翻转 agent 状态，无需等下一条消息）。 */
  setChatPlanMode(sessionId: string, planActive: boolean): Promise<{ session_id: string; plan_active: boolean; plan_pending: boolean; outcome: string }> {
    return this.request('POST', '/api/planner/planmode', { session_id: sessionId, plan_active: planActive })
  }

  confirmFlash(sessionId: string, projectDir: string, port: string): Promise<{ session_id: string; status: string }> {
    return this.request('POST', '/api/planner/flash_confirm', { session_id: sessionId, project_dir: projectDir, port })
  }

  dismissFlash(sessionId: string): Promise<{ session_id: string; status: string }> {
    return this.request('POST', '/api/planner/flash_dismiss', { session_id: sessionId })
  }

  listInteractions(sessionId?: string): Promise<{ interactions: unknown[] }> {
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return this.request('GET', `/api/planner/interactions${qs}`)
  }

  listSessions(): Promise<{ sessions: { session_id: string; busy: boolean }[] }> {
    return this.request('GET', '/api/planner/sessions')
  }

  answerInteraction(
    id: string,
    answer: { kind: 'approval'; outcome: string } | { kind: 'questions'; answers: { id: string; selected: string[]; custom?: string }[] },
  ): Promise<{ answered: boolean }> {
    return this.request('POST', '/api/planner/interactions/answer', { id, ...answer })
  }
}
