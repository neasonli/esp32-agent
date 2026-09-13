"""把内核打成单目录可执行程序（跨平台，PyInstaller）。

为什么用 PyInstaller 而不是 Nuitka：
- PyInstaller 只需 pip 安装，不需要 C 编译器（Windows 的 Nuitka 要 MSVC Build Tools，CI/用户机都更容易）；
- 本项目内核依赖 torch / sentence-transformers / langgraph，PyInstaller 的官方 hook 覆盖更全。

⚠️ 铁律：**PyInstaller 不能交叉编译**。它把"当前操作系统的 Python 运行时"打进产物，
   在 Windows 上打不出 macOS/Linux 的内核二进制。三平台各自在对应系统（或 CI 对应 runner）上跑本脚本。

用法：
    # 开发机（Windows）打本机可用的内核，产物直接进桌面端 resources/kernel
    .venv\\Scripts\\python.exe scripts\\build_kernel.py

    # 明确排除私有知识库（只打通用模式内核，体积小很多）
    ... build_kernel.py --no-kb

    # 只打不拷贝（产物留在 kernel/dist/）
    ... build_kernel.py --no-copy

产物布局（与 KernelManager 的查找路径对齐）：
    <out>/lcode-kernel(.exe)      ← KernelManager 用这个
    <out>/_internal/**            ← PyInstaller 6 的依赖目录，必须与可执行文件同级
"""
from __future__ import annotations

import argparse
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

KERNEL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUT = KERNEL_DIR.parent / "desktop" / "resources" / "kernel"
SEP = ";" if sys.platform == "win32" else ":"

# 运行时数据（内核启动时要读的目录）：随包带走
DATA_DIRS = ["assets", "templates"]

# 内核自己的包：uvicorn 是以**字符串** "api.main:app" 导入应用的（见 run_kernel.py），
# PyInstaller 静态分析看不见字符串导入 → 必须显式收集，否则冻结后启动即
# ModuleNotFoundError: No module named 'api'（实测踩过）。
OWN_PACKAGES = ["api", "agent", "tools", "db", "config", "rag"]

# 这些包靠动态导入/插件机制加载，PyInstaller 静态分析扫不到 → 显式收集
COLLECT_ALL = [
    "langgraph",
    "langchain_core",
    "langgraph_checkpoint_sqlite",
    "pydantic_settings",
]
# 仅知识库模式需要（--no-kb 时会被 EXCLUDE_WHEN_NO_KB 排除）
COLLECT_ALL_KB = [
    "langchain_community",
    "langchain_text_splitters",
]
COLLECT_SUBMODULES = ["uvicorn", "fastapi", "pydantic", "dotenv"]
# 会读自身包元数据的库（缺 --copy-metadata 会在运行时报 PackageNotFoundError）
COPY_METADATA = ["langchain-core", "langgraph", "pydantic"]
COPY_METADATA_KB = ["sentence-transformers", "torch"]

# --no-kb 时必须显式排除：rag/backend.py 里写的是 `import lcode_kb`（静态导入，包在 try 里），
# PyInstaller 的静态分析**照样会跟进去**，把私有知识库 + torch（1.1 GB）一起打进"精简版"内核。
EXCLUDE_WHEN_NO_KB = [
    "lcode_kb",
    "torch",
    "sentence_transformers",
    "langchain_huggingface",
    "langchain_community",
    "langchain_text_splitters",
    "pypdf",
    "transformers",
    "huggingface_hub",
]


def _has(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _own_modules() -> list[str]:
    """列出内核自己包里的全部模块（dotted name），用于 --hidden-import。

    为什么不依赖 `--collect-submodules <pkg>`：它按名字解析，**会撞上同名目录**。
    实测：从仓库根跑构建时，`--collect-submodules tools` 解析到了仓库根的 `tools/`
    （里面是 make-app-icon.py / stage-esp-idf.py 这类发布脚本），日志里出现
    `Hidden import 'tools.make-app-icon' not found`，同时内核真正的 `tools/config/api/
    agent/db/rag` 全都没进包 → 冻结产物启动即 `ModuleNotFoundError: No module named 'config'`。
    显式列举 + 强制 cwd 到内核目录，双保险。
    """
    skip_dirs = {"__pycache__", "dist", "build", "outputs", "data", "assets", "templates", "tests", "scripts", ".venv"}
    mods: list[str] = []
    for p in sorted(KERNEL_DIR.rglob("*.py")):
        if any(part in skip_dirs for part in p.parts):
            continue
        rel = p.relative_to(KERNEL_DIR)
        if rel.name in ("run_kernel.py", "run.py"):
            continue  # 入口脚本由 PyInstaller 直接分析 / 历史入口不必进包
        parts = list(rel.parts)
        if parts[-1] == "__init__.py":
            parts = parts[:-1]
        else:
            parts[-1] = parts[-1][:-3]
        if parts:
            mods.append(".".join(parts))
    return mods


def build_args(with_kb: bool) -> list[str]:
    args = [
        "--noconfirm",
        "--clean",
        "--onedir",  # 单目录：启动快、torch 这种大依赖更稳（onefile 每次启动都要解压）
        "--name",
        "lcode-kernel",
        "--distpath",
        str(KERNEL_DIR / "dist"),
        "--workpath",
        str(KERNEL_DIR / "build" / "pyinstaller"),
        "--specpath",
        str(KERNEL_DIR / "build"),
        "--console",  # 桌面端用管道接 stdout/stderr 落盘（kernel.log），不能 hide
    ]
    for d in DATA_DIRS:
        src = KERNEL_DIR / d
        if src.exists():
            args += ["--add-data", f"{src}{SEP}{d}"]
    for pkg in COLLECT_ALL:
        if _has(pkg):
            args += ["--collect-all", pkg]
    # 内核自己的模块：显式列举（原因见 _own_modules 的说明），并显式把内核目录放进搜索路径。
    own = _own_modules()
    for mod in own:
        args += ["--hidden-import", mod]
    args += ["--paths", str(KERNEL_DIR)]
    for pkg in COLLECT_SUBMODULES:
        if _has(pkg):
            args += ["--collect-submodules", pkg]
    for pkg in COPY_METADATA:
        args += ["--copy-metadata", pkg]
    if with_kb:
        for pkg in COPY_METADATA_KB:
            args += ["--copy-metadata", pkg]
        # 向量库数据：从私有包当前解析到的 store 目录取（通常是私有仓 data/rag_store），
        # 打进 _internal/data/rag_store；内核侧 rag/backend.py 会自动把 LCODE_KB_STORE_DIR
        # 指到该位置（见那里的注释）。
        store = None
        try:
            import lcode_kb  # type: ignore[import-not-found]

            store = Path(lcode_kb.kb_config.store_dir)
        except Exception:  # noqa: BLE001
            store = KERNEL_DIR / "data" / "rag_store"
        if store and store.exists():
            args += ["--add-data", f"{store}{SEP}data/rag_store"]
            n = len(list(store.glob("*.npy"))) + len(list(store.glob("*.json")))
            print(f"[i] 随包知识库向量: {store}（{n} 个文件）")
        else:
            print(f"[!] 未找到向量库目录（{store}）→ 打包出的知识库会是空的（kb_docs=0）")
        for pkg in COLLECT_ALL_KB:
            if _has(pkg):
                args += ["--collect-all", pkg]
    if with_kb:
        # 私有知识库包（闭源）：源码不在公开仓，但已 pip 装进本 venv → 一起打进去。
        # torch / numpy 交给 PyInstaller 内置 hook 收集（不要 --collect-all torch：会把整个包
        # 连测试资源一起收进来，体积爆炸）。
        args += ["--hidden-import", "lcode_kb"]
        for pkg in ("lcode_kb", "sentence_transformers", "langchain_huggingface"):
            if _has(pkg):
                args += ["--collect-all", pkg]
    else:
        for pkg in EXCLUDE_WHEN_NO_KB:
            args += ["--exclude-module", pkg]
    args.append(str(KERNEL_DIR / "run_kernel.py"))
    return args


def smoke_test_frozen(exe: Path) -> tuple[bool, str]:
    """启动刚冻结出来的内核并查 /api/health —— 构建的一部分，不是可选项。

    为什么必须有：冻结产物的问题（uvicorn 字符串导入、误挂不存在的 hidden-import、
    namespace 包等）只有在**运行**时才暴露；本机实测就出现过"构建成功、启动即
    ModuleNotFoundError: No module named 'config'"，一路带到安装包里才发现。
    """
    import json
    import socket
    import subprocess
    import tempfile
    import time
    import urllib.request

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    token = "smoke-" + str(port)
    with tempfile.TemporaryDirectory(prefix="lcode-kernel-smoke-") as tmp:
        proc = subprocess.Popen(
            [str(exe), "--port", str(port), "--token", token, "--data-dir", tmp],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(exe.parent),
        )
        try:
            deadline = time.time() + 90
            while time.time() < deadline:
                if proc.poll() is not None:
                    out = (proc.stdout.read() if proc.stdout else "") or ""
                    return False, f"内核进程提前退出(code={proc.returncode})：\n{out[-1500:]}"
                try:
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/api/health", headers={"X-Kernel-Token": token}
                    )
                    with urllib.request.urlopen(req, timeout=3) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    return True, json.dumps(
                        {
                            "status": data.get("status"),
                            "kb_backend": data.get("kb_backend"),
                            "kb_docs": data.get("kb_docs"),
                            "llm_configured": data.get("llm_configured"),
                        },
                        ensure_ascii=False,
                    )
                except Exception:  # noqa: BLE001 — 还没起来，继续等
                    time.sleep(1.5)
            return False, "90 秒内 /api/health 未就绪"
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc.kill()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L-CODE 内核打包（PyInstaller，单目录）")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help=f"拷贝目标目录（默认 {DEFAULT_OUT}）")
    ap.add_argument("--no-copy", action="store_true", help="只构建，不拷贝到桌面端 resources")
    ap.add_argument("--no-kb", action="store_true", help="不打包私有知识库（只出通用模式内核）")
    ap.add_argument("--onefile", action="store_true", help="打成单文件（启动慢，体积不一定更小）")
    ap.add_argument("--no-smoke", action="store_true", help="跳过构建后的启动冒烟（不建议）")
    args = ap.parse_args(argv)

    if not _has("PyInstaller"):
        print("[错误] 未安装 PyInstaller。请先：")
        print(f'  "{sys.executable}" -m pip install pyinstaller')
        return 1

    with_kb = (not args.no_kb) and _has("lcode_kb")
    if not args.no_kb and not with_kb:
        print("[提示] 本 venv 未安装私有知识库包 lcode_kb → 只打通用模式内核（stub，无手册检索）")

    py_args = build_args(with_kb)
    if args.onefile:
        py_args = [a for a in py_args if a != "--onedir"] + ["--onefile"]

    print(f"平台     : {sys.platform} / {sys.executable}")
    print(f"知识库   : {'包含（private）' if with_kb else '不包含（stub 通用模式）'}")
    print(f"产物目录 : {KERNEL_DIR / 'dist' / 'lcode-kernel'}")
    print("开始构建（torch 在内时首次可能 10~30 分钟）...")
    cmd = [sys.executable, "-m", "PyInstaller", *py_args]
    print("$", " ".join(cmd))
    # cwd 强制为内核目录：PyInstaller 会把 cwd 放进模块搜索路径，从仓库根跑时
    # `tools` 这类同名目录会抢在内核包前面（本次踩坑的根因），必须钉死。
    rc = subprocess.call(cmd, cwd=str(KERNEL_DIR))
    if rc != 0:
        print(f"[失败] PyInstaller exit={rc}")
        return rc

    built = KERNEL_DIR / "dist" / "lcode-kernel"
    exe = built / ("lcode-kernel.exe" if sys.platform == "win32" else "lcode-kernel")
    if not exe.exists():
        print(f"[失败] 未找到产物可执行文件: {exe}")
        return 1

    m = sum(f.stat().st_size for f in built.rglob("*") if f.is_file())
    print(f"[完成] {exe}（整包 {m / 1024 / 1024:.1f} MB）")

    # 冒烟：构建即验证（跳过请显式加 --no-smoke，不建议）
    if not args.no_smoke:
        print("[冒烟] 启动冻结内核并检查 /api/health ...")
        ok, detail = smoke_test_frozen(exe)
        if not ok:
            print(f"[失败] 冻结内核起不来：{detail}")
            print("        提示：这类问题看 warn 文件里的 'missing module named ...' 最快")
            return 1
        print(f"[冒烟通过] {detail}")

    if args.no_copy:
        return 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # 清掉旧产物（避免上一版残留的 _internal 混进新包）
    for child in out.iterdir():
        if child.name == "README.md":
            continue
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    for child in built.iterdir():
        dst = out / child.name
        shutil.copytree(child, dst) if child.is_dir() else shutil.copy2(child, dst)
    print(f"[完成] 已放入桌面端资源目录: {out}")
    print("        KernelManager 会优先使用它（打包后无需 Python 环境）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
