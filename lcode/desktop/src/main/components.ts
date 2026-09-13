/**
 * 组件载荷（ESP-IDF / 知识库）——"单独下载安装"的扩展件。
 *
 * 为什么要有这层：
 * 1. **安装包不能太大**：NSIS 的数据块上限是 2 GiB，实测超出后安装包能打出来、但安装时
 *    崩溃（exit 0xC0000005，一个文件都装不进去）。所以 ESP-IDF（2.4 GB）与知识库
 *    （含 torch，1.4 GB）都不该直接塞进安装目录，而是各自打成**单个归档**（zip）随包或单独下载，
 *    首次运行时解压到用户目录。
 * 2. **冻结内核不能 pip install**：打包后的内核是 PyInstaller 冻结产物，Python 运行时在包里。
 *    知识库因此以"目录"形式提供：解压到组件目录后，内核把 `<dir>/site-packages` 与 `<dir>`
 *    插进 sys.path（见 lcode/kernel/rag/backend.py），`import lcode_kb` 即可成功。
 *    实测：`--no-kb` 冻结内核 + 外部载荷目录 = `kb_backend=private, kb_docs=634`。
 * 3. **解压到用户目录**还能避开安装目录（Program Files）的写权限问题。
 *
 * 组件目录布局（解压目标）：
 *   esp-idf → <userData>/components/esp-idf/{manifest.json,framework/,.espressif/,python310/}
 *   kb      → <userData>/components/kb/{manifest.json,lcode_kb/,site-packages/,data/rag_store/}
 */
import { app, dialog } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type ComponentName = 'esp-idf' | 'kb'
export const COMPONENT_NAMES: ComponentName[] = ['esp-idf', 'kb']

/** 组件元信息：随包归档名、界面文案用的说明 */
export const COMPONENT_INFO: Record<ComponentName, { zipName: string; label: string }> = {
  'esp-idf': { zipName: 'esp-idf-payload.zip', label: 'ESP-IDF 编译环境' },
  kb: { zipName: 'kb-payload.zip', label: '领域知识库（手册检索）' }
}

export interface ComponentStatus {
  name: ComponentName
  installed: boolean
  dir: string
  version: string
  /** 随包归档路径（存在则可一键安装）；空 = 需用户自备 */
  bundledZip: string
  bytes: number
  /** 安装/未安装的原因或提示 */
  note: string
}

function resourcesDir(): string {
  // 开发模式：<repo>/lcode/desktop/resources；打包后：<安装目录>/resources
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

export function componentsRoot(): string {
  return path.join(app.getPath('userData'), 'components')
}

export function componentDir(name: ComponentName): string {
  return path.join(componentsRoot(), name)
}

/** 随包归档位置（安装包里带的那份；没有则返回空串） */
export function bundledZipFor(name: ComponentName): string {
  const candidates = [
    path.join(resourcesDir(), COMPONENT_INFO[name].zipName),
    path.join(resourcesDir(), `${name}.zip`)
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  // 也接受"已经解压好的随包目录"（旧方案 / 手工放）：标记为已就绪但不算 installed
  return ''
}

/** 随包已解压目录（resources/esp-idf 这类，旧方案兼容） */
export function bundledDirFor(name: ComponentName): string {
  const p = path.join(resourcesDir(), name)
  return fs.existsSync(path.join(p, 'manifest.json')) ? p : ''
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    const f = path.join(dir, 'manifest.json')
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function componentStatus(name: ComponentName): ComponentStatus {
  const dir = componentDir(name)
  const manifest = readManifest(dir)
  const zip = bundledZipFor(name)
  let bytes = 0
  if (manifest) {
    try {
      bytes = Number((manifest['bytes'] as Record<string, number> | undefined)?.['total'] ?? 0)
    } catch {
      bytes = 0
    }
  }
  const version = manifest
    ? String(manifest['idf_version'] ?? manifest['version'] ?? '已安装')
    : ''
  return {
    name,
    installed: manifest !== null,
    dir,
    version,
    bundledZip: zip,
    bytes,
    note: manifest ? '' : zip ? '随安装包提供，可一键安装' : '需要单独的组件包（zip）'
  }
}

export function allComponentStatus(): ComponentStatus[] {
  return COMPONENT_NAMES.map((n) => componentStatus(n))
}

/**
 * 从 zip 安装组件：解压到组件目录，校验 manifest.json。
 * 用 Windows 自带的 bsdtar（tar.exe）解压：zip / tar.xz 都支持，且比 PowerShell 的
 * Expand-Archive 快很多（2.4 GB 实测 ~2 分钟）。
 */
export function installComponentFromZip(
  name: ComponentName,
  zipPath: string,
  log?: (...a: unknown[]) => void
): { ok: boolean; message: string } {
  if (!fs.existsSync(zipPath)) return { ok: false, message: `组件包不存在：${zipPath}` }
  const dest = componentDir(name)
  try {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
  } catch (e) {
    return { ok: false, message: `无法准备组件目录：${e instanceof Error ? e.message : String(e)}` }
  }
  const r = spawnSync('tar', ['-xf', zipPath, '-C', dest], { windowsHide: true, stdio: 'pipe' })
  if (r.error || r.status !== 0) {
    const err = r.error ? r.error.message : String(r.stderr ?? '')
    return { ok: false, message: `解压失败（tar exit=${r.status}）：${err.slice(0, 300)}` }
  }
/** zip 里若多套了一层目录（如 esp-idf/…），把内容提升一层 */
function hoistSingleRoot(dest: string): void {
  if (fs.existsSync(path.join(dest, 'manifest.json'))) return
  const entries = fs.readdirSync(dest, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const e of entries) {
    const sub = path.join(dest, e.name)
    if (fs.existsSync(path.join(sub, 'manifest.json'))) {
      for (const child of fs.readdirSync(sub)) {
        fs.renameSync(path.join(sub, child), path.join(dest, child))
      }
      fs.rmSync(sub, { recursive: true, force: true })
      return
    }
  }
}

/**
 * 解压后的路径修正。
 *
 * ESP-IDF 组件的 `python_env/pyvenv.cfg` 里 `home = <基础 Python 路径>`，而打包时那个路径是
 * **暂存目录**（`lcode/desktop/resources/esp-idf/python310`）。解压到用户目录后该路径不存在，
 * venv 会加载不到 python3xx.dll / 标准库 → 「装完编译不了」。
 * 这里把 home 重写到组件目录内的 python310（实测：不修的话本机因暂存目录还在而"碰巧能用"，
 * 换台机器就废）。
 */
function postInstallFixup(name: ComponentName, dest: string, log?: (...a: unknown[]) => void): void {
  if (name !== 'esp-idf') return
  const basePy = path.join(dest, 'python310')
  const cfg = path.join(dest, '.espressif', 'python_env', 'pyvenv.cfg')
  try {
    if (!fs.existsSync(basePy) || !fs.existsSync(cfg)) return
    const txt = fs.readFileSync(cfg, 'utf-8')
    const fixed = txt.replace(/^home\s*=.*$/m, `home = ${basePy}`)
    if (fixed !== txt) {
      fs.writeFileSync(cfg, fixed, 'utf-8')
      log?.('[components] 已修正 pyvenv.cfg home →', basePy)
    }
  } catch (e) {
    log?.('[components] pyvenv.cfg 修正失败（忽略）:', e instanceof Error ? e.message : String(e))
  }
}
  hoistSingleRoot(dest)
  postInstallFixup(name, dest)
  if (!fs.existsSync(path.join(dest, 'manifest.json'))) {
    return { ok: false, message: '解压完成但没找到 manifest.json（组件包结构不对？）' }
  }
  const st = componentStatus(name)
  return { ok: true, message: `${COMPONENT_INFO[name].label} 已安装（${st.version || 'ok'}）` }
}

/** 让用户挑一个组件包并安装 */
export async function pickAndInstallComponent(name: ComponentName): Promise<{ ok: boolean; message: string } | null> {
  const res = await dialog.showOpenDialog({
    title: `选择 ${COMPONENT_INFO[name].label} 组件包`,
    properties: ['openFile'],
    filters: [
      { name: '组件包', extensions: ['zip'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return installComponentFromZip(name, res.filePaths[0], (...a) => console.log(...a))
}

/**
 * 组件对应的内核环境变量。交给 process.env（子进程继承）与 kernel-env.json（持久化）两条路。
 */
export function componentEnv(name: ComponentName): Record<string, string> {
  const dir = componentDir(name)
  if (!readManifest(dir)) return {}
  if (name === 'kb') {
    return { LCODE_KB_PAYLOAD: dir, LCODE_KB_BACKEND: 'auto' }
  }
  const env: Record<string, string> = { IDF_PATH: path.join(dir, 'framework') }
  const tools = path.join(dir, '.espressif')
  if (fs.existsSync(tools)) env.IDF_TOOLS_PATH = tools
  const pyEnv = path.join(tools, 'python_env')
  if (fs.existsSync(pyEnv)) env.IDF_PYTHON_ENV_PATH = pyEnv
  return env
}

/** 已安装组件全部注入 process.env（内核/规划器子进程启动时继承） */
export function applyComponentEnv(): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const name of COMPONENT_NAMES) {
    const env = componentEnv(name)
    for (const [k, v] of Object.entries(env)) {
      if (!process.env[k]) process.env[k] = v
      merged[k] = v
    }
  }
  return merged
}

/** 首次运行：随包归档存在且组件未安装 → 自动安装（用户无需操作） */
export function autoInstallBundledComponents(log: (...args: unknown[]) => void): Record<string, string> {
  const installed: Record<string, string> = {}
  for (const name of COMPONENT_NAMES) {
    if (componentStatus(name).installed) continue
    const zip = bundledZipFor(name)
    if (!zip) continue
    log(`[components] 首次安装 ${name}（来自随包归档 ${path.basename(zip)}）...`)
    const r = installComponentFromZip(name, zip, log)
    log(`[components] ${name}: ${r.ok ? r.message : '失败 ' + r.message}`)
    if (r.ok) {
      const env = componentEnv(name)
      for (const [k, v] of Object.entries(env)) {
        process.env[k] = v
        installed[k] = v
      }
    }
  }
  return installed
}
