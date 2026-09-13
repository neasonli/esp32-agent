"""对话式 Agent 工具集（阶段2 W3）。

LLM 通过 function calling 调用这些工具来执行用户命令：
- shell       执行任意 shell 命令（cmd，Windows）
- git_clone   拉取 git 仓库到工作目录
- list_dir    列出目录内容
- read_file   读取文件内容（文本，限 200KB）
- write_file  写入/追加文件内容
- build       idf.py build 编译固件工程
- flash       idf.py flash 烧录固件到开发板

路径约定：除 shell/git_clone 外的文件类工具，路径均相对于会话工作目录 cwd，
越界（.. 逃逸）直接拒绝，防目录穿越。
"""
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from config.settings import settings
from db import task_store
from tools.base_tools import TOOL_IMPL as BASE_TOOLS
from tools.base_tools import checkpoint_after_mutation
from tools.compile_tool import run_idf, _scan_artifacts

SHELL_TIMEOUT = 180          # shell 命令默认超时（秒）
OUTPUT_MAX = 6000            # 工具输出回传 LLM 的最大字符数（避免上下文爆炸）
IDF_BUILD_TIMEOUT = 900      # 编译超时（秒）
IDF_FLASH_TIMEOUT = 300      # 烧录超时（秒）

# 编译错误行识别（build/flash 失败时优先提取给 LLM，避免被日志尾截断淹没）
_ERROR_RE = re.compile(
    r"(error:|fatal error:|undefined reference|No such file|not found|cannot |failed|"
    r"错误\s*[:：]|FAILED|does not exist|multiple definition)",
    re.IGNORECASE,
)


def _extract_error_summary(log: str, max_blocks: int = 12) -> str:
    """从编译日志提取错误相关行（每处错误带前后 1 行上下文，去重）。

    返回格式：【错误摘要】…；提取不到返回空串。
    """
    lines = log.splitlines()
    hits: list[str] = []
    seen: set[str] = set()
    for i, ln in enumerate(lines):
        if not _ERROR_RE.search(ln):
            continue
        for j in range(max(0, i - 1), min(len(lines), i + 2)):
            ctx = lines[j].strip()
            if ctx and ctx not in seen:
                hits.append(ctx)
                seen.add(ctx)
        if len(hits) >= max_blocks * 2:
            break
    if not hits:
        return ""
    return "【错误摘要】\n" + "\n".join(hits[: max_blocks * 2])


# ---------------------------------------------------------------- 工具定义（LLM 可见的 schema）

def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


TOOL_DEFS: list[dict] = [
    _tool(
        "shell",
        "在用户电脑上执行任意 shell 命令（Windows cmd 语法：dir、git、python、copy；"
        "没有 tail/grep/sed，用 findstr）。适合查看系统/文件状态、执行用户要求的命令。"
        "编译/烧录请用 build/flash 工具（自动处理 ESP-IDF 环境），不要手动 call export.bat。",
        {"command": {"type": "string", "description": "要执行的完整命令"}},
        ["command"],
    ),
    _tool(
        "git_clone",
        "用 git clone 拉取远程仓库到工作目录（相对路径）。用于'拉取某某工程'类命令。"
        "注意：ESP-IDF 已本地安装，严禁克隆 esp-idf 主仓库（几个 GB）；优先用 IDF 自带示例（D:\\esp\\frameworks\\esp-idf-v5.5.5\\examples）。",
        {
            "url": {"type": "string", "description": "git 仓库地址（https/ssh/git）"},
            "dir": {"type": "string", "description": "目标子目录（相对工作目录，可选，默认克隆到工作目录）"},
        },
        ["url"],
    ),
    _tool(
        "list_dir",
        "列出工作目录下指定子目录的内容（文件与子目录）。",
        {"path": {"type": "string", "description": "相对工作目录的路径，空=工作目录本身"}},
        [],
    ),
    _tool(
        "read_file",
        "读取文本文件内容（相对工作目录，限 200KB）。查看工程源码用。",
        {"path": {"type": "string", "description": "相对工作目录的文件路径"}},
        ["path"],
    ),
    _tool(
        "write_file",
        "写入或追加文本文件（相对工作目录，自动创建父目录）。修改工程源码用。",
        {
            "path": {"type": "string", "description": "相对工作目录的文件路径"},
            "content": {"type": "string", "description": "要写入的完整内容"},
            "append": {"type": "boolean", "description": "True=追加到文件末尾，False=覆盖（默认）"},
        },
        ["path", "content"],
    ),
    _tool(
        "build",
        "用 ESP-IDF 编译固件工程（idf.py build）。内部自动激活 ESP-IDF 环境（export.bat），"
        "直接传工程目录即可，编译可能耗时数分钟，返回编译日志与产物清单。"
        "需要结构化诊断（CodeDiagnostic）时用 run_check 工具。",
        {
            "project_dir": {
                "type": "string",
                "description": "工程目录（含 CMakeLists.txt，相对工作目录）",
            }
        },
        ["project_dir"],
    ),
    _tool(
        "flash",
        "申请烧录固件（防误烧）：对话中**不执行**烧录，只登记待烧录请求（工程+端口）。"
        "会话确认结束后，用户在弹出的烧录确认中核对端口后点击确认，才会真正烧录进开发板。",
        {
            "project_dir": {
                "type": "string",
                "description": "工程目录（含 build 产物，相对工作目录）",
            },
            "port": {
                "type": "string",
                "description": "串口端口，如 COM3。不确定时可省略让系统自动探测，或先用 shell 执行 mode 查看端口",
            },
        },
        ["project_dir"],
    ),
    # ---- 阶段3 Phase3：底座工具集（agent核心开发文档 §3/§4.3 统一底座工具集）----
    _tool(
        "edit_file",
        "精确匹配编辑（exact-match）：把文件中唯一出现的 old_string 替换为 new_string。"
        "修改源码首选本工具（防静默乱改）；old_string 未找到或出现多次会拒绝并给出提示，"
        "此时请先 read_file 核对原文。整文件新建/覆盖用 write_file。",
        {
            "path": {"type": "string", "description": "相对工作目录的文件路径"},
            "old_string": {"type": "string", "description": "待替换的原文（必须与文件内容逐字一致，含空白/缩进）"},
            "new_string": {"type": "string", "description": "替换后的新文本"},
            "replace_all": {"type": "boolean", "description": "True=替换所有出现处；默认仅替换第一处（old_string 须唯一）"},
        },
        ["path", "old_string", "new_string"],
    ),
    _tool(
        "file_tree",
        "递归目录树（轻量感知 §3.5）：列出工作目录/子目录下的文件树（跳过 build/.git 等），"
        "附带目录结构与文件大小，快速了解工程布局。"
        "可选 depth 控制递归深度（默认 4 层）。单层列表用 list_dir。",
        {
            "path": {"type": "string", "description": "相对工作目录的目录路径（空=工作目录本身）"},
            "depth": {"type": "integer", "description": "递归深度（1~6，默认 4）"},
        },
        [],
    ),
    _tool(
        "glob",
        "文件名模式匹配（轻量感知 §3.5）：按 glob 模式（如 **/*.c、**/CMakeLists.txt、**/main/*.c）"
        "查找文件清单。只匹配文件名，不含内容；查代码内容用 grep。",
        {
            "path": {"type": "string", "description": "相对工作目录的搜索根目录（空=工作目录）"},
            "glob": {"type": "string", "description": "文件名模式，如 **/*.c、**/*.h（rglob 语义，*.c 也递归）"},
        },
        ["glob"],
    ),
    _tool(
        "grep",
        "正则内容搜索（轻量感知 §3.5）：在文件内容中按正则（忽略大小写）搜代码，"
        "返回「文件:行: 内容」。可用 glob 先过滤文件集（如 **/*.c）。"
        "用于定位函数调用、TODO、符号引用。",
        {
            "path": {"type": "string", "description": "相对工作目录的搜索根目录（空=工作目录）"},
            "glob": {"type": "string", "description": "可选：文件名模式过滤（如 **/*.c）"},
            "query": {"type": "string", "description": "内容正则表达式（如 gpio_set_level、TODO）"},
        },
        ["query"],
    ),
    _tool(
        "run_check",
        "真实校验（自动选校验器并返回结构化 CodeDiagnostic：level/filePath/range/message/ruleId/fixable）。"
        "按工程类型自动选择：TS 工程（tsconfig.json）→ tsc --noEmit；ESP-IDF 工程"
        "（sdkconfig，或 CMakeLists.txt + main/ 目录）→ idf.py build。"
        "修改代码后用本工具验证；诊断逐条下发事件（check/start、diagnostic、check/end，payload 带 checker）。"
        "仅校验与诊断返回，不做自动修复（修复由你根据诊断决策迭代）。",
        {
            "project_dir": {
                "type": "string",
                "description": "工程目录（TS：含 tsconfig.json；ESP-IDF：含 sdkconfig 或 CMakeLists.txt+main/，相对工作目录）",
            }
        },
        ["project_dir"],
    ),
]


# ---------------------------------------------------------------- 执行上下文

class ToolContext:
    """单次对话的工具执行上下文（每轮工具调用共享）。

    task_id：可选会话/任务 ID；传入后工具可经 emit() 落带事件类型的底座事件
    （patch/applied、check/start、diagnostic、check/end，§5.2 事件字典）。
    """

    def __init__(self, cwd: str, task_id: str = "", sandbox: dict | None = None):
        self.cwd = str(Path(cwd).resolve())
        self.task_id = task_id
        # V3.1 · 附录 D：本次工具调用携带的沙盒策略包 {mode, workspace_root, session_id}
        # （规划器 ctx.sandboxPolicy.resolve() 产出；None = 无策略，等价 danger-full-access 旧行为）。
        self.sandbox = sandbox if isinstance(sandbox, dict) else None

    def emit(self, level: str, message: str, node: str = "", event_type: str = "", payload: dict | None = None) -> None:
        """工具侧落一条统一事件字典事件（task_id 为空时静默跳过）。"""
        if self.task_id:
            task_store.add_event(self.task_id, level, message, node, event_type, payload)

    def resolve(self, rel: str) -> Path:
        """把相对路径解析到 cwd 内，越界抛 ValueError。"""
        p = Path(rel)
        if not p.is_absolute():
            p = Path(self.cwd) / p
        p = p.resolve()
        if not (p == Path(self.cwd) or Path(self.cwd) in p.parents):
            raise ValueError(f"路径越界（仅允许工作目录内）: {rel}")
        return p


# ---------------------------------------------------------------- 工具实现

def _truncate(text: str, limit: int = OUTPUT_MAX) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（输出过长，已截断，共 {len(text)} 字符）"


def tool_shell(args: dict, ctx: ToolContext) -> str:
    command = str(args.get("command", "")).strip()
    if not command:
        return "[错误] 缺少 command 参数"
    try:
        proc = subprocess.run(
            command,
            cwd=ctx.cwd,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SHELL_TIMEOUT,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        head = f"[exit code: {proc.returncode}]"
        return _truncate(head + "\n" + out) if out.strip() else head
    except subprocess.TimeoutExpired:
        return f"[错误] 命令执行超时（>{SHELL_TIMEOUT}s）"
    except Exception as e:  # noqa: BLE001
        return f"[错误] 命令执行异常: {e}"


def tool_git_clone(args: dict, ctx: ToolContext) -> str:
    url = str(args.get("url", "")).strip()
    if not url:
        return "[错误] 缺少 url 参数"
    cmd = f"git clone {url}"
    if args.get("dir"):
        cmd += " " + str(args["dir"]).strip()
    return tool_shell({"command": cmd}, ctx)


def tool_list_dir(args: dict, ctx: ToolContext) -> str:
    try:
        target = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not target.exists():
        return f"[错误] 路径不存在: {target}"
    if not target.is_dir():
        return f"[错误] 不是目录: {target}"
    lines = []
    for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        kind = "dir " if p.is_dir() else "file"
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        lines.append(f"{kind} {size:>10}  {p.name}")
    return _truncate(f"目录: {target}\n" + ("\n".join(lines) if lines else "（空目录）"))


def tool_read_file(args: dict, ctx: ToolContext) -> str:
    try:
        target = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not target.exists() or not target.is_file():
        return f"[错误] 文件不存在: {target}"
    size = target.stat().st_size
    if size > 200 * 1024:
        return f"[错误] 文件过大（{size} 字节 > 200KB），请用外部编辑器打开"
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        return f"[错误] 读取失败: {e}"
    return _truncate(f"--- {target.name} ({size} 字节) ---\n" + content)


def tool_write_file(args: dict, ctx: ToolContext) -> str:
    try:
        target = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    content = str(args.get("content", ""))
    append = bool(args.get("append", False))
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if append:
            with target.open("a", encoding="utf-8") as f:
                f.write(content)
            mode = "追加"
        else:
            with target.open("w", encoding="utf-8") as f:
                f.write(content)
            mode = "写入"
    except Exception as e:  # noqa: BLE001
        return f"[错误] 写入失败: {e}"
    cp = checkpoint_after_mutation(ctx, "write_file", target, note=f"{mode} {len(content)}ch")
    return f"已{mode}: {target}（{len(content)} 字符）{cp}"


def tool_build(args: dict, ctx: ToolContext) -> str:
    try:
        proj = ctx.resolve(str(args.get("project_dir", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not (proj / "CMakeLists.txt").exists():
        return f"[错误] 不是 ESP-IDF 工程（缺少 CMakeLists.txt）: {proj}"
    log, ok = run_idf(str(proj), ["-B", "build", "build"], timeout=IDF_BUILD_TIMEOUT)
    arts = _scan_artifacts(str(proj))
    head = "✅ 编译成功" if ok else "❌ 编译失败"
    art_line = "；产物: " + ", ".join(f"{a['name']}（{a['size_kb']} KB）" for a in arts) if arts else ""
    if ok:
        body = log
    else:
        # 失败：错误行摘要置顶（避免 6000 字符截断把真正 error 行淹没在编译命令行回显里）
        summary = _extract_error_summary(log)
        body = f"{summary}\n\n【日志尾部】\n{log[-2500:]}" if summary else log
    return _truncate(f"{head}{art_line}\n{body}", limit=OUTPUT_MAX)


def tool_flash(args: dict, ctx: ToolContext) -> str:
    """烧录请求登记（阶段3 Phase2 防误烧，agent核心开发文档 §0.6/§8 Phase 2）。

    对话中**不执行**烧录：只把待烧录请求登记到会话（project_dir/port），
    会话确认结束后由用户显式确认端口后执行（flash_confirm 端点）。
    """
    try:
        proj = ctx.resolve(str(args.get("project_dir", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not (proj / "build").exists():
        return f"[错误] 尚未编译（无 build 目录），请先执行 build: {proj}"
    if not ctx.task_id:
        return "[错误] 烧录需在对话会话中发起（缺少会话 ID）"
    port = str(args.get("port", "")).strip()
    pending = {
        "project_dir": str(proj),
        "port": port,
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    task_store.set_pending_flash(ctx.task_id, pending)
    ctx.emit(
        "WARN",
        f"⏸ 烧录请求已登记（{proj.name}，端口 {port or '未指定'}），等待会话结束后显式确认执行",
        "flash", "flash/requested", pending,
    )
    return (
        "⏸ 烧录请求已登记（防误烧），**未执行烧录**。\n"
        f"- 工程：{proj}\n"
        f"- 端口：{port or '（未指定，需在确认时提供）'}\n"
        "请在会话结束后，在弹出的烧录确认框中核对端口后点击「确认烧录」；"
        "确认后才会真正写入开发板。"
    )


TOOL_HANDLERS = {
    "shell": tool_shell,
    "git_clone": tool_git_clone,
    "list_dir": tool_list_dir,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "build": tool_build,
    "flash": tool_flash,
    # 阶段3 Phase3：底座工具集（edit_file / file_tree / glob / grep / run_check，实现见 tools/base_tools.py）
    **BASE_TOOLS,
}
