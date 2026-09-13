"""把本机安装好的 ESP-IDF 裁剪/搬移成"可随安装包分发"的载荷。

背景（用户需求）：提供两个安装包版本 —— 不带 ESP-IDF（用户机已有环境时下载这个）
与带 ESP-IDF（开箱即可编译固件）。ESP-IDF 官方安装是 GB 级且带大量"安装缓存"，
直接塞进安装包既浪费体积又有搬迁风险，所以由本脚本负责：

1. **裁剪**：丢掉运行时不需要的部分。实测本机 `D:\\esp` 9.35 GB：
   | 部分 | 体积 | 处置 |
   |---|---|---|
   | `.espressif\\dist`（下载缓存） | 1,227 MB | 丢（只有 IDF 安装器/离线重装才用） |
   | `.espressif\\releases`（下载缓存） | 1,906 MB | 丢 |
   | `frameworks\\<idf>\\.git` | 1,805 MB | 丢（源码用不到 git 历史） |
   | `tools\\riscv32-esp-elf` | 2,387 MB | 仅 esp32c3/c6/h2 需要 → 默认丢（可 `--targets` 打开） |
   | 其余工具链 + 框架源码 + python_env | ~2.2 GB | **保留** |
   裁剪后约 2.2 GB（压缩进安装包后通常 0.9~1.3 GB）。

2. **搬迁修正**（这是能不能"装完即用"的关键）：
   - `python_env/pyvenv.cfg` 里 `home = <系统 Python 路径>`：普通用户机不一定有；
     故默认连**基础 Python** 一起打包（`--with-base-python`，约 100 MB），并把 home 指过去，
     这样不依赖用户机器的 Python。
   - `.espressif/idf-env.json` 记着旧绝对路径 → 重写成新布局（或删除，idf.py 不需要它）。
   - 工具链目录命名带版本+哈希，但工具本身按 IDF_TOOLS_PATH 解析 → 搬迁安全；
     导出环境由 `idf_tools.py export` 现算（不依赖 export.bat 里对 python/git 的 PATH 检查）。

3. **产出自述**：`manifest.json`（IDF 版本 / 目标芯片 / 各工具版本 / 体积 / 来源），
   桌面端据此在首次运行时给出默认 IDF 配置（设置页可改）。

用法：
    python tools/stage-esp-idf.py --src D:\\esp --dry-run          # 只看计划与体积（快，推荐先跑）
    python tools/stage-esp-idf.py --src D:\\esp                    # 真正暂存到 desktop/resources/esp-idf
    python tools/stage-esp-idf.py --src D:\\esp --targets esp32s3,esp32c3   # 带上 riscv 工具链
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "lcode" / "desktop" / "resources" / "esp-idf"

# 运行时必需的工具（无论目标芯片都要）
TOOLS_ALWAYS = [
    "xtensa-esp-elf",        # esp32/s2/s3 编译器（1.36 GB）
    "xtensa-esp-elf-gdb",    # 调试器（可 --no-gdb 去掉，约 125 MB）
    "cmake",
    "ninja",
    "ccache",
    "idf-exe",
    "idf-python",
    "esp-rom-elfs",
    "esp32ulp-elf",
]
# 按目标芯片决定
TOOLS_BY_TARGET = {
    "riscv32-esp-elf": {"esp32c3", "esp32c6", "esp32h2", "esp32p4"},
}
# 可选（不是编译必需）
TOOLS_OPTIONAL = ["openocd-esp32", "dfu-util"]
# `.espressif` **根目录下的散文件**必须一起带上（实测漏了它们会让 idf.py 直接报错：
# "espidf.constraints.v5.5.txt doesn't exist. Perhaps you've forgotten to run the install scripts."）
ESP_ROOT_FILES_KEEP = [
    "espidf.constraints",     # 前缀匹配：espidf.constraints.v5.5.txt（idf.py 依赖）
    "idf_cmd_init.bat",
    "idf_cmd_init.ps1",
    "idf_tools_fallback.py",  # 无网络时 idf_tools.py 用它
    "tools_fallback.json",    # 无网络时的工具清单
]
ESP_ROOT_FILES_SKIP = [
    "idf-env.json",           # 记着旧安装的绝对路径 → 由本脚本重写/删除
]
# 明确丢弃（安装缓存，与运行无关）
TOOLS_SKIP = ["dist", "releases"]
# 框架里丢弃的目录
FRAMEWORK_SKIP_DIRS = [".git"]
FRAMEWORK_OPTIONAL_DIRS = ["docs", "examples"]


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def find_idf_framework(src: Path) -> Path:
    fw_root = src / "frameworks"
    if not fw_root.exists():
        raise SystemExit(
            f"未找到 {fw_root}。Windows 官方安装器的布局是 <esp>\\frameworks\\esp-idf-<版本>；\n"
            "macOS/Linux（或手动 clone）请直接用 --framework 指定 ESP-IDF 源码目录、--tools 指定 IDF_TOOLS_PATH。"
        )
    cands = [d for d in fw_root.iterdir() if d.is_dir() and (d / "tools" / "idf.py").exists()]
    if not cands:
        raise SystemExit(f"{fw_root} 下没有含 tools/idf.py 的 ESP-IDF 目录")
    return sorted(cands, key=lambda d: d.name)[-1]


def find_base_python(pyvenv_cfg: Path) -> Path | None:
    """从 pyvenv.cfg 的 home 读出基础 Python 目录（venv 靠它加载 python3xx.dll 与标准库）。"""
    if not pyvenv_cfg.exists():
        return None
    for line in pyvenv_cfg.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.strip().startswith("home"):
            p = Path(line.split("=", 1)[1].strip())
            return p if p.exists() else None
    return None


def detect_idf_version(framework: Path) -> str:
    """读 ESP-IDF 版本号。

    IDF 源码里没有 version.txt（实测 → 会得到 "unknown"），权威来源是
    components/esp_common/include/esp_idf_version.h 里的 MAJOR/MINOR/PATCH 宏。
    """
    header = framework / "components" / "esp_common" / "include" / "esp_idf_version.h"
    if header.exists():
        text = header.read_text(encoding="utf-8", errors="ignore")
        parts = []
        for key in ("ESP_IDF_VERSION_MAJOR", "ESP_IDF_VERSION_MINOR", "ESP_IDF_VERSION_PATCH"):
            m = re.search(rf"#define\s+{key}\s+(\d+)", text)
            if m:
                parts.append(m.group(1))
        if parts:
            return "v" + ".".join(parts)
    ver_txt = framework / "version.txt"
    if ver_txt.exists():
        return ver_txt.read_text(encoding="utf-8").strip()
    return "unknown"


def build_plan(args) -> dict:
    src = Path(args.src)
    espressif = Path(args.tools) if args.tools else src / ".espressif"
    if not espressif.exists():
        raise SystemExit(
            f"未找到 {espressif}（ESP-IDF 工具目录，即 IDF_TOOLS_PATH）。"
            "macOS/Linux 常见位置为 ~/.espressif，可用 --tools 指定。"
        )
    framework = Path(args.framework) if args.framework else find_idf_framework(src)
    if not (framework / "tools" / "idf.py").exists():
        raise SystemExit(f"{framework} 下没有 tools/idf.py，不是 ESP-IDF 源码目录")
    targets = {t.strip() for t in args.targets.split(",") if t.strip()}

    tools_dir = espressif / "tools"
    tool_list = []
    for d in sorted(tools_dir.iterdir()) if tools_dir.exists() else []:
        if not d.is_dir() or d.name in TOOLS_SKIP:
            continue
        need = d.name in TOOLS_ALWAYS
        if d.name in TOOLS_BY_TARGET:
            need = bool(TOOLS_BY_TARGET[d.name] & targets)
        if d.name in TOOLS_OPTIONAL:
            need = not args.no_optional
        if d.name == "xtensa-esp-elf-gdb" and args.no_gdb:
            need = False
        tool_list.append({"name": d.name, "include": need, "size": dir_size(d)})

    fw_entries = []
    for d in sorted(framework.iterdir()):
        if not d.is_dir():
            continue
        size = dir_size(d)
        skip = d.name in FRAMEWORK_SKIP_DIRS
        if d.name in FRAMEWORK_OPTIONAL_DIRS and args.no_docs:
            skip = True
        fw_entries.append({"name": d.name, "include": not skip, "size": size})

    python_env = espressif / "python_env"
    base_python = find_base_python(python_env / "pyvenv.cfg")

    plan = {
        "src": str(src),
        "framework": {"path": str(framework), "entries": fw_entries, "size": dir_size(framework)},
        "espressif": str(espressif),
        "tools": tool_list,
        "python_env": {"path": str(python_env), "size": dir_size(python_env)},
        "base_python": {"path": str(base_python) if base_python else "", "size": dir_size(base_python) if base_python else 0},
        "targets": sorted(targets),
        "out": str(args.out),
    }
    keep = sum(t["size"] for t in tool_list if t["include"])
    keep += sum(e["size"] for e in fw_entries if e["include"])
    keep += plan["python_env"]["size"]
    keep += plan["base_python"]["size"] if (args.with_base_python and base_python) else 0
    plan["keep_bytes"] = keep
    plan["drop_bytes"] = dir_size(src) - keep
    return plan


def print_plan(plan: dict) -> None:
    mb = lambda n: n / 1024 / 1024  # noqa: E731
    print(f"ESP-IDF 源码 : {plan['framework']['path']}")
    print(f"工具目录     : {plan['espressif']}")
    print(f"目标芯片     : {', '.join(plan['targets']) or '(未指定)'}")
    print()
    print("— 工具链 —")
    for t in plan["tools"]:
        print(f"  [{'保留' if t['include'] else '丢弃'}] {t['name']:<24} {mb(t['size']):9.1f} MB")
    print("— 框架目录 —")
    for e in plan["framework"]["entries"]:
        print(f"  [{'保留' if e['include'] else '丢弃'}] {e['name']:<24} {mb(e['size']):9.1f} MB")
    print("— 其它 —")
    print(f"  [{'保留' if not False else '丢弃'}] python_env               {mb(plan['python_env']['size']):9.1f} MB")
    if plan["base_python"]["path"]:
        print(f"  [保留] 基础 Python {plan['base_python']['path']}")
        print(f"         {'':<24} {mb(plan['base_python']['size']):9.1f} MB")
    print()
    print(f"预计载荷: {mb(plan['keep_bytes']):.0f} MB   丢弃: {mb(plan['drop_bytes']):.0f} MB")
    print(f"输出目录: {plan['out']}")


def copy_tree(src: Path, dst: Path, skip_names: set[str], log: list[str]) -> int:
    """拷贝目录（跳过指定名字的顶层子目录），返回拷贝字节数。"""
    total = 0
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in skip_names:
            continue
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
            total += dir_size(item)
        else:
            shutil.copy2(item, target)
            total += item.stat().st_size
    return total


def stage(plan: dict, args) -> int:
    out = Path(plan["out"])
    if out.exists():
        print(f"[i] 清空旧载荷 {out}")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    # 1) 框架
    fw_dst = out / "framework"
    skip = {e["name"] for e in plan["framework"]["entries"] if not e["include"]}
    print(f"[1/4] 拷贝框架（跳过 {', '.join(sorted(skip)) or '无'}）...")
    fw_bytes = copy_tree(Path(plan["framework"]["path"]), fw_dst, skip, [])

    # 2) 工具链 + .espressif 根目录散文件
    print("[2/4] 拷贝工具链与工具目录配置 ...")
    tools_dst = out / ".espressif" / "tools"
    skip_tools = {t["name"] for t in plan["tools"] if not t["include"]} | set(TOOLS_SKIP)
    tools_bytes = copy_tree(Path(plan["espressif"]) / "tools", tools_dst, skip_tools, [])

    root_copied = []
    for item in Path(plan["espressif"]).iterdir():
        if not item.is_file() or item.name in ESP_ROOT_FILES_SKIP:
            continue
        if any(item.name.startswith(p) for p in ESP_ROOT_FILES_KEEP):
            shutil.copy2(item, out / ".espressif" / item.name)
            tools_bytes += item.stat().st_size
            root_copied.append(item.name)
    if root_copied:
        print(f"      工具目录散文件: {', '.join(root_copied)}")

    # 3) python_env + 基础 Python（并修 pyvenv.cfg）
    print("[3/4] 拷贝 python_env 与基础 Python ...")
    pe_src = Path(plan["python_env"]["path"])
    pe_dst = out / ".espressif" / "python_env"
    if pe_src.exists():
        shutil.copytree(pe_src, pe_dst, dirs_exist_ok=True)
    py_bytes = plan["python_env"]["size"]
    if args.with_base_python and plan["base_python"]["path"]:
        bp_src = Path(plan["base_python"]["path"])
        bp_dst = out / "python310"
        shutil.copytree(bp_src, bp_dst, dirs_exist_ok=True)
        py_bytes += plan["base_python"]["size"]
        # 关键：把 venv 的基础 Python 指向随包副本，从此不依赖用户机器的 Python
        cfg = pe_dst / "pyvenv.cfg"
        txt = cfg.read_text(encoding="utf-8", errors="ignore")
        lines = []
        for line in txt.splitlines():
            lines.append(f"home = {bp_dst}" if line.strip().startswith("home") else line)
        cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"      已改写 pyvenv.cfg home → {bp_dst}")

    # 4) 元数据：删掉旧绝对路径记录，写 manifest
    print("[4/4] 写 manifest ...")
    stale = out / ".espressif" / "idf-env.json"
    if stale.exists():
        stale.unlink()
    manifest = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "framework_dir": "framework",
        "tools_path": ".espressif",
        "python_env_path": ".espressif/python_env",
        "bundled_base_python": "python310" if (args.with_base_python and plan["base_python"]["path"]) else "",
        "targets": plan["targets"],
        "idf_version": detect_idf_version(Path(plan["framework"]["path"])),
        "tools": [{"name": t["name"]} for t in plan["tools"] if t["include"]],
        "bytes": {"framework": fw_bytes, "tools": tools_bytes, "python": py_bytes},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "README.md").write_text(
        "# 随包 ESP-IDF 载荷（由 tools/stage-esp-idf.py 生成）\n\n"
        f"- IDF 版本：{manifest['idf_version']}；目标芯片：{', '.join(manifest['targets'])}\n"
        f"- 生成时间：{manifest['generated_at']}；载荷 {sum(manifest['bytes'].values()) / 1024 / 1024:.0f} MB\n"
        "- 首次运行时桌面端会把 IDF_PATH / IDF_TOOLS_PATH / IDF_PYTHON_ENV_PATH 默认指向这里（设置页可改）\n"
        "- 许可证：ESP-IDF 为 Apache-2.0，工具链各自许可见其目录内 LICENSE；分发时保留 third_party 声明\n",
        encoding="utf-8",
    )
    total = sum(manifest["bytes"].values())
    print(f"[完成] {out}  （{total / 1024 / 1024:.0f} MB，用时 {time.time() - t0:.0f}s）")

    # 关键一步：打成**单个归档**。
    # 为什么不是直接把这 2.4 GB 目录塞进安装包：NSIS 的数据块上限是 2 GiB，实测超出后
    # 安装包能打出来、但**安装时崩溃**（exit 0xC0000005，一个文件都没进去）。
    # 打成归档后，安装包只需装这一个 ~700 MB 文件（未压缩数据 < 2 GiB ✓），
    # 首次运行时由应用解压到用户目录（可写、也不占安装目录）。
    if not args.no_zip:
        zip_path = Path(args.zip_out) if args.zip_out else out.parent / "esp-idf-payload.zip"
        if zip_path.exists():
            zip_path.unlink()
        print(f"[打包] 生成归档 {zip_path}（bsdtar；2.4 GB → 需几分钟）...")
        t1 = time.time()
        rc = subprocess.call(["tar", "-a", "-c", "-f", str(zip_path), "-C", str(out), "."])
        if rc != 0 or not zip_path.exists():
            print(f"[失败] 归档创建失败（tar exit={rc}）")
            return 1
        print(
            f"[完成] 归档 {zip_path}  {zip_path.stat().st_size / 1024 / 1024:.0f} MB，"
            f"用时 {time.time() - t1:.0f}s"
        )
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="裁剪/搬移 ESP-IDF 为随包载荷")
    ap.add_argument("--src", default=r"D:\esp", help="已安装的 ESP-IDF 根（含 frameworks/ 与 .espressif/）")
    ap.add_argument("--framework", default="", help="直接指定 ESP-IDF 源码目录（macOS/Linux 或手动 clone 时用）")
    ap.add_argument("--tools", default="", help="直接指定 IDF_TOOLS_PATH（默认 <src>\\.espressif；mac/linux 常为 ~/.espressif）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--targets", default="esp32s3", help="逗号分隔；含 esp32c3/c6/h2 时会带上 riscv32 工具链（+2.4 GB）")
    ap.add_argument("--with-base-python", action="store_true", default=True, help="连基础 Python 一起打包（默认开）")
    ap.add_argument("--no-base-python", dest="with_base_python", action="store_false")
    ap.add_argument("--no-gdb", action="store_true", help="不含 xtensa gdb（省 ~125 MB，调试用不到时）")
    ap.add_argument("--no-optional", action="store_true", help="不含 openocd / dfu-util")
    ap.add_argument("--no-docs", action="store_true", help="不含 IDF docs 与 examples（省 ~70 MB）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划与体积，不拷贝")
    ap.add_argument("--no-zip", action="store_true", help="只生成目录，不打成归档（调试用）")
    ap.add_argument("--zip-out", default="", help="归档输出路径（默认 <out>\\..\\esp-idf-payload.zip，即桌面端 resources\\ 下）")
    args = ap.parse_args(argv)

    plan = build_plan(args)
    print_plan(plan)
    if args.dry_run:
        print("\n[dry-run] 未拷贝任何文件。去掉 --dry-run 即开始暂存。")
        return 0
    return stage(plan, args)


if __name__ == "__main__":
    sys.exit(main())
