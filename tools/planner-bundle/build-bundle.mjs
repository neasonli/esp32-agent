#!/usr/bin/env node
/**
 * Build the self-contained planner bundle from the analyzed closure.
 *
 * Layout produced (all paths relative to OUT):
 *   apps/cli/            built dsh CLI: package.json + lib/ + config/
 *   node_modules/<pkg>   the flat runtime closure (own files only, no symlinks)
 *   node_modules/@lcode/planner/  precompiled planner (index.js + cordis.patch.yml)
 *   home/profiles/lcode-planner/  the DSH_HOME profile skeleton
 *
 * Only the planner source is read for its cordis.patch.yml; every package body
 * is copied from the read-only DSH checkout (and pnpm's store), never modified.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DSH = process.env.LCORE_DSH_REPO ?? 'D:\\1_ai_project\\deepseek\\deepseek-harness-master'
const BUILD_ROOT = join(DSH, '..', '..', '_planner_bundle_build')
const PLANNER_SRC = process.env.LCORE_PLANNER_SRC
  ?? join(new URL('.', import.meta.url).pathname.replace(/^\//, ''), '..', '..', 'lcode', 'planner')
const PLANNER_BUILT = join(BUILD_ROOT, 'planner-build')
const OUT = process.argv[2]
  ?? join(new URL('.', import.meta.url).pathname.replace(/^\//, ''),
    '..', '..', 'lcode', 'desktop', 'resources', 'planner')
const HOME = join(OUT, 'home')

const t0 = Date.now()
const closure = JSON.parse(readFileSync(join(BUILD_ROOT, 'closure.json'), 'utf8'))

/** Copy a package's own files, skipping symlinked entries (those are separate closure members). */
function copyOwn(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) copyOwn(s, d)
    else if (e.isFile()) cpSync(s, d)
  }
}

function dirSize(root) {
  let total = 0, files = 0
  const stack = [root]
  while (stack.length > 0) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.isFile()) continue
      try { total += statSync(p).size; files += 1 } catch { /* ignore */ }
    }
  }
  return { total, files }
}

const steps = []
/** 闭包里解析不到实际目录的包（构建末尾必须为空，否则直接失败）。 */
const missing = []
/** 记录路径失效、但按包名在 DSH store / workspace 里重新找到的包（自愈记录）。 */
const relocated = []

/**
 * 解析一个闭包包的实际目录。
 *
 * 为什么需要：闭包分析（analyze-imports.mjs）会把包解析到**当时**存在的目录，常见是
 * `lcode/planner/node_modules/@deepseek-ai/*` 这层 pnpm farm。实测踩过：分析跑完之后
 * farm 被 `pnpm install` 重写过，27/90 个包的原路径失效 —— 旧实现只打一行 `MISSING`
 * 就继续，产出**残缺闭包**，装到用户机上才在运行时炸（还很难查）。
 * 现在：原路径失效 → 按包名回 DSH 的 `.pnpm` store / workspace 重新定位；
 * 都找不到 → 记入 missing，构建末尾直接 exit 1。
 */
function resolvePkgDir(name, dir) {
  if (existsSync(join(dir, 'package.json'))) return dir
  const store = join(DSH, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const cand = join(store, entry, 'node_modules', name)
      if (existsSync(join(cand, 'package.json'))) return cand
    }
  }
  // workspace 包：packages/<group>/<dir>。**不能**按包名猜目录名（包名带 `dsh-` 前缀、
  // 目录名不带），必须读 package.json 的 name 比对；扫两层即可（groups 数量有限）。
  const groups = join(DSH, 'packages')
  if (existsSync(groups)) {
    for (const g of readdirSync(groups)) {
      const gdir = join(groups, g)
      let subs
      try { subs = readdirSync(gdir, { withFileTypes: true }) } catch { continue }
      for (const s of subs) {
        if (!s.isDirectory()) continue
        const cand = join(gdir, s.name)
        try {
          if (JSON.parse(readFileSync(join(cand, 'package.json'), 'utf8')).name === name) return cand
        } catch { /* not this one */ }
      }
    }
  }
  return null
}

function step(label, fn) {
  const s = Date.now()
  fn()
  steps.push({ label, ms: Date.now() - s })
  console.log(`  [${String(Date.now() - s).padStart(6)} ms] ${label}`)
}

console.log(`=== BUILDING BUNDLE -> ${OUT} ===`)
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

step('apps/cli (package.json + lib + config)', () => {
  mkdirSync(join(OUT, 'apps', 'cli'), { recursive: true })
  cpSync(join(DSH, 'apps', 'cli', 'package.json'), join(OUT, 'apps', 'cli', 'package.json'))
  cpSync(join(DSH, 'apps', 'cli', 'lib'), join(OUT, 'apps', 'cli', 'lib'), { recursive: true })
  cpSync(join(DSH, 'apps', 'cli', 'config'), join(OUT, 'apps', 'cli', 'config'), { recursive: true })
  // Build metadata is not runtime surface.
  rmSync(join(OUT, 'apps', 'cli', 'lib', 'tsconfig.tsbuildinfo'), { force: true })
})

step(`node_modules closure (${closure.packages.length} packages)`, () => {
  for (const p of closure.packages) {
    const src = resolvePkgDir(p.name, p.dir)
    if (src === null) { missing.push(`${p.name}  (recorded: ${p.dir})`); continue }
    if (src !== p.dir) relocated.push(`${p.name} -> ${src}`)
    copyOwn(src, join(OUT, 'node_modules', p.name))
  }
})

step('@lcode/planner (precompiled)', () => {
  const dst = join(OUT, 'node_modules', '@lcode', 'planner')
  mkdirSync(dst, { recursive: true })
  cpSync(join(PLANNER_BUILT, 'index.js'), join(dst, 'index.js'))
  cpSync(join(PLANNER_SRC, 'cordis.patch.yml'), join(dst, 'cordis.patch.yml'))
  cpSync(join(PLANNER_SRC, 'README.md'), join(dst, 'README.md'))
  const manifest = JSON.parse(readFileSync(join(PLANNER_SRC, 'package.json'), 'utf8'))
  manifest.main = './index.js'
  manifest.exports = {
    '.': './index.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  }
  manifest.files = ['index.js', 'cordis.patch.yml', 'README.md']
  writeFileSync(join(dst, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
})

step('DSH_HOME profile skeleton', () => {
  const prof = join(HOME, 'profiles', 'lcode-planner')
  mkdirSync(prof, { recursive: true })
  writeFileSync(join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-lcode-planner',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@lcode/planner'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(prof, 'cordis.patch.yml'), '# L-CODE planner user patch layer (applied after the bundle layer).\n[]\n')
  // 注意（坑 4）：cordis.yml 由 DSH 每次启动自己重写，**不要**预置。
})

const manifest = {
  name: 'lcode-planner-bundle',
  version: JSON.parse(readFileSync(join(PLANNER_SRC, 'package.json'), 'utf8')).version,
  entry: 'apps/cli/lib/bin.js',
  dsh_home: 'home',
  built_at: new Date().toISOString(),
  platforms: [process.platform],
  requires_electron_node: '>=22.19.0',
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, undefined, 2) + '\n')

// 占位 README：本目录整份是**构建产物**，公开仓只保留这份说明（否则
// electron-builder 的 extraResources 找不到 from 目录会直接报错）。
writeFileSync(join(OUT, 'README.md'), `# planner bundle (构建产物，勿手工改)

本目录由 \`tools/planner-bundle/build-bundle.mjs\` 生成、\`tools/build-planner-bundle.ps1\` 调用：

    powershell -ExecutionPolicy Bypass -File tools\\build-planner-bundle.ps1

内容：DSH 已构建产物（\`apps/cli\`）+ 裁剪后的运行期依赖闭包（\`node_modules\`）
+ 预编译的 \`@lcode/planner\` + \`home/\`（DSH_HOME 骨架）+ \`manifest.json\`。

运行时桌面端会把它整份拷到 \`%APPDATA%\\LCode\\planner-runtime\`，再用
**Electron 自带 Node**（\`ELECTRON_RUN_AS_NODE=1\`）拉起 \`apps/cli/lib/bin.js --profile lcode-planner\`。
因此要求 Electron \`>=36.9.0\`（自带 Node \`>=22.19\`，DSH 的 engines 约束）。

公开仓**不含**本目录内容（\`.gitignore\` 与 \`tools/make-public-export.ps1\` 都排除），
用户按上面的命令自行生成即可；构建需要一份 DSH 源码 checkout（\`LCORE_DSH_REPO\`）。
`)

// 缺包 = 残缺闭包：宁可不产出，也不要装到用户机上才炸。
// 自愈（按包名回 store/workspace 找到）只提示，不算失败。
if (relocated.length > 0) {
  console.log(`\n[info] ${relocated.length} 个包的原路径失效，已按包名重新定位（闭包仍完整）：`)
  for (const r of relocated.slice(0, 8)) console.log(`   - ${r}`)
  if (relocated.length > 8) console.log(`   ... 其余 ${relocated.length - 8} 条省略`)
}
if (missing.length > 0) {
  console.error(`\n[FATAL] ${missing.length} 个闭包包找不到实际目录 —— 拒绝产出残缺闭包：`)
  for (const m of missing) console.error(`   - ${m}`)
  console.error(
    '\n提示：先在 DSH 仓与 lcode/planner 里把依赖装齐（pnpm install），' +
      '再重跑 analyze-imports.mjs 生成新的 closure.json，然后重新构建。'
  )
  process.exit(1)
}

step('第三方法务文件（每个随包依赖的许可证）', () => {
  const licDir = join(OUT, 'licenses')
  mkdirSync(licDir, { recursive: true })
  let copied = 0
  // DSH 本体是 MIT：再分发必须带 LICENSE 与其第三方 notices（DSH 仓根自带这两份）。
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const src = join(DSH, f)
    if (existsSync(src)) {
      cpSync(src, join(licDir, `DSH-${f}`))
      copied += 1
    }
  }
  // MIT/BSD/ISC 都要求"随分发保留许可证原文"：把每个随包依赖自带的许可证文件一起收进来。
  // 缺这份东西不影响运行，但属于分发合规红线，所以放在构建里自动做（别靠人记）。
  const missing = []
  for (const p of closure.packages) {
    const dir = resolvePkgDir(p.name, p.dir)
    if (dir === null) continue
    let files
    try { files = readdirSync(dir).filter((n) => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(n)) } catch { continue }
    if (files.length === 0) { missing.push(p.name); continue }
    const dst = join(licDir, p.name.replace('/', '__'))
    mkdirSync(dst, { recursive: true })
    for (const f of files) {
      cpSync(join(dir, f), join(dst, f))
      copied += 1
    }
  }
  console.log(`    收集 ${copied} 个许可证/notice 文件 -> licenses/`)
  if (missing.length > 0) {
    console.log(`    注意：${missing.length} 个包未自带许可证文件（多为 DSH 内部包，已由 DSH- LICENSE/NOTICES 覆盖）`)
  }
})

console.log(`\n=== SIZE BREAKDOWN ===`)
const groups = [
  ['DSH apps/cli (lib + config + package.json)', join(OUT, 'apps', 'cli')],
  ['DSH workspace packages/* (node_modules/@deepseek-ai, vendor pkgs)', join(OUT, 'node_modules', '@deepseek-ai')],
  ['third-party node_modules (the rest)', null],
  ['@lcode/planner body', join(OUT, 'node_modules', '@lcode', 'planner')],
  ['DSH_HOME profile skeleton', HOME],
]
const MB = 1024 * 1024
let accounted = 0
for (const [label, dir] of groups) {
  if (dir !== null) {
    const { total, files } = dirSize(dir)
    accounted += total
    console.log(`${label.padEnd(62)} ${(total / MB).toFixed(2).padStart(8)} MB  (${files} files)`)
  }
}
const all = dirSize(OUT)
const thirdParty = all.total - accounted
console.log(`${'third-party node_modules (the rest)'.padEnd(62)} ${(thirdParty / MB).toFixed(2).padStart(8)} MB`)
console.log(`${'TOTAL'.padEnd(62)} ${(all.total / MB).toFixed(2).padStart(8)} MB  (${all.files} files)`)
console.log(`\nbuild wall time: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log('per-step:', JSON.stringify(steps))
