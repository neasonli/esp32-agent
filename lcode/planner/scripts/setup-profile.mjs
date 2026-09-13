#!/usr/bin/env node
/**
 * 初始化 / 刷新 `lcode-planner` profile（agent核心开发文档 §1.9 落地形态）：
 *
 * 1. 在 `$DSH_HOME/profiles/lcode-planner/` 生成 profile 骨架
 *    （package.json 声明 bundles=[@lcode/planner] + file: 依赖本目录、cordis.patch.yml 用户层、
 *     pnpm-workspace.yaml：nodeLinker hoisted + autoInstallPeers false）。
 * 2. 经 `dsh plugin --profile lcode-planner install`（pnpm install + bundles 对账）
 *    把本包安装进 profile 的 node_modules。
 *
 * 之后即可：
 *   - 一次性会话：`pnpm dsh --profile lcode-planner "任务"`
 *   - 常驻 server：`pnpm dsh --profile lcode-planner`（由 Electron 网关 spawn）
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const DSH_REPO = process.env.LCORE_DSH_REPO || resolve(PKG_ROOT, '../../../deepseek/deepseek-harness-master')
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'lcode-planner')
const BIN = join(DSH_REPO, 'apps', 'cli', 'src', 'bin.ts')

const PATCH_TEMPLATE = `# lcode-planner 用户补丁层（可热重载；被 @lcode/planner bundle 覆盖后应用）。
# 需要调整装配（如 LLM 模型/权限）时优先在此覆盖，不要改 bundle。
[]
`

const WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

function manifest() {
  const m = {
    name: 'dsh-profile-lcode-planner',
    private: true,
    // link: 协议 → pnpm 符号链接到源码目录，开发期改代码即时生效（产品打包阶段再改 file: 实装）。
    dependencies: { '@lcode/planner': `link:${PKG_ROOT.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['@lcode/planner'] } },
  }
  return JSON.stringify(m, undefined, 2) + '\n'
}

function step(label) {
  process.stdout.write(`\n==> ${label}\n`)
}

step('定位 DSH checkout')
if (!existsSync(join(DSH_REPO, 'package.json'))) {
  throw new Error(`未找到 DSH checkout：${DSH_REPO}（请确认 lcode/planner 位于 mcu_ai_agent/lcode 下）`)
}
process.stdout.write(`DSH_REPO = ${DSH_REPO}\n`)

step(`初始化 profile 目录 ${PROFILE_DIR}`)
mkdirSync(PROFILE_DIR, { recursive: true })
if (!existsSync(join(PROFILE_DIR, 'cordis.patch.yml'))) {
  writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), PATCH_TEMPLATE)
}
if (!existsSync(join(PROFILE_DIR, 'pnpm-workspace.yaml'))) {
  writeFileSync(join(PROFILE_DIR, 'pnpm-workspace.yaml'), WORKSPACE_TEMPLATE)
}
writeFileSync(join(PROFILE_DIR, 'package.json'), manifest())

step('安装 @lcode/planner 到 profile（dsh plugin）')
const cmd = `node --import tsx/esm "${BIN}" plugin --profile lcode-planner install`
process.stdout.write(`$ ${cmd}\n`)
execSync(cmd, { stdio: 'inherit', cwd: DSH_REPO, shell: process.platform === 'win32' })

step('完成')
process.stdout.write(`
用法：
  一次性会话：  (cd ${DSH_REPO} && pnpm dsh --profile lcode-planner "任务")
  常驻 server： (cd ${DSH_REPO} && pnpm dsh --profile lcode-planner)
    环境变量：LCORE_KERNEL_URL / LCORE_KERNEL_TOKEN / LCORE_PLANNER_PORT / LCORE_PLANNER_TOKEN
              DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（可选，默认走 $DSH_HOME/.credentials.yaml）
`)
