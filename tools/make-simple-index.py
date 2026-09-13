"""把一个目录里的 wheel/sdist 变成一个 **PEP 503 静态 simple index**（零依赖、零进程）。

用途：给闭源包/私有包一个"不依赖任何托管服务"的私有源 —— 生成出来的一棵静态目录树可以直接
放到 nginx / S3 / Cloudflare Pages / 内网共享盘，也可以临时用 `python -m http.server` 起一个。
比 pypiserver 轻（不需要常驻进程），比 GitHub Packages 现实（后者**没有** Python registry）。

用法：
    python tools/make-simple-index.py --dist D:\\1_ai_project\\lcode-kb\\dist --out D:\\kb-index
    # 然后（用户侧）：
    pip install --index-url http://<host>/simple --trusted-host <host> lcode-kb

产物结构（PEP 503 规范）：
    <out>/simple/index.html              包名索引（链接到各包页）
    <out>/simple/<规范化包名>/index.html  该包的所有版本文件（含 sha256 片段）
    <out>/packages/<file>                原始 wheel/sdist
"""
from __future__ import annotations

import argparse
import hashlib
import html
import re
import shutil
import sys
from pathlib import Path

# PEP 503 规范化：小写 + 把连续的 -_. 折成单个 -
_NORM = re.compile(r"[-_.]+")


def normalize(name: str) -> str:
    return _NORM.sub("-", name).lower()


def wheel_name_parts(filename: str) -> tuple[str, str] | None:
    """从 wheel 文件名解析 (包名, 版本)。wheel 规范：{name}-{ver}(-{build})?-{py}-{abi}-{plat}.whl"""
    if not filename.endswith(".whl"):
        return None
    stem = filename[:-4]
    parts = stem.split("-")
    if len(parts) < 5:
        return None
    return parts[0], parts[1]


def sdist_name_parts(filename: str) -> tuple[str, str] | None:
    """从 sdist 文件名解析 (包名, 版本)：{name}-{ver}.tar.gz / .zip"""
    for suffix in (".tar.gz", ".zip"):
        if filename.endswith(suffix):
            stem = filename[: -len(suffix)]
            if "-" not in stem:
                return None
            name, _, ver = stem.rpartition("-")
            return name, ver
    return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成 PEP 503 静态 simple index")
    ap.add_argument("--dist", required=True, help="含 *.whl / *.tar.gz 的目录")
    ap.add_argument("--out", required=True, help="输出根目录（会被重建）")
    ap.add_argument("--base-url", default="", help="文件链接前缀（默认相对路径 ../../packages/）")
    ap.add_argument("--title", default="LCode private index", help="index 页标题")
    args = ap.parse_args(argv)

    dist = Path(args.dist)
    out = Path(args.out)
    if not dist.is_dir():
        print(f"[fail] dist 目录不存在: {dist}")
        return 2
    artifacts = sorted([p for p in dist.iterdir() if p.suffix in (".whl", ".gz", ".zip")])
    if not artifacts:
        print(f"[fail] {dist} 里没有 wheel/sdist")
        return 2

    if out.exists():
        shutil.rmtree(out)
    (out / "simple").mkdir(parents=True)
    (out / "packages").mkdir(parents=True)

    # 包名 -> [(文件名, sha256)]
    packages: dict[str, list[tuple[str, str]]] = {}
    for src in artifacts:
        parsed = wheel_name_parts(src.name) or sdist_name_parts(src.name)
        if parsed is None:
            print(f"  [skip] 无法解析文件名: {src.name}")
            continue
        name, ver = parsed
        key = normalize(name)
        digest = sha256_of(src)
        shutil.copy2(src, out / "packages" / src.name)
        packages.setdefault(key, []).append((src.name, digest))
        print(f"  [add] {key} {ver}  {src.name}  ({src.stat().st_size / 1024:.1f} KB) sha256={digest[:16]}...")

    prefix = args.base_url or "../../packages/"
    rows = []
    for key in sorted(packages):
        links = "\n".join(
            f'    <a href="{html.escape(prefix + fn)}#sha256={digest}">{html.escape(fn)}</a><br/>'
            for fn, digest in sorted(packages[key])
        )
        page = out / "simple" / key / "index.html"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(
            f"<!DOCTYPE html>\n<html><head><title>{html.escape(key)}</title></head>\n<body>\n"
            f"<h1>{html.escape(key)}</h1>\n{links}\n</body></html>\n",
            encoding="utf-8",
        )
        rows.append(f'  <a href="{html.escape(key)}/">{html.escape(key)}</a><br/>')
        print(f"  [page] simple/{key}/index.html  ({len(packages[key])} 个文件)")

    (out / "simple" / "index.html").write_text(
        f"<!DOCTYPE html>\n<html><head><title>{html.escape(args.title)}</title></head>\n<body>\n"
        f"<h1>{html.escape(args.title)}</h1>\n" + "\n".join(rows) + "\n</body></html>\n",
        encoding="utf-8",
    )

    print()
    print(f"[done] 静态 index 就绪: {out}")
    print(f"       包数 = {len(packages)}，文件数 = {sum(len(v) for v in packages.values())}")
    print("       用户侧安装（替换 <host>:<port> 与包名）：")
    print("         pip install --index-url http://<host>:<port>/simple --trusted-host <host> <pkg>")
    print("       临时起服务：")
    print(f"         python -m http.server <port> --directory \"{out}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
