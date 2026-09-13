"""独立复核对公开导出目录做深度审计（第二双眼睛，实现与 make-public-export.ps1 不同）。

为什么还要一个 Python 版：PowerShell 那份是"白名单 + 关键字"扫描，且它自己负责拷贝，
**同一个脚本既搬运又自检**。这里只读、只审，用不同的检测手段覆盖四类风险：
  1. 密钥/凭据：私钥块、各类 token 形态、凭据文件名
  2. 闭源资产：向量库、厂商 PDF/原理图、知识库实现、授权服务端、第三方应用解包
  3. PII/机器指纹：本机绝对路径、邮箱、收款码图片
  4. 不该进仓的构建产物：exe/dll/zip/whl/node_modules/venv/大文件

用法：python tools/audit-public-export.py [目录]
     默认目录 = 仓库同级目录 <repo parent>\lcode-public-export（可用参数覆盖）
硬命中 → exit 1；仅提示（如本机路径）→ exit 0 但列出数量。
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

# 默认导出目录 = 本仓的同级目录（不硬编码任何机器路径）
_REPO = Path(__file__).resolve().parent.parent
DEFAULT = _REPO.parent / "lcode-public-export"
GIT_DIR = ".git"

# 硬命中：出现即拒绝发布
HARD_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("私钥块", re.compile(r"BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY")),
    # 只认"像真 Key"的形态：占位符（boot-gate-placeholder / your-key-here / sk-xxxx）不算。
    # 一条故意留的 sk-... 占位符会被 GitHub 的 secret scanning / push protection 误报（实测踩过）。
    ("疑似真实 API Key", re.compile(r"\bsk-(?!boot-gate|placeholder|your|xxx|TEST|test)[A-Za-z0-9]{24,}\b")),
    ("GitHub token", re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}")),
]
# 这些是"文件名/目录名"级别的硬命中（真正的闭源件本体，而不是文档里提到它）
HARD_NAMES = re.compile(
    r"^(\.env|\.env\.(?!example$).+|\.credentials\.yaml|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.pfx|"
    r".*\.p12|license_ed25519\.pem|meta\.json|vectors\.npy)$",
    re.IGNORECASE,
)
HARD_SUFFIX = {".exe", ".dll", ".node", ".whl", ".zip", ".7z", ".npy", ".pdf", ".dwg"}
HARD_DIRS = {"node_modules", ".venv", "venv", "__pycache__", "_internal", "rag_store", "ui-ref"}
# 收款码/二维码：只有**图片文件**才算泄漏（代码与文档里出现这个词是功能命名，不是资产）
QR_NAME = re.compile(r"收款码|shoukuanma|qrcode|pay_?code", re.IGNORECASE)
IMAGE_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"}

# 仅提示：本机路径/邮箱（不阻断，但要在发布前确认是否有意保留）
SOFT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("本机绝对路径 D:\\1_ai_project", re.compile(r"D:\\\\1_ai_project|D:\\1_ai_project")),
    ("本机用户目录 C:\\Users\\", re.compile(r"C:\\\\Users\\\\|C:\\Users\\")),
    ("邮箱地址", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    ("提到闭源件名词（文档/脚本引用，非本体）", re.compile(r"vectors\.npy|rag_store|lcode_kb|lcode-kb")),
]
TEXT_EXT = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml",
            ".ps1", ".bat", ".c", ".h", ".cmake", ".in", ".html", ".css", ".example", ".cfg", ".toml"}
MAX_SCAN_BYTES = 4 * 1024 * 1024


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else DEFAULT
    if not root.is_dir():
        print(f"[fail] 目录不存在: {root}")
        return 2

    hard: list[str] = []
    soft: dict[str, list[str]] = {name: [] for name, _ in SOFT_PATTERNS}
    files = 0
    total = 0
    biggest: list[tuple[int, str]] = []

    for p in root.rglob("*"):
        rel = p.relative_to(root).as_posix()
        if rel == GIT_DIR or rel.startswith(GIT_DIR + "/"):
            continue  # 导出目录自己的 git 元数据不属于发布内容
        if p.is_symlink():
            hard.append(f"符号链接（可能是本机路径泄漏）: {rel}")
            continue
        if p.is_dir():
            if p.name in HARD_DIRS:
                hard.append(f"不该进仓的目录: {rel}")
            continue
        files += 1
        size = p.stat().st_size
        total += size
        biggest.append((size, rel))
        if HARD_NAMES.match(p.name):
            hard.append(f"敏感文件名: {rel}")
        if p.suffix.lower() in IMAGE_SUFFIX and QR_NAME.search(p.name):
            hard.append(f"收款码/二维码图片: {rel}")
        if p.suffix.lower() in HARD_SUFFIX:
            hard.append(f"不该进仓的二进制/归档: {rel}")
        if size > 20 * 1024 * 1024:
            hard.append(f"超大文件(>20MB): {rel} ({size / 1024 / 1024:.1f} MB)")
        if p.suffix.lower() in TEXT_EXT and size <= MAX_SCAN_BYTES:
            try:
                text = io.open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for name, pat in HARD_PATTERNS:
                for m in pat.finditer(text):
                    snippet = m.group(0)[:24]
                    hard.append(f"{name}: {rel} -> {snippet}...")
            for name, pat in SOFT_PATTERNS:
                n = len(pat.findall(text))
                if n:
                    soft[name].append(f"{rel} ({n})")

    print(f"审计目录 : {root}")
    print(f"文件数   : {files}   合计 {total / 1024 / 1024:.2f} MB")
    print()
    print("== 硬命中（出现即拒绝发布）==")
    if hard:
        for h in sorted(set(hard)):
            print("  [X] " + h)
    else:
        print("  无")
    print()
    print("== 提示项（需人工确认是否有意保留）==")
    for name, hits in soft.items():
        print(f"  {name}: {len(hits)} 个文件")
        for h in hits[:5]:
            print("      - " + h)
        if len(hits) > 5:
            print(f"      ... 其余 {len(hits) - 5} 个省略")
    print()
    print("== 最大的 5 个文件 ==")
    for size, rel in sorted(biggest, reverse=True)[:5]:
        print(f"  {size / 1024:9.1f} KB  {rel}")

    if hard:
        print("\nVERDICT: FAIL（有硬命中，不要推送）")
        return 1
    print("\nVERDICT: PASS（无硬命中；提示项请人工确认）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
