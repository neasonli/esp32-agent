"""把私有知识库打包成"可单独下载安装"的组件载荷（与 ESP-IDF 同一套机制）。

为什么知识库也要做成组件（而不是打进内核）：
1. 内核冻结产物**不能 pip install**；把 torch（1.1 GB）打进内核会让安装包 ~1 GB，
   而它只服务"手册检索"这一项能力；
2. 实测可行：冻结内核运行时把载荷目录插进 sys.path 即可 `import lcode_kb`
   （`--no-kb` 构建 + 外部载荷 → `kb_backend=private, kb_docs=634`）；
3. 知识库是闭源资产，做成独立组件也天然贴合"只发给授权用户"。

载荷结构（解压后，靠 manifest.json 标记）：
    manifest.json            版本/内容自述（桌面端据此识别）
    lcode_kb/                私有包源码（来自私有仓）
    site-packages/           运行依赖子集：torch / transformers / tokenizers / safetensors /
                             sentence_transformers / numpy / ...（**只收依赖，不收 pip/测试**）
    data/rag_store/          向量库（vectors.npy + meta.json）

用法：
    python tools/stage-kb-payload.py --dry-run          # 只看计划与体积
    python tools/stage-kb-payload.py                    # 生成目录 + kb-payload.zip
    python tools/stage-kb-payload.py --kb-src D:\\1_ai_project\\lcode-kb
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_KB_SRC = Path(r"D:\1_ai_project\lcode-kb")
DEFAULT_OUT = ROOT / "lcode" / "desktop" / "resources" / "kb"
# 运行必需的第三方包（按需增补；torch 是大头）
SITE_PACKAGES_WANTED = [
    "torch",
    "transformers",
    "tokenizers",
    "safetensors",
    "sentence_transformers",
    "numpy",
    "huggingface_hub",
    "scipy",
    "sklearn",
    "joblib",
    "threadpoolctl",
    "regex",
    "requests",
    "packaging",
    "filelock",
    "fsspec",
    "sympy",
    "networkx",
    "jinja2",
    "MarkupSafe",
    "typing_extensions",
    "tqdm",
    "pyyaml",
    "PIL",
    "safetensors",
    "yaml",
]
# 明确不要的大件/无关件
SITE_PACKAGES_SKIP = ["torchgen", "functorch", "torch.testing", "tests", "test"]


def dir_size(p: Path) -> int:
    return 0 if not p.exists() else sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def find_site_packages() -> Path:
    """用内核 venv 的 site-packages 作为依赖来源（与本机验证过的那套一致）。"""
    sp = ROOT / "lcode" / "kernel" / ".venv" / "Lib" / "site-packages"
    if not sp.exists():
        raise SystemExit(f"未找到内核 venv 的 site-packages：{sp}")
    return sp


def _resolve_entry(sp: Path, name: str):
    """解析一个依赖的落点：目录优先，其次**单文件模块**（`<name>.py`）。

    为什么必须认单文件：`typing_extensions` / `threadpoolctl` 在 site-packages 里就是
    `<name>.py` 一个文件。旧实现只 `sp / name` 判存在 → 这两个被静默判为"缺"，
    载荷里少 `typing_extensions.py` 会让 transformers / sentence_transformers 在**检索时**才炸
    （健康检查只看向量库 npy，察觉不到——实测踩过）。
    """
    p = sp / name
    if p.exists():
        return p, name
    single = sp / f"{name}.py"
    if single.exists():
        return single, single.name
    stub = sp / f"{name}.pyi"
    if stub.exists():
        return stub, stub.name
    return None, name


def plan(args) -> dict:
    kb_src = Path(args.kb_src)
    sp = find_site_packages()
    entries = []
    for name in dict.fromkeys(SITE_PACKAGES_WANTED):  # 去重保序
        p, rel = _resolve_entry(sp, name)
        if p is not None:
            entries.append({
                "name": name,
                "src": rel,
                "size": dir_size(p) if p.is_dir() else p.stat().st_size,
                "include": True,
            })
        else:
            entries.append({"name": name, "src": name, "size": 0, "include": False})
    store = kb_src / "data" / "rag_store"
    pkg = kb_src / "lcode_kb"
    if not pkg.exists():
        raise SystemExit(f"未找到私有包源码：{pkg}（用 --kb-src 指定私有仓）")

    # 卫星目录：`numpy.libs` / `scipy.libs` 这类**兄弟目录**里放的是原生 DLL，
    # 只按包名清单拷贝会整份漏掉。症状：numpy 一导入就
    # `ImportError: DLL load failed while importing _multiarray_umath`，
    # 在用户机上表现为"知识库检索直接崩"——而健康检查只数 npy 条数，察觉不到（实测踩过）。
    for e in list(entries):
        if not e["include"]:
            continue
        for suffix in (".libs", "_libs"):
            sat = sp / f"{e['name']}{suffix}"
            if sat.is_dir():
                entries.append({
                    "name": f"{e['name']}{suffix}",
                    "src": sat.name,
                    "size": dir_size(sat),
                    "include": True,
                })
    keep = sum(e["size"] for e in entries if e["include"]) + dir_size(pkg) + dir_size(store)
    return {
        "kb_src": str(kb_src),
        "site_packages": str(sp),
        "entries": entries,
        "pkg_size": dir_size(pkg),
        "store_size": dir_size(store),
        "keep": keep,
        "out": args.out,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="打包私有知识库组件载荷")
    ap.add_argument("--kb-src", default=str(DEFAULT_KB_SRC), help="私有仓路径（含 lcode_kb/ 与 data/rag_store/）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--no-zip", action="store_true", help="只生成目录，不打归档")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    pl = plan(args)
    mb = lambda n: n / 1024 / 1024  # noqa: E731
    print(f"私有仓    : {pl['kb_src']}")
    print(f"依赖来源  : {pl['site_packages']}")
    print("— 依赖 —")
    for e in pl["entries"]:
        tag = "收" if e["include"] else "缺"
        shown = e["name"] if e.get("src", e["name"]) == e["name"] else f"{e['name']}（{e['src']}）"
        print(f"  [{tag}] {shown:<26} {mb(e['size']):8.1f} MB")
    print(f"— 私有包 lcode_kb {mb(pl['pkg_size']):.1f} MB ；向量库 {mb(pl['store_size']):.1f} MB")
    print(f"预计载荷  : {mb(pl['keep']):.0f} MB  →  归档（deflate）约 {mb(pl['keep']) / 3.2:.0f} MB")
    if args.dry_run:
        print("\n[dry-run] 未拷贝任何文件。去掉 --dry-run 即开始生成。")
        return 0

    out = Path(pl["out"])
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    sp = Path(pl["site_packages"])
    t0 = time.time()
    print("[1/4] 拷贝私有包与向量库 ...")
    shutil.copytree(Path(pl["kb_src"]) / "lcode_kb", out / "lcode_kb", dirs_exist_ok=True)
    store_src = Path(pl["kb_src"]) / "data" / "rag_store"
    if store_src.exists():
        shutil.copytree(store_src, out / "data" / "rag_store", dirs_exist_ok=True)

    print("[2/4] 拷贝依赖（torch 较大）...")
    site = out / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    for e in pl["entries"]:
        if not e["include"]:
            continue
        src = sp / (e.get("src") or e["name"])
        dst_name = e.get("src") or e["name"]
        if src.is_dir():
            shutil.copytree(src, site / dst_name, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(src, site / dst_name)

    print("[3/4] 写 manifest ...")
    manifest = {
        "name": "kb",
        "version": "0.1.0",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "layout": {"package": "lcode_kb", "site_packages": "site-packages", "store": "data/rag_store"},
        "bytes": {"total": pl["keep"]},
        "note": "解压到 %APPDATA%\\LCode\\components\\kb 后，内核通过 LCODE_KB_PAYLOAD 加载",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if not args.no_zip:
        zip_path = out.parent / "kb-payload.zip"
        if zip_path.exists():
            zip_path.unlink()
        print(f"[4/4] 生成归档 {zip_path} ...")
        rc = subprocess.call(["tar", "-a", "-c", "-f", str(zip_path), "-C", str(out), "."])
        if rc != 0:
            print(f"[失败] tar exit={rc}")
            return 1
        print(f"[完成] {zip_path}  {zip_path.stat().st_size / 1024 / 1024:.0f} MB")
    total = dir_size(out)
    print(f"[完成] {out}  {mb(total):.0f} MB，用时 {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
