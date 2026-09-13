"""底座工具集（阶段3 Phase3 行业级）：edit_file / file_tree / glob / grep / run_check。

agent核心开发文档 §3 多语言工程底座（行业级精简）——准确性来自三个便宜机制：
**exact-match 编辑 + 真实工具链校验反馈 + git/会话安全**；本模块实现工具面
（§3.2/§4.3 统一底座工具集 = read_file/write_file/edit_file/file_tree/glob/grep/run_check；
read_file/write_file 在 chat_tools.py 同签名注册）：

- `edit_file`  精确匹配替换（old_string → new_string，防静默乱改；§3.4 补丁语义
  {filePath, oldText, newText}）；失败返回定位提示，由规划层 LLM 决策式迭代（V1 单向）。
- `file_tree`  递归目录树（§3.5 轻量感知：文件树即时查询，不建全工程索引；跳过 build/.git）。
- `glob`       文件名模式匹配（如 **/*.c、**/CMakeLists.txt）。
- `grep`       正则内容搜索（忽略大小写，限量防超大工程卡死）。
- `run_check`  真实校验（§3.3，单向、**无自动修复回环**）→ 结构化 CodeDiagnostic 返回，
  按工程类型自动选择校验器：ts → tsc；esp-idf → idf.py build（profile 检测见 tools/profiles）。
  同时落 check/start、check/end、diagnostic 事件（§5.2）。

CodeDiagnostic（§3.3，全语言一致，规划层可直接解析）：
  {level: "error"|"warn"|"info", filePath, range: {start: {line, column}, end: {line, column}},
   message, ruleId, fixable}
"""
import re
import shutil
import subprocess
from pathlib import Path

from tools.compile_tool import run_idf
from tools.error_parse import RULES

IDF_BUILD_TIMEOUT = 900      # 编译超时（秒，与 chat_tools 一致）
EDIT_MAX_FILE = 200 * 1024   # 编辑文件大小上限（与 read_file 一致）
SEARCH_MAX_RESULTS = 200     # glob/grep 最大结果数（防止上下文爆炸）
SEARCH_MAX_FILES = 2000      # 单次搜索最多扫描文件数（防超大工程卡死）
SEARCH_MAX_LINES = 50        # 单文件最多命中行数
FILE_TREE_MAX_DEPTH = 4      # file_tree 默认最大深度
FILE_TREE_MAX_LINES = 400    # file_tree 文本树最大行数
TSC_TIMEOUT = 300            # tsc 校验超时（秒）
SKIP_DIRS = {"build", ".git", "__pycache__", "managed_components", "node_modules", ".venv"}

# GCC/CMake 诊断行格式: [path]:line:col: (fatal )error|warning|note: message
_DIAG_RE = re.compile(
    r"(?P<path>[\w./\\-]+\.(?:c|h|cpp|cc|cxx|S)):"
    r"(?P<line>\d+)(?::(?P<col>\d+))?:\s*"
    r"(?P<level>fatal\s+error|error|warning|note):\s*(?P<msg>.*)$",
    re.IGNORECASE,
)


def _diag_level(raw: str) -> str:
    """日志级别 → CodeDiagnostic.level（fatal error/error → error）。"""
    return "error" if "error" in raw.lower() else ("warn" if "warning" in raw.lower() else "info")


def _classify_rule(line: str) -> str:
    """复用 error_parse.RULES 对单行做错误分类 → ruleId（如 syntax / undefined / pin_conflict）。"""
    for etype, patterns in RULES:
        for p in patterns:
            if re.search(p, line, re.IGNORECASE):
                return etype.name.lower()
    return "compile"


def parse_diagnostics(log: str, project_dir: str, base_dir: str) -> list[dict]:
    """把编译日志解析为 CodeDiagnostic 列表（§3.3）。

    filePath 统一为「相对 cwd 的路径」（工程内相对路径 + 工程相对 cwd 前缀），
    规划层拿到后可直接 read_file 定位。
    """
    diags: list[dict] = []
    seen: set[tuple] = set()
    # 工程相对 cwd 的路径前缀（如 "project_x"；越出 cwd 时退化为工程绝对路径）
    try:
        rel_prefix = Path(project_dir).resolve().relative_to(Path(base_dir).resolve())
    except ValueError:
        rel_prefix = None
    for raw in (log or "").splitlines():
        m = _DIAG_RE.search(raw)
        if not m:
            continue
        path = m.group("path")
        line = int(m.group("line"))
        col = int(m.group("col")) if m.group("col") else 1
        msg = m.group("msg").strip()
        level = _diag_level(m.group("level"))
        fp = (rel_prefix / path).as_posix() if rel_prefix is not None else path
        key = (fp, line, col, msg)
        if key in seen:
            continue
        seen.add(key)
        diags.append(
            {
                "level": level,
                "filePath": fp,
                "range": {
                    "start": {"line": line, "column": col},
                    "end": {"line": line, "column": col + 1},
                },
                "message": msg[:300],
                "ruleId": _classify_rule(raw),
                "fixable": False,  # V1 单向校验，修复由规划层 LLM 决策（§3.3）
            }
        )
    # 保持日志顺序（error/warning 混合时先报先修）
    return diags


def _format_diagnostics(diags: list[dict], limit: int = 20) -> str:
    """诊断 → 文本摘要（工具结果回传规划层，与诊断事件一致）。"""
    if not diags:
        return "✅ 校验通过，无诊断"
    lines = [f"共 {len(diags)} 条诊断（显示前 {min(limit, len(diags))} 条）："]
    for d in diags[:limit]:
        r = d["range"]["start"]
        lines.append(
            f"  [{d['level']}] {d['filePath']}:{r['line']}:{r['column']} {d['message']}"
            f"（{d['ruleId']}）"
        )
    if len(diags) > limit:
        lines.append(f"  …其余 {len(diags) - limit} 条略")
    return "\n".join(lines)


# ---------------------------------------------------------------- edit_file（exact-match）

def checkpoint_after_mutation(ctx, tool: str, file_path: Path, note: str = "") -> str:
    """git/会话 checkpoint 兜底（§3.1）：文件修改成功后，在 eligible 工作区落一个 checkpoint。

    返回提示串（空串 = 无会话 / 工作区不适用 / 无变更）。事件 git/checkpoint（payload 带 commit）。
    """
    if not ctx.task_id:
        return ""
    try:
        from tools.git_safe import snapshot_session  # noqa: PLC0415 - 延迟导入避免循环
    except Exception:  # noqa: BLE001 - git 模块异常不影响文件工具结果
        return ""
    try:
        snap = snapshot_session(
            ctx.cwd, f"session {ctx.task_id} {tool} {note or file_path.name}"
        )
    except Exception:  # noqa: BLE001 - git 失败静默降级，不阻断文件工具
        return ""
    if snap.get("repo") and snap.get("commit"):
        try:
            ctx.emit(
                "INFO", f"git checkpoint：{snap['commit']}（{tool} {file_path.name}）",
                "base", "git/checkpoint",
                {"commit": snap["commit"], "tool": tool, "filePath": str(file_path)},
            )
        except Exception:  # noqa: BLE001
            pass
        return f"\n[git checkpoint] {snap['commit']}"
    return ""


def tool_edit_file(args: dict, ctx) -> str:
    """exact-match 编辑：old_string 精确匹配后替换为 new_string（§3.4 补丁语义）。

    - old_string 未找到 → 返回定位提示（请先 read_file 核对原文）；
    - old_string 出现多次且未显式 replace_all → 拒绝并提示补上下文；
    - 成功后落 patch/applied 事件（§5.2 补丁族）。
    """
    try:
        target = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not target.exists() or not target.is_file():
        return f"[错误] 文件不存在: {target}"
    size = target.stat().st_size
    if size > EDIT_MAX_FILE:
        return f"[错误] 文件过大（{size} 字节 > 200KB），请用 write_file 整文件重写"
    old_string = str(args.get("old_string", ""))
    new_string = str(args.get("new_string", ""))
    replace_all = bool(args.get("replace_all", False))
    if not old_string:
        return "[错误] 缺少 old_string（exact-match 必须提供待替换原文）"
    try:
        content = target.read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        return f"[错误] 读取失败: {e}"

    count = content.count(old_string)
    if count == 0:
        # 给出文件前几行，帮助 LLM 修正 old_string（防静默乱改的定位提示）
        head = "\n".join(content.splitlines()[:5])
        return (
            f"[错误] old_string 未找到（出现 0 次），未做任何修改。\n"
            f"请先 read_file 核对原文（注意空白/缩进/转义），文件: {target}\n"
            f"文件开头：\n{head}"
        )
    if count > 1 and not replace_all:
        return (
            f"[错误] old_string 出现 {count} 次，无法唯一匹配，未做任何修改。\n"
            f"请补充更多上下文使 old_string 唯一，或设置 replace_all=true 全部替换。\n"
            f"文件: {target}"
        )
    if replace_all:
        new_content = content.replace(old_string, new_string)
    else:
        new_content = content.replace(old_string, new_string, 1)
    try:
        target.write_text(new_content, encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        return f"[错误] 写入失败: {e}"

    replaced = count if replace_all else 1
    ctx.emit(
        "INFO", f"已应用精确编辑 {target.name}（替换 {replaced} 处）", "base",
        "patch/applied",
        {
            "filePath": str(target),
            "oldLength": len(old_string),
            "newLength": len(new_string),
            "replacements": replaced,
            "replaceAll": replace_all,
        },
    )
    cp = checkpoint_after_mutation(ctx, "edit_file", target, note=f"replace {replaced}")
    return (
        f"✅ 已编辑 {target}：替换 {replaced} 处（old={len(old_string)} 字符 → "
        f"new={len(new_string)} 字符）{cp}"
    )


# ---------------------------------------------------------------- file_tree（轻量感知）

def tool_file_tree(args: dict, ctx) -> str:
    """递归目录树（§3.5 轻量感知：文件树即时查询，不建全工程索引）。

    跳过 build/.git/node_modules 等目录，默认深度 FILE_TREE_MAX_DEPTH；
    目录在前、文件在后，文件附字节数；行数超 FILE_TREE_MAX_LINES 截断。
    """
    try:
        base = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not base.exists():
        return f"[错误] 路径不存在: {base}"
    if not base.is_dir():
        return f"[错误] 不是目录: {base}"
    try:
        depth = max(1, min(int(args.get("depth", FILE_TREE_MAX_DEPTH)), 6))
    except (TypeError, ValueError):
        depth = FILE_TREE_MAX_DEPTH

    lines: list[str] = [f"{base.name}/" if base.name else str(base)]

    def _walk(dir_path: Path, level: int) -> None:
        if len(lines) >= FILE_TREE_MAX_LINES:
            return
        try:
            entries = sorted(
                [p for p in dir_path.iterdir() if p.name not in SKIP_DIRS],
                key=lambda p: (not p.is_dir(), p.name.lower()),
            )
        except OSError:
            return
        for p in entries:
            if len(lines) >= FILE_TREE_MAX_LINES:
                lines.append("  " * level + "…（已截断）")
                return
            pad = "  " * level
            try:
                if p.is_dir():
                    lines.append(f"{pad}{p.name}/")
                    if level < depth:
                        _walk(p, level + 1)
                else:
                    size = p.stat().st_size
                    lines.append(f"{pad}{p.name}  ({size} 字节)")
            except OSError:
                continue

    _walk(base, 1)
    return _truncate("\n".join(lines), limit=6000)


# ---------------------------------------------------------------- glob / grep（轻量感知）

def _iter_search_files(base: Path, glob_pattern: str) -> list[Path]:
    """按 glob 收集待搜索文件（跳过 build/.git 等目录，限量）。

    rglob 语义 = `**/` + pattern，因此 "*.c" 会递归匹配全部层级；"**/*.c" 等价。
    """
    if glob_pattern:
        it = base.rglob(glob_pattern)
    else:
        it = base.rglob("*")
    files: list[Path] = []
    for p in it:
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        files.append(p)
        if len(files) >= SEARCH_MAX_FILES:
            break
    return files


def tool_glob(args: dict, ctx) -> str:
    """文件名模式匹配（§3.5：glob 即时查询，不建全工程索引）。

    返回匹配文件清单（相对 path 的路径 + 字节数），最多 SEARCH_MAX_RESULTS 条。
    """
    try:
        base = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not base.exists():
        return f"[错误] 路径不存在: {base}"
    pattern = str(args.get("glob", "")).strip() or "**/*"
    files = _iter_search_files(base, pattern)
    if not files:
        return f"（未匹配到文件）glob={pattern} 路径: {base}"
    rows = [f"{p.relative_to(base).as_posix()}（{p.stat().st_size} 字节）" for p in files]
    return _truncate(
        f"匹配 {len(files)} 个文件（glob={pattern}，路径: {base}）：\n"
        + "\n".join(rows[:SEARCH_MAX_RESULTS])
    )


def tool_grep(args: dict, ctx) -> str:
    """正则内容搜索（§3.5：grep 即时查询，忽略大小写，防超大工程卡死）。

    可选 glob 过滤文件集（如 **/*.c）；返回「文件:行: 内容」，
    最多 SEARCH_MAX_RESULTS 条、单文件 SEARCH_MAX_LINES 条。
    """
    try:
        base = ctx.resolve(str(args.get("path", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not base.exists():
        return f"[错误] 路径不存在: {base}"
    query = str(args.get("query", "")).strip()
    if not query:
        return "[错误] 缺少 query（内容正则，如 gpio_set_level、TODO）"
    try:
        rx = re.compile(query, re.IGNORECASE)
    except re.error as e:
        return f"[错误] 正则无效: {e}"

    files = _iter_search_files(base, str(args.get("glob", "")).strip())
    if not files:
        return f"（未匹配到文件）路径: {base}"

    matches: list[tuple[str, int, str]] = []
    for p in files:
        if p.stat().st_size > EDIT_MAX_FILE:
            continue  # 跳过超大文件
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:  # noqa: BLE001 - 二进制/不可读文件跳过
            continue
        hit = 0
        for i, ln in enumerate(lines, 1):
            if rx.search(ln):
                matches.append((p.relative_to(base).as_posix(), i, ln.strip()[:200]))
                hit += 1
                if hit >= SEARCH_MAX_LINES:
                    break
        if len(matches) >= SEARCH_MAX_RESULTS:
            break

    if not matches:
        return f"（无匹配）query={query} 路径: {base}"
    rows = [f"{f}:{ln}: {text}" for f, ln, text in matches]
    return _truncate(
        f"匹配 {len(matches)} 处（query={query}，路径: {base}）：\n" + "\n".join(rows)
    )


# ---------------------------------------------------------------- 项目类型探测（profile 化）

def detect_project_type(proj: Path) -> str | None:
    """探测工程类型 → 校验器 profile（§4.1 参与条件）。

    - esp-idf：`sdkconfig` 存在，或 `CMakeLists.txt` + `main/` 目录（ESP-IDF 工程特征）
      → "esp-idf"（MCU 手脚）；
    - ts：`tsconfig.json` 存在（且不满足 esp-idf）→ "ts"（通用语言 profile）。
    返回 None = 无法识别（run_check 会给出提示，不静默失败）。
    """
    if (proj / "sdkconfig").exists() or (
        (proj / "CMakeLists.txt").exists() and (proj / "main").is_dir()
    ):
        return "esp-idf"
    if (proj / "tsconfig.json").exists():
        return "ts"
    return None


def _run_tsc(proj: Path) -> tuple[str, bool]:
    """真实校验 TS 工程：tsc --noEmit -p <tsconfig>（§3.3 工具链复用）。

    tsc 解析顺序：工程 node_modules/.bin/tsc（Windows 补 .cmd）→ PATH 全局 tsc。
    Windows 下 .cmd/.bat 需经 cmd /c 包装执行。返回 (日志, 成功)。
    """
    tsc = shutil.which("tsc")
    local = proj / "node_modules" / ".bin"
    for cand in ("tsc.cmd", "tsc"):
        if (local / cand).exists():
            tsc = str(local / cand)
            break
    if not tsc:
        return (
            "[环境错误] 未找到 tsc：请先在本机安装 TypeScript（npm i -g typescript）"
            "或为工程安装 node_modules 依赖（工程内 node_modules/.bin/tsc）。",
            False,
        )
    args = [tsc, "--noEmit", "-p", "tsconfig.json"]
    # Windows 的 .cmd/.bat 是批处理壳，须经 cmd /c 执行（直接 Popen 会 WinError 193）
    if tsc.lower().endswith((".cmd", ".bat")):
        import os  # noqa: PLC0415 - 仅 Windows shim 路径需要

        cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/c", *args]
    else:
        cmd = args
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(proj),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TSC_TIMEOUT,
        )
        log = ((proc.stdout or "") + (proc.stderr or ""))[-16000:].strip()
        return log, proc.returncode == 0
    except subprocess.TimeoutExpired:
        return "[环境错误] tsc 执行超时", False
    except Exception as e:  # noqa: BLE001
        return f"[环境错误] tsc 执行异常: {e}", False


# tsc 输出行格式（两种官方格式都要兼容）：
#   A) src/index.ts(5,9): error TS2322: Type 'string' ...    （--pretty false）
#   B) src/foo.ts:3:5 - error TS2304: Cannot find name 'x'.  （默认 pretty 单行）
_TS_PATH = r"(?P<path>[\w./\\-]+\.(?:tsx?|mts|cts|d\.ts))"
_TS_LOC = r"(?:\((?P<al>\d+),(?P<ac>\d+)\)|:(?P<bl>\d+):(?P<bc>\d+))"
_TS_TAIL = r"\s*(?P<level>error|warning)\s+TS(?P<code>\d+):\s*(?P<msg>.*)$"
_TS_DIAG_RE = re.compile(
    _TS_PATH + _TS_LOC + r"(?::\s*|\s*-)" + _TS_TAIL,
    re.IGNORECASE,
)


def parse_ts_diagnostics(log: str, project_dir: str, base_dir: str) -> list[dict]:
    """把 tsc 输出解析为 CodeDiagnostic 列表（§3.3，与 C 诊断同一结构）。

    filePath 统一为「相对 cwd 的路径」（工程内相对路径 + 工程相对 cwd 前缀）。
    ruleId 直接用 TS 错误码（如 ts2322），fixable=False（V1 单向）。
    """
    diags: list[dict] = []
    seen: set[tuple] = set()
    try:
        rel_prefix = Path(project_dir).resolve().relative_to(Path(base_dir).resolve())
    except ValueError:
        rel_prefix = None
    for raw in (log or "").splitlines():
        m = _TS_DIAG_RE.search(raw)
        if not m:
            continue
        path = m.group("path")
        line = int(m.group("al") or m.group("bl"))
        col = int(m.group("ac") or m.group("bc"))
        msg = m.group("msg").strip()
        fp = (rel_prefix / path).as_posix() if rel_prefix is not None else path
        key = (fp, line, col, msg)
        if key in seen:
            continue
        seen.add(key)
        diags.append(
            {
                "level": "warn" if m.group("level").lower() == "warning" else "error",
                "filePath": fp,
                "range": {
                    "start": {"line": line, "column": col},
                    "end": {"line": line, "column": col + 1},
                },
                "message": msg[:300],
                "ruleId": f"ts{m.group('code')}",
                "fixable": False,
            }
        )
    return diags


# ---------------------------------------------------------------- run_check（真实校验 + 诊断）

def tool_run_check(args: dict, ctx) -> str:
    """真实校验：按工程类型自动选校验器 → 结构化 CodeDiagnostic（§3.3，单向、无自动修复回环）。

    - ts 工程（tsconfig.json）→ tsc --noEmit；
    - esp-idf 工程（CMakeLists.txt / sdkconfig）→ idf.py build；
    - 无法识别 → 提示支持的工程类型（不静默失败）。

    落事件（§5.2 校验族）：check/start → 逐条 diagnostic（前 20 条）→ check/end。
    文本结果 = 诊断摘要；结构化诊断随 diagnostic 事件 payload 下发。
    """
    try:
        proj = ctx.resolve(str(args.get("project_dir", "")))
    except ValueError as e:
        return f"[错误] {e}"
    if not proj.exists() or not proj.is_dir():
        return f"[错误] 工程目录不存在: {proj}"
    ptype = detect_project_type(proj)
    if ptype is None:
        return (
            f"[错误] 无法识别工程类型（{proj}）：本机当前支持 ts（tsconfig.json）"
            "与 esp-idf（CMakeLists.txt/sdkconfig）两类校验。"
        )

    ctx.emit(
        "INFO", f"开始校验：{proj.name}（checker={ptype}）", "base", "check/start",
        {"project_dir": str(proj), "checker": ptype},
    )

    if ptype == "ts":
        log, ok = _run_tsc(proj)
        diags = parse_ts_diagnostics(log, str(proj), ctx.cwd)
    else:
        log, ok = run_idf(str(proj), ["-B", "build", "build"], timeout=IDF_BUILD_TIMEOUT)
        diags = parse_diagnostics(log, str(proj), ctx.cwd)

    for d in diags[:20]:
        r = d["range"]["start"]
        ctx.emit(
            "ERROR" if d["level"] == "error" else "WARN",
            f"{d['filePath']}:{r['line']}:{r['column']} {d['message']}",
            "base", "diagnostic", d,
        )
    ctx.emit(
        "INFO" if ok else "ERROR",
        f"校验{'通过' if ok else '失败'}（checker={ptype}，{len(diags)} 条诊断）",
        "base", "check/end", {"ok": ok, "checker": ptype, "diagnostic_count": len(diags)},
    )
    head = "✅ 编译校验通过" if ok else f"❌ 编译校验失败（{len(diags)} 条诊断）"
    return _truncate(head + "\n" + _format_diagnostics(diags), limit=6000)


def _truncate(text: str, limit: int = 6000) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（输出过长，已截断，共 {len(text)} 字符）"


TOOL_IMPL = {
    "edit_file": tool_edit_file,
    "file_tree": tool_file_tree,
    "glob": tool_glob,
    "grep": tool_grep,
    "run_check": tool_run_check,
}
