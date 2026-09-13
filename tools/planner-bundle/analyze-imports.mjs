#!/usr/bin/env node
/**
 * Static runtime import-closure analyzer for the planner bundle.
 *
 * Roots: the built apps/cli/lib chunks + the precompiled planner output.
 * Walks ESM/CJS specifiers inside each package's PUBLISHED runtime surface
 * (package.json `files` globs when present, else lib/ then main), so a
 * workspace package's src/ and tests/ (which import devDependencies) do not
 * pollute the closure. Reports the kept package set and its byte size.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const DSH = process.env.LCORE_DSH_REPO ?? 'D:\\1_ai_project\\deepseek\\deepseek-harness-master'
const CLI_LIB = join(DSH, 'apps', 'cli', 'lib')
const PLANNER_BUILT = process.argv[2] ?? join(join(DSH, '..', '..', '_planner_bundle_build'), 'planner-build')
const PLANNER_SRC = process.env.LCORE_PLANNER_SRC
  ?? join(new URL('.', import.meta.url).pathname.replace(/^\//, ''), '..', '..', 'lcode', 'planner')
/** Where the planner's own dev-time hoisted farm lives; models the flat shipped layout. */
const PLANNER_ANCHOR = join(PLANNER_SRC, 'package.json')

const SPEC_RE = /(?:^|[\s;{(=])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

function* specifiers(code) {
  SPEC_RE.lastIndex = 0
  let m
  while ((m = SPEC_RE.exec(code)) !== null) {
    yield m[1] ?? m[2] ?? m[3] ?? m[4]
  }
}

const isBare = (s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:')

/** Expand a minimal `files` glob list (dir, dir/**, *.js, lib/*.js) into real file paths. */
function expandFiles(pkgDir, patterns) {
  const out = new Set()
  const walk = (d, filter) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, filter)
      else if (e.isFile() && (filter === null || filter(e.name))) out.add(p)
    }
  }
  for (const raw of patterns) {
    const pat = raw.replace(/^\.\//, '')
    if (pat === '**' || pat === '**/*' || pat === '*' || pat === '') { walk(pkgDir, null); continue }
    const abs = join(pkgDir, pat)
    if (pat.endsWith('/**') || pat.endsWith('/*')) {
      walk(join(pkgDir, pat.replace(/\/\*\*?$/, '')), null)
    } else if (existsSync(abs)) {
      try { if (statSync(abs).isDirectory()) walk(abs, null); else out.add(abs) } catch { /* ignore */ }
    }
  }
  return [...out]
}

function runtimeFiles(pkgDir) {
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { /* ignore */ }
  const pats = Array.isArray(manifest.files) ? manifest.files : []
  let files = pats.length > 0 ? expandFiles(pkgDir, pats) : []
  if (files.length === 0) {
    const libDir = join(pkgDir, 'lib')
    if (existsSync(libDir)) files = expandFiles(pkgDir, ['lib'])
    else if (existsSync(join(pkgDir, 'dist'))) files = expandFiles(pkgDir, ['dist'])
    else if (typeof manifest.main === 'string' && existsSync(join(pkgDir, manifest.main))) files = [join(pkgDir, manifest.main)]
  }
  // Always include package.json itself; never include tsbuildinfo/maps in the scan.
  return files.filter(f => /\.(js|mjs|cjs|json)$/.test(f) && !f.endsWith('.tsbuildinfo'))
}

const kept = new Map() // packageName -> dir
const queue = []
const seenFiles = new Set()

function enqueueFile(file) {
  const real = (() => { try { return realpathSync(file) } catch { return file } })()
  if (seenFiles.has(real)) return
  seenFiles.add(real)
  queue.push(file)
}

function addPackage(name, dir) {
  if (kept.has(name)) return
  kept.set(name, dir)
  for (const f of runtimeFiles(dir)) enqueueFile(f)
}

const require0 = createRequire(join(CLI_LIB, 'bin.js'))
for (const name of ['@deepseek-ai/dsh-app-boot', 'commander']) {
  const dir = packageDirFromAnchor(join(CLI_LIB, 'bin.js'), name)
  if (dir) addPackage(name, dir)
}
// The two loader-by-name plugins profile-boot mounts when the composition has no HMR row.
for (const name of ['@deepseek-ai/cordis-plugin-hmr', '@deepseek-ai/cordis-plugin-timer', '@lcode/planner']) {
  const dir = packageDirFromAnchor(join(CLI_LIB, 'bin.js'), name)
  if (dir) addPackage(name, dir)
}

// Every built CLI chunk is a root: bin.js lazy-imports them.
for (const f of readdirSync(CLI_LIB)) if (f.endsWith('.js')) enqueueFile(join(CLI_LIB, f))
// The precompiled planner.
if (existsSync(PLANNER_BUILT)) for (const f of expandFiles(PLANNER_BUILT, ['**'])) if (/\.(js|mjs|cjs)$/.test(f)) enqueueFile(f)

function packageDirFromAnchor(anchor, name) {
  const real = (() => { try { return realpathSync(anchor) } catch { return anchor } })()
  for (const searchPath of createRequire(real).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Derive a package root from an already-resolved file path by walking up to the
 * nearest package.json. Needed for subpath exports (`pkg/stream`) and for pnpm's
 * virtual store, where the directory name is not the package name.
 */
function packageDirFromResolved(resolvedPath) {
  let d = dirname(resolvedPath)
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(d, 'package.json'))) return d
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return undefined
}

/** The package name a specifier belongs to (`@scope/name` or `name`). */
function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const BUILTINS = new Set([
  'fs', 'fs/promises', 'path', 'os', 'events', 'util', 'url', 'crypto', 'http', 'https', 'net', 'tls',
  'stream', 'stream/promises', 'zlib', 'child_process', 'worker_threads', 'module', 'assert', 'buffer',
  'process', 'readline', 'tty', 'string_decoder', 'querystring', 'timers', 'timers/promises', 'dns',
  'async_hooks', 'perf_hooks', 'v8', 'vm', 'inspector', 'constants', 'punycode', 'diagnostics_channel',
  'cluster', 'dgram', 'repl', 'trace_events', 'wasi', 'test', 'sqlite', 'sea',
])

const unresolved = new Set()

/**
 * 按包名在 DSH 的 pnpm 虚拟store / workspace 里定位实际目录。
 *
 * 为什么需要兜底：锚点解析（createRequire(paths)）只覆盖"当前 farm 里看得见"的包。
 * 实测踩过：`lcode/planner/node_modules` 这层 farm 被 pnpm 重写后，
 * planner 预编译产物 import 的 `@deepseek-ai/dsh-sandbox-policy`（它**不在** CLI 的依赖闭包里）
 * 就解析不到 → 进 unresolved → 闭包少一个包 → 用户机上启动即
 * `Cannot find package '@deepseek-ai/dsh-sandbox-policy'`。按包名扫 store 能拿到它的真实目录，
 * 且不依赖任何 farm 的当前状态。
 */
function findInStore(name) {
  const store = join(DSH, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const cand = join(store, entry, 'node_modules', name)
      if (existsSync(join(cand, 'package.json'))) return cand
    }
  }
  // workspace 包：packages/<group>/<dir> —— **不能**按包名猜目录名
  // （包名是 `@deepseek-ai/dsh-sandbox-policy`，目录是 `sandbox-policy`，`dsh-` 前缀不在目录上），
  // 必须读每个 package.json 的 name 对比。
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
  return undefined
}

while (queue.length > 0) {
  const file = queue.pop()
  let code
  try { code = readFileSync(file, 'utf8') } catch { continue }
  for (const spec of specifiers(code)) {
    if (!isBare(spec)) continue
    if (BUILTINS.has(spec) || BUILTINS.has(spec.replace(/^node:/, ''))) continue
    // Node realpaths modules on load (preserveSymlinks=false), so resolve from
    // the real file: pnpm's symlinked package dirs only see their own deps there.
    // The precompiled planner is not inside a node_modules yet. In the shipped
    // flat layout every package resolves every other from one flat
    // node_modules, so resolution is tried against a chain of real anchors:
    // the file's own location, the planner's dev anchor, then the CLI's.
    const anchors = []
    if (file.startsWith(PLANNER_BUILT)) anchors.push(join(PLANNER_SRC, 'package.json'))
    try { anchors.push(realpathSync(file)) } catch { anchors.push(file) }
    anchors.push(PLANNER_ANCHOR, join(CLI_LIB, 'bin.js'))
    let resolved
    let dir
    for (const anchor of anchors) {
      try { resolved = createRequire(anchor).resolve(spec) } catch { continue }
      dir = packageDirFromAnchor(anchor, spec) ?? packageDirFromResolved(resolved)
      if (dir !== undefined) break
    }
    if (dir === undefined || resolved === undefined) {
      const fallback = findInStore(packageNameOf(spec))
      if (fallback === undefined) { unresolved.add(spec); continue }
      addPackage(packageNameOf(spec), fallback)
      // 兜底命中时没有 resolved 文件，改扫该包的发布面，让它的依赖继续被追踪
      for (const f of runtimeFiles(fallback)) enqueueFile(f)
      continue
    }
    addPackage(packageNameOf(spec), dir)
    enqueueFile(resolved)
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

// Second pass: native/binary packages are loaded at runtime by path probes or
// dynamic require, never by a static specifier, so the import scan cannot see
// them. Union in each kept package's installed optionalDependencies -- that is
// exactly where split-out prebuilt binaries live (koffi -> @koromix/koffi-*).
// Only entries that actually resolve for this platform are added.
const optionalAdded = []
for (const [name, dir] of [...kept.entries()]) {
  let manifest
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    if (kept.has(dep)) continue
    let opted
    for (const anchor of [join(dir, 'package.json'), PLANNER_ANCHOR, join(CLI_LIB, 'bin.js')]) {
      opted = packageDirFromAnchor(anchor, dep)
      if (opted !== undefined) break
    }
    if (opted === undefined) opted = findInStore(dep)   // farm 漂移时的兜底
    if (opted === undefined) continue
    optionalAdded.push(`${name} -> ${dep}`)
    addPackage(dep, opted)
  }
}
// Scan anything the optional pass pulled in.
while (queue.length > 0) {
  const file = queue.pop()
  let code
  try { code = readFileSync(file, 'utf8') } catch { continue }
  for (const spec of specifiers(code)) {
    if (!isBare(spec)) continue
    if (BUILTINS.has(spec) || BUILTINS.has(spec.replace(/^node:/, ''))) continue
    let dir
    for (const anchor of [PLANNER_ANCHOR, join(CLI_LIB, 'bin.js')]) {
      dir = packageDirFromAnchor(anchor, spec)
      if (dir !== undefined) break
    }
    if (dir === undefined) dir = findInStore(packageNameOf(spec))
    if (dir === undefined) continue
    addPackage(packageNameOf(spec), dir)
  }
}

const MB = 1024 * 1024
const rows = []
let total = 0
let totalPublished = 0
for (const [name, dir] of [...kept.entries()].sort()) {
  const { total: s } = dirSize(dir)
  let pub = 0, pubFiles = 0
  for (const f of runtimeFiles(dir)) {
    try { pub += statSync(f).size; pubFiles += 1 } catch { /* ignore */ }
  }
  // package.json is always shipped even when `files` omits it.
  try { pub += statSync(join(dir, 'package.json')).size; pubFiles += 1 } catch { /* ignore */ }
  total += s
  totalPublished += pub
  rows.push({ name, dir, size: s, pub, pubFiles })
}
console.log(`KEPT PACKAGES: ${kept.size}`)
console.log(`KEPT FULL-DIR BYTES:      ${(total / MB).toFixed(2)} MB`)
console.log(`KEPT PUBLISHED-FILE BYTES: ${(totalPublished / MB).toFixed(2)} MB (${rows.reduce((a, r) => a + r.pubFiles, 0)} files)`)
console.log(`UNRESOLVED BARE SPECIFIERS (${unresolved.size}): ${[...unresolved].sort().join(', ')}`)
console.log(`OPTIONAL DEPS ADDED (${optionalAdded.length}): ${optionalAdded.join(', ')}`)
console.log('\n=== BY SIZE ===')
for (const r of rows.sort((a, b) => b.size - a.size)) console.log(`${(r.size / MB).toFixed(3).padStart(8)} MB  ${(r.pub / MB).toFixed(3).padStart(8)} MBpub  ${r.name}`)
console.log('\n=== NAME LIST (for build script) ===')
console.log(JSON.stringify(rows.map(r => r.name)))

// Machine-readable manifest for the bundle builder.
writeFileSync(
  process.argv[3] ?? join(join(DSH, '..', '..', '_planner_bundle_build'), 'closure.json'),
  JSON.stringify({
    packages: rows.map(r => ({ name: r.name, dir: r.dir })),
    unresolved: [...unresolved].sort(),
    fullDirBytes: total,
    publishedBytes: totalPublished,
  }, null, 2) + '\n',
)
