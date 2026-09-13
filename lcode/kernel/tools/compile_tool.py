"""ESP-IDF 编译工具封装：subprocess 调用 idf.py build。

定位/执行策略（按优先级）：
1. PATH 中已有 idf.py（ESP-IDF 终端内 export 过）→ 直接调用
2. .env 配置了 IDF_PATH 但当前 shell 未 export →
   Windows: cmd /c "call {IDF_PATH}/export.bat && idf.py ..."
   Linux:   bash -c "source {IDF_PATH}/export.sh && idf.py ..."
   这样服务可在普通终端启动，无需每次手动 export。
"""
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from config.settings import settings

# 编译阶段标志（用于进度事件）
PHASE_MARKERS = {
    "Running cmake": "CMake 配置",
    "Building components": "编译组件",
    "Generating binary": "生成二进制",
    "Project build complete": "构建完成",
}


def find_idf_py() -> str | None:
    """返回 idf.py 路径，未找到返回 None。"""
    import shutil

    exe = shutil.which("idf.py")
    if exe:
        return exe
    if settings.idf_path:
        root = Path(settings.idf_path)
        direct = root / "tools" / "idf.py"
        if direct.exists():
            return str(direct)
        for cand in root.rglob("idf.py"):
            if "tools" in cand.parts:
                return str(cand)
    return None


def _tool_bin_dirs() -> list[str]:
    """扫描 IDF 工具目录，返回需要加进 PATH 的目录（含可执行文件的那一层）。

    为什么自己扫而不用 `export.bat` / `idf_tools.py export`：
    1. `export.bat` 要求 PATH 里已有 `python.exe` 与 `git.exe`（随包安装的用户机上未必有）；
    2. `idf_tools.py export` 会校验 tools.json 里所有 `install: always` 的工具是否存在——
       随包载荷为省 2.4 GB 砍掉了 riscv32-esp-elf（只有 esp32c3/c6 用），于是 export 直接报
       "tool riscv32-esp-elf has no installed versions" 而失败；
    3. 各工具目录布局不统一（`xtensa-esp-elf/<ver>/xtensa-esp-elf/bin`、`cmake/<ver>/bin`、
       `ninja/<ver>/` 里直接放 exe），所以按"哪一层有可执行文件"来判断，而不是写死结构。
    """
    tools_root = Path(settings.idf_tools_path) if settings.idf_tools_path else None
    if not tools_root or not tools_root.exists():
        return []
    exts = (".exe", ".bat", ".cmd") if os.name == "nt" else ("",)
    found: list[str] = []
    for tool_dir in sorted((tools_root / "tools").glob("*")):
        if not tool_dir.is_dir():
            continue
        # tools/<name>/<version>/... ：在版本目录下最多两层内找"直接含可执行文件"的目录
        for ver_dir in sorted(tool_dir.glob("*")):
            if not ver_dir.is_dir():
                continue
            candidates = [ver_dir] + [d for d in sorted(ver_dir.glob("*")) if d.is_dir()]
            candidates += [d for d in sorted(ver_dir.glob("*/*")) if d.is_dir()]
            hit = False
            for cand in candidates:
                try:
                    exes = [
                        f
                        for f in cand.iterdir()
                        if f.is_file()
                        and (f.suffix.lower() in exts if os.name == "nt" else os.access(f, os.X_OK))
                    ]
                except OSError:
                    continue
                if exes and str(cand) not in found:
                    found.append(str(cand))
                    hit = True
                    break
            if hit:
                break
    return found


def _tool_dir(name: str) -> Path | None:
    """取某个工具已安装的版本目录（tools/<name>/<version>）。"""
    if not settings.idf_tools_path:
        return None
    vers = sorted((Path(settings.idf_tools_path) / "tools" / name).glob("*"))
    for v in reversed(vers):
        if v.is_dir():
            return v
    return None


def _build_env() -> dict:
    """构造完整编译环境。

    必传：IDF_PATH / IDF_TOOLS_PATH / IDF_PYTHON_ENV_PATH（idf.py 默认找 ~/.espressif，
    本项目常装在自定义或安装目录内，不传会误判"工具未安装"）。
    另外自己拼 PATH：把随包工具链的 bin 与 IDF Python 环境放到最前面，
    这样**不需要**用户机器上有 python/git，也不需要 export.bat（见 _tool_bin_dirs 注释）。
    """
    env = os.environ.copy()
    if settings.idf_path:
        env["IDF_PATH"] = settings.idf_path
    if settings.idf_tools_path:
        env["IDF_TOOLS_PATH"] = settings.idf_tools_path
    if settings.idf_python_env_path:
        env["IDF_PYTHON_ENV_PATH"] = settings.idf_python_env_path
    env.setdefault("IDF_TARGET", settings.idf_target)

    prepend: list[str] = []
    if settings.idf_python_env_path:
        scripts = Path(settings.idf_python_env_path) / ("Scripts" if os.name == "nt" else "bin")
        if scripts.exists():
            prepend.append(str(scripts))
    prepend += _tool_bin_dirs()
    if prepend:
        existing = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(prepend + ([existing] if existing else []))
        env["LCODE_IDF_PATH_EXPORTED"] = "1"

    rom = _tool_dir("esp-rom-elfs")
    if rom:
        env["ESP_ROM_ELF_DIR"] = str(rom)
    ocd = _tool_dir("openocd-esp32")
    if ocd:
        for scripts in ocd.glob("*/share/openocd/scripts"):
            env["OPENOCD_SCRIPTS"] = str(scripts)
            break
    return env


def _idf_python() -> str:
    """返回 IDF Python 环境解释器路径（用于执行 idf.py 脚本）。"""
    if settings.idf_python_env_path:
        cand = Path(settings.idf_python_env_path) / "Scripts" / "python.exe"
        if cand.exists():
            return str(cand)
    import shutil

    py = shutil.which("python")
    return py or "python"


def _build_command(
    project_dir: str, idf_args: list[str] | None = None, extra_env: dict | None = None
) -> tuple[list[str] | str, dict]:
    """构造编译命令与环境。

    Windows 上不能直接 subprocess 执行 .py 脚本（WinError 193），
    必须通过 IDF Python 环境解释器调用 idf.py。
    优先走 export.bat 包装：它会自动把工具链（cmake/ninja/gcc）加入 PATH。
    idf_args: idf.py 参数列表（默认 ["-B", "build", "build"]）。
    extra_env: 追加环境变量（如 ESPPORT 烧录端口）。
    """
    env = _build_env()
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items()})
    args = idf_args if idf_args is not None else ["-B", "build", "build"]

    # 1) 首选：环境由我们自己拼好了（_build_env 扫到了工具链）→ 直接跑 idf.py。
    #    这条路不要求用户机器有 python/git，也不受 export.bat 的 requirements 检查影响，
    #    是"随包 ESP-IDF"能开箱即用的前提。
    idf_py = find_idf_py()
    if idf_py and env.get("LCODE_IDF_PATH_EXPORTED"):
        return [_idf_python(), idf_py, *args], env

    # 2) 次选：export 脚本包装（自动配置 PATH；需要用户环境有 python/git）
    if settings.idf_path:
        idf_root = Path(settings.idf_path)
        if sys.platform == "win32":
            export = idf_root / "export.bat"
            if export.exists():
                # 整条字符串 + shell=True：避免 subprocess 对引号做 list2cmdline 转义
                arg_str = " ".join(args)
                cmd = f'call "{export}" && python "%IDF_PATH%\\tools\\idf.py" {arg_str}'
                return cmd, env
        else:
            export = idf_root / "export.sh"
            if export.exists():
                arg_str = " ".join(args)
                inner = f'python "$IDF_PATH/tools/idf.py" {arg_str}'
                return ["bash", "-c", f'source "{export}" && {inner}'], env

    # 3) 兜底：idf.py 已在 PATH（ESP-IDF 终端内），直接调用
    if idf_py:
        python_exe = _idf_python()
        return [python_exe, idf_py, *args], env

    return [], env


def run_idf(
    project_dir: str,
    idf_args: list[str],
    timeout: int | None = None,
    extra_env: dict | None = None,
    on_progress: Callable[[str, str], None] | None = None,
) -> tuple[str, bool]:
    """通用 idf.py 执行（build / flash / menuconfig 等），返回 (日志, 成功)。

    on_progress: 可选回调 on_progress(line, phase)，用于 L4 进度事件。
    """
    cmd, env = _build_command(project_dir, idf_args, extra_env)
    if not cmd:
        return (
            "[环境错误] 未找到 idf.py：请先安装 ESP-IDF v5.x 并运行其 export 脚本，"
            "或在 .env 配置 IDF_PATH。",
            False,
        )

    def _feed_progress(line: str) -> None:
        if not on_progress:
            return
        for marker, phase in PHASE_MARKERS.items():
            if marker.lower() in line.lower():
                on_progress(line, phase)
                break

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=project_dir,
            env=env,
            shell=isinstance(cmd, str),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        lines: list[str] = []
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line)
            _feed_progress(line)
        proc.wait(timeout=timeout or settings.compile_timeout)
        log = ("".join(lines)[-16000:]).strip()
        return log, proc.returncode == 0
    except subprocess.TimeoutExpired:
        proc.kill()
        return "[环境错误] 执行超时", False
    except Exception as e:  # noqa: BLE001
        return f"[环境错误] 执行异常: {e}", False


def compile_project(
    project_dir: str,
    timeout: int | None = None,
    on_progress: Callable[[str, str], None] | None = None,
) -> tuple[str, bool]:
    """执行交叉编译，返回 (日志, 是否成功)。

    on_progress: 可选回调 on_progress(line, phase)，用于 L4 进度事件（阶段2 W2）。
    解析 idf.py 输出中的阶段标志，并在编译后扫描产物。
    """

    def _progress(line: str, phase: str) -> None:
        if not on_progress:
            return
        on_progress(line, phase)

    log, ok = run_idf(project_dir, ["-B", "build", "build"], timeout=timeout, on_progress=_progress)
    # L4：扫描已生成产物
    if ok and on_progress:
        for art in _scan_artifacts(project_dir):
            on_progress("", f"产物 {art['name']}（{art['size_kb']} KB）")
    return log, ok


def _scan_artifacts(project_dir: str) -> list[dict]:
    """扫描 build 目录产物（bootloader/partition/app）。"""
    build = Path(project_dir) / "build"
    artifacts = []
    if build.exists():
        for f in sorted(build.glob("*.bin")) + sorted(build.glob("*.elf")):
            artifacts.append(
                {"name": f.name, "size_kb": round(f.stat().st_size / 1024, 1)}
            )
    return artifacts
