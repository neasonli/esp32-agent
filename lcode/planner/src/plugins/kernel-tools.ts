/**
 * 内核工具包装器插件：把 Python 内核的底座/领域工具（shell/build/flash/read_file/…）
 * 注册为 DSH 工具，经内核 HTTP `/api/planner/tool/{name}` 透传执行。
 *
 * 工具 schema 与内核 `kernel/tools/chat_tools.py` 的 TOOL_DEFS 逐字段一致
 * （agent核心开发文档 §1.2 自有插件：底座工具集 → 调 Python 内核 HTTP）。
 * 工作目录与执行权限取自规划器会话（cwd/full_access），内核侧做防目录穿越与权限检查。
 *
 * M0 B2：每工具声明 `timeoutMs`（见 TOOL_TIMEOUT_MS 校准表），由已装配的
 * dsh-tool-call-timeout-policy 在 exec.signal 上布 deadline；超时 = 中止本次 HTTP 往返
 * 并替换为结构化 TOOL_TIMEOUT 结果。预算按「往返耗时 + 用户可容忍等待」校准：
 * 内核慢工具（build/run_check）给大预算，绝不静默杀掉真实编译。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { EscalationApprover } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { KernelClient } from '../kernel-client.ts'
import type { SessionRegistry } from '../sessions.ts'

export const name = 'lcode-kernel-tools'

export interface Config {
  client: KernelClient
  registry: SessionRegistry
  defaultCwd: string
}

/** 与内核 TOOL_DEFS 一致的工具清单（name → 原始 JSON Schema 参数）。 */
const TOOL_SCHEMAS: ReadonlyArray<{
  name: string
  description: string
  parameters: Record<string, unknown>
  required: string[]
}> = [
  {
    name: 'shell',
    description: '在用户电脑上执行任意 shell 命令（Windows cmd 语法：dir、git、python、copy；'
      + '没有 tail/grep/sed，用 findstr）。适合查看系统/文件状态、执行用户要求的命令。'
      + '编译/烧录请用 build/flash 工具（自动处理 ESP-IDF 环境），不要手动 call export.bat。',
    parameters: { command: { type: 'string', description: '要执行的完整命令' } },
    required: ['command'],
  },
  {
    name: 'git_clone',
    description: '用 git clone 拉取远程仓库到工作目录（相对路径）。用于"拉取某某工程"类命令。'
      + '注意：ESP-IDF 已本地安装，严禁克隆 esp-idf 主仓库（几个 GB）；优先用 IDF 自带示例。',
    parameters: {
      url: { type: 'string', description: 'git 仓库地址（https/ssh/git）' },
      dir: { type: 'string', description: '目标子目录（相对工作目录，可选，默认克隆到工作目录）' },
    },
    required: ['url'],
  },
  {
    name: 'list_dir',
    description: '列出工作目录下指定子目录的内容（文件与子目录）。',
    parameters: { path: { type: 'string', description: '相对工作目录的路径，空=工作目录本身' } },
    required: [],
  },
  {
    name: 'read_file',
    description: '读取文本文件内容（相对工作目录，限 200KB）。查看工程源码用。',
    parameters: { path: { type: 'string', description: '相对工作目录的文件路径' } },
    required: ['path'],
  },
  {
    name: 'write_file',
    description: '写入或追加文本文件（相对工作目录，自动创建父目录）。修改工程源码用。',
    parameters: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
      append: { type: 'boolean', description: 'True=追加到文件末尾，False=覆盖（默认）' },
    },
    required: ['path', 'content'],
  },
  {
    name: 'build',
    description: '用 ESP-IDF 编译固件工程（idf.py build）。内部自动激活 ESP-IDF 环境（export.bat），'
      + '直接传工程目录即可，编译可能耗时数分钟，返回编译日志与产物清单。'
      + '需要结构化诊断（CodeDiagnostic）时用 run_check 工具。',
    parameters: {
      project_dir: { type: 'string', description: '工程目录（含 CMakeLists.txt，相对工作目录）' },
    },
    required: ['project_dir'],
  },
  {
    name: 'flash',
    description: '申请烧录固件（防误烧）：对话中**不执行**烧录，只登记待烧录请求（工程+端口）。'
      + '会话确认结束后，用户在弹出的烧录确认中核对端口后点击确认，才会真正烧录进开发板。',
    parameters: {
      project_dir: { type: 'string', description: '工程目录（含 build 产物，相对工作目录）' },
      port: { type: 'string', description: '串口端口，如 COM3。不确定时可省略让系统自动探测' },
    },
    required: ['project_dir'],
  },
  // ---- 阶段3 Phase3：底座工具集（agent核心开发文档 §3/§4.3 统一底座工具集）----
  {
    name: 'edit_file',
    description: '精确匹配编辑（exact-match）：把文件中唯一出现的 old_string 替换为 new_string。'
      + '修改源码首选本工具（防静默乱改）；old_string 未找到或出现多次会拒绝并给出提示，'
      + '此时请先 read_file 核对原文。整文件新建/覆盖用 write_file。',
    parameters: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      old_string: { type: 'string', description: '待替换的原文（必须与文件内容逐字一致，含空白/缩进）' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: 'True=替换所有出现处；默认仅替换第一处（old_string 须唯一）' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  {
    name: 'file_tree',
    description: '递归目录树（轻量感知 §3.5）：列出工作目录/子目录下的文件树（跳过 build/.git 等），'
      + '附带目录结构与文件大小，快速了解工程布局。可选 depth 控制递归深度（默认 4 层）。'
      + '单层列表用 list_dir。',
    parameters: {
      path: { type: 'string', description: '相对工作目录的目录路径（空=工作目录本身）' },
      depth: { type: 'number', description: '递归深度（1~6，默认 4）' },
    },
    required: [],
  },
  {
    name: 'glob',
    description: '文件名模式匹配（轻量感知 §3.5）：按 glob 模式（如 **/*.c、**/CMakeLists.txt、**/main/*.c）'
      + '查找文件清单。只匹配文件名，不含内容；查代码内容用 grep。',
    parameters: {
      path: { type: 'string', description: '相对工作目录的搜索根目录（空=工作目录）' },
      glob: { type: 'string', description: '文件名模式，如 **/*.c、**/*.h（rglob 语义，*.c 也递归）' },
    },
    required: ['glob'],
  },
  {
    name: 'grep',
    description: '正则内容搜索（轻量感知 §3.5）：在文件内容中按正则（忽略大小写）搜代码，'
      + '返回「文件:行: 内容」。可用 glob 先过滤文件集（如 **/*.c）。用于定位函数调用、TODO、符号引用。',
    parameters: {
      path: { type: 'string', description: '相对工作目录的搜索根目录（空=工作目录）' },
      glob: { type: 'string', description: '可选：文件名模式过滤（如 **/*.c）' },
      query: { type: 'string', description: '内容正则表达式（如 gpio_set_level、TODO）' },
    },
    required: ['query'],
  },
  {
    name: 'run_check',
    description: '真实校验（自动选校验器并返回结构化 CodeDiagnostic：level/filePath/range/message/ruleId/fixable）。'
      + '按工程类型自动选择：TS 工程（tsconfig.json）→ tsc --noEmit；ESP-IDF 工程'
      + '（sdkconfig，或 CMakeLists.txt + main/ 目录）→ idf.py build。'
      + '修改代码后用本工具验证；诊断逐条下发事件（check/start、diagnostic、check/end，payload 带 checker）。'
      + '仅校验与诊断返回，不做自动修复（修复由你根据诊断决策迭代）。',
    parameters: {
      project_dir: { type: 'string', description: '工程目录（TS：含 tsconfig.json；ESP-IDF：含 sdkconfig 或 CMakeLists.txt+main/，相对工作目录）' },
    },
    required: ['project_dir'],
  },
]

/**
 * M0 B2 逐工具超时预算（ms），附到 ToolDefinition.timeoutMs 由
 * dsh-tool-call-timeout-policy 执行。校准口径：
 * - 常规文件/浏览/检索（read_file/edit_file/file_tree/glob/grep/list_dir/write_file）：
 *   本地内核往返毫秒级，60s 主要兜底「内核卡死/HTTP 悬挂」；
 * - shell：与 DSH bash-local 默认 60s 对齐（persona 引导长命令走 build/run_check）；
 * - git_clone：网络仓库拉取，5min；
 * - flash（对话内为**登记制**，实际烧录在 flash_confirm 显式端点、不走本路径）：60s；
 * - run_check（esp-idf = idf.py build，可能数分钟）/ build（首次编译 1–5min+）：给大预算，
 *   超时仅作为悬挂兜底，绝不静默杀掉真实编译。
 */
const TOOL_TIMEOUT_MS: Readonly<Record<string, number>> = {
  read_file: 60_000,
  write_file: 60_000,
  list_dir: 60_000,
  file_tree: 60_000,
  glob: 60_000,
  grep: 60_000,
  edit_file: 60_000,
  shell: 60_000,
  git_clone: 300_000,
  flash: 60_000,
  run_check: 900_000,
  build: 1_800_000,
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' as const },
    result: { type: 'string' as const },
  },
  required: ['ok', 'result'] as string[],
}

/** 沙盒升级参数（与 DSH tool-fs/tool-bash 同款文案，V3.1 · rc.5 复刻）：仅在沙盒策略装配时附加到工具 schema。 */
const ESCALATION_FIELDS: Record<string, unknown> = {
  sandbox_permissions: {
    type: 'string',
    enum: ['workspace-write', 'danger-full-access'],
    description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry '
      + 'of an operation the sandbox just denied; requires justification and user approval.',
  },
  justification: {
    type: 'string',
    description: 'Required with sandbox_permissions: one sentence for the user explaining '
      + 'why this exact file operation needs the wider access.',
  },
}

/** 附加到内核工具请求的策略包（内核侧按 DSH fs-sandbox 语义执行）。 */
export interface KernelSandboxEnvelope {
  mode: SandboxMode
  workspace_root: string
  session_id: string
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function buildDefinition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  required: string[],
  client: KernelClient,
  registry: SessionRegistry,
  defaultCwd: string,
  policy: SandboxPolicyService | undefined,
  approval: EscalationApprover | undefined,
): ToolDefinition {
  const confined = policy !== undefined
  const allParameters = confined
    ? { ...parameters, ...ESCALATION_FIELDS }
    : parameters
  const timeoutMs = TOOL_TIMEOUT_MS[name]
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: allParameters,
      required,
    } as Record<string, unknown>,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: JsonValue): ContentBlock[] {
        const v = value as { ok: boolean; result?: string }
        return text(v.result ?? (v.ok ? '（完成）' : '（失败）'))
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const callArgs = (args ?? {}) as Record<string, unknown>
      const session = exec.agent === undefined ? undefined : registry.forAgent(exec.agent)
      const cwd = session?.cwd ?? defaultCwd
      const fullAccess = session?.fullAccess ?? true
      const taskId = session?.sessionId ?? ''

      // 沙盒：每次调用解析一次策略（会话 sandbox/mode 覆盖 > 部署默认；workspace=会话 cwd），
      // 升级参数 → 严格更宽 + 审批通道（与 DSH tool-fs resolvePolicy 同序，V3.1 · rc.5 复刻）。
      let envelope: KernelSandboxEnvelope | undefined
      if (confined) {
        const pol = policy!.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
        let mode = pol.mode
        const sandboxPermissions = callArgs.sandbox_permissions
        const justification = callArgs.justification
        if (sandboxPermissions !== undefined || justification !== undefined) {
          validateEscalationArgs(
            sandboxPermissions === undefined ? undefined : String(sandboxPermissions),
            justification === undefined ? undefined : String(justification),
          )
          const granted = await approveEscalation(
            {
              requestedMode: String(sandboxPermissions),
              justification: String(justification),
              effectiveMode: pol.mode,
              subject: 'operation',
            },
            {
              approver: approval,
              agent: exec.agent,
              callId: exec.callId,
              toolName: name,
              ...exec.signal ? { signal: exec.signal } : {},
            },
          )
          mode = granted
        }
        envelope = { mode, workspace_root: pol.workspaceRoot, session_id: taskId }
        delete callArgs.sandbox_permissions
        delete callArgs.justification
      }

      // M0 B2：把 timeout-policy 布在 exec.signal 上的 deadline 透传给内核 HTTP 往返——
      // 超时即中止请求（fetch 抛 AbortError），上游 dsh-tool-call-timeout-policy 再把
      // 本次调用替换为结构化 TOOL_TIMEOUT 结果（文本与 DSH 逐字一致）。
      const resp = await client.tool(name, callArgs, cwd, fullAccess, taskId, envelope, exec.signal)
      if (!resp.ok) {
        throw new Error(resp.error || `工具 ${name} 执行失败`)
      }
      return { ok: true, result: resp.result ?? '' }
    },
  }
}

/** 注册全部内核透传工具。 */
export function apply(ctx: Context, config: Config): void {
  const { client, registry, defaultCwd } = config
  const policy = ctx.get('sandboxPolicy')
  const approvalRaw = ctx.get('approval')
  const approval = approvalRaw as unknown as EscalationApprover | undefined
  for (const spec of TOOL_SCHEMAS) {
    ctx.tools.register(buildDefinition(
      spec.name, spec.description, spec.parameters, spec.required,
      client, registry, defaultCwd, policy, approval,
    ))
  }
}
