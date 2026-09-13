/**
 * 规划器运行时配置（全部来自环境变量，桌面网关 spawn 时注入）。
 *
 * - LCORE_KERNEL_URL / LCORE_KERNEL_TOKEN    —— Python 内核地址与鉴权（X-Kernel-Token）
 * - LCORE_PLANNER_PORT / LCORE_PLANNER_TOKEN  —— 规划器自身 HTTP 服务（供 Electron 网关调用）
 * - LCORE_LLM_MODEL / LCORE_LLM_PROVIDER      —— LLM 模型与 provider 路由（默认 deepseek-v4-flash / deepseek-official）
 * - LCORE_SESSION_ROOT                        —— DSH 会话 JSONL 持久化根目录
 * - LCORE_SKILL_DIRS                          —— 附加 skill 目录（分号分隔；与 $DSH_HOME/skills 并列）
 * - LCORE_SANDBOX_MODE                        —— DSH 沙盒默认模式（read-only/workspace-write/danger-full-access，
 *   默认 workspace-write；danger-full-access 为升级前行为，审批策略自动置 never）
 * - DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL      —— 复用内核同款 DeepSeek 兼容接口（llm-deepseek 逐请求解析）
 */
import { join } from 'node:path'

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxModeName = (typeof SANDBOX_MODES)[number]

export interface PlannerEnv {
  kernelUrl: string
  kernelToken: string
  port: number
  token: string
  provider: string
  model: string
  /** 桌面设置页请求的模型原值（可能被下面的 v4 规则改写，用于向界面解释差异）。 */
  requestedModel: string
  sessionRoot: string
  skillDirs: string[]
  dshHome: string
  cwd: string
  /** DSH 沙盒部署默认模式（rc.5 复刻：ctx.sandboxPolicy.defaultMode）。 */
  sandboxMode: SandboxModeName
}

const V4_MODEL_RE = /^deepseek-v4-/i

/** 读取规划器运行时配置；缺失项取默认值。 */
export function loadPlannerEnv(): PlannerEnv {
  const env = process.env
  const dshHome = env.DSH_HOME || join(env.USERPROFILE || env.HOME || process.cwd(), '.dsh')
  const kernelUrl = env.LCORE_KERNEL_URL || 'http://127.0.0.1:8090'
  const rawModel = env.LCORE_LLM_MODEL || ''
  // 规划器侧模型目录只认 v4 型号（deepseek-v4-flash / deepseek-v4-pro）：内核侧可以配
  // deepseek-chat 这类别名，但直接把别名交给 DSH 会因"未知模型"失败，所以这里回退到默认 v4。
  // ⚠️ 这是一处**静默改写**，正是"设置页选了 deepseek-chat、实际跑的不是它"的来源——
  // 因此保留原值 + 明确打日志（deepseek-chat 在服务端本来就解析到 deepseek-flash =
  // deepseek-v4-flash，两者同一档位，只是名字不同）。
  const model = rawModel && V4_MODEL_RE.test(rawModel) ? rawModel : 'deepseek-v4-flash'
  if (rawModel && model !== rawModel) {
    console.log(
      `[planner] 模型 "${rawModel}" 不是 v4 型号，规划器目录不认，实际使用 "${model}"` +
        '（服务端 deepseek-chat 与 deepseek-v4-flash 解析到同一档位）'
    )
  }
  return {
    kernelUrl,
    kernelToken: env.LCORE_KERNEL_TOKEN || '',
    port: parsePort(env.LCORE_PLANNER_PORT, 8790),
    token: env.LCORE_PLANNER_TOKEN || '',
    provider: env.LCORE_LLM_PROVIDER || 'deepseek-official',
    model,
    requestedModel: rawModel,
    sessionRoot: env.LCORE_SESSION_ROOT || join(process.cwd(), '.sessions'),
    skillDirs: (env.LCORE_SKILL_DIRS || '')
      .split(';').map(s => s.trim()).filter(Boolean),
    dshHome,
    cwd: env.LCORE_CWD || process.cwd(),
    sandboxMode: parseSandboxMode(env.LCORE_SANDBOX_MODE),
  }
}

function parseSandboxMode(raw: string | undefined): SandboxModeName {
  return SANDBOX_MODES.includes(raw as SandboxModeName) ? (raw as SandboxModeName) : 'workspace-write'
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}
