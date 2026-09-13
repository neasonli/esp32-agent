"""知识库后端选择（开源发布方案 A 的**可插拔边界**）。

背景（见 `docs/开源发布清单.md` §2）：
- 领域知识库（手册切片策略、向量库、检索、语料）是**闭源资产**，不进公开仓库；
- 公开仓只留本文件作为**唯一接缝** + 通用降级实现 `rag/stub.py`；
- 闭源实现以私有包分发（`pip install lcode-kb`，私有仓 `D:\\1_ai_project\\lcode-kb`）。

选择规则（环境变量 `LCODE_KB_BACKEND`）：

1. `private` → 必须用私有包，装不上直接抛错（授权客户/生产环境用，问题要早暴露）；
2. `stub`（旧值 `local` 兼容）→ 强制用仓库内降级实现（调试/离线/无知识库场景）；
3. 缺省 `auto` → 能 `import lcode_kb` 就用私有，否则降级 stub。

私有包契约（`lcode_kb`）：

    retrieve_docs(query: str, chip: str | None = None, top_k: int | None = None)
        -> list[Document]                    必须（page_content + metadata.source/chip）
    get_store() -> object                    可选（未提供则不做向量库句柄暴露）
    info() -> dict                           可选（{backend, version, store_dir, docs, ...}，健康检查用）
"""
import os
import sys
from pathlib import Path

# 先加载 .env / 设置 HF 镜像：两种后端都需要。
# （早期版本把 settings 放在降级分支里导入，导致走私有后端时 .env 完全没被加载。）
from config.settings import settings  # noqa: F401

# ── 组件载荷：知识库作为"单独下载安装"的组件（与 ESP-IDF 同一套机制）────────────
# 冻结后的内核**不能 pip install**（Python 运行时是 PyInstaller 打进包里的），所以私有知识库
# 只能以"目录"形式提供：桌面端把组件包解压到用户目录后，通过 LCODE_KB_PAYLOAD 告诉内核，
# 内核把 site-packages/（torch 等重依赖）与载荷根目录（lcode_kb 包本体）插到 sys.path 前面，
# 随后的 `import lcode_kb` 就能成功 —— PyInstaller 的冻结导入器只接管打包进去的模块，
# 磁盘上新增的模块走正常的 PathFinder ✓。
_payload = os.environ.get("LCODE_KB_PAYLOAD", "").strip()
if _payload:
    _root = Path(_payload)
    for _sub in ("site-packages", ""):
        _p = (_root / _sub) if _sub else _root
        if _p.is_dir() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))
    _store = _root / "data" / "rag_store"
    if _store.exists():
        os.environ.setdefault("LCODE_KB_STORE_DIR", str(_store))
    print(f"[rag] 已加载组件载荷: {_root}")

# 打包/冻结运行（PyInstaller）时，知识库向量随内核一起发：build_kernel.py 会把向量库放进
# <BASE_DIR>/data/rag_store；此处先于 `import lcode_kb` 把位置告诉私有包
# （私有包自身只在"私有仓目录 / ~/.lcode/kb_store"里找，不认识安装目录）。
# 开发模式该目录不存在 → 不设置 → 私有包仍按自己的顺序解析（私有仓 data/rag_store）。
_bundled_store = settings.data_dir / "rag_store"
if _bundled_store.exists():
    os.environ.setdefault("LCODE_KB_STORE_DIR", str(_bundled_store))

backend_name = "stub"
kb_available = False
_reason = ""

_retrieve = None
_get_store = None
_info = None

_REQUESTED = os.environ.get("LCODE_KB_BACKEND", "auto").strip().lower()

if _REQUESTED in ("auto", "private"):
    try:
        import lcode_kb  # type: ignore[import-not-found]  私有知识库包（闭源，单独安装）

        _retrieve = lcode_kb.retrieve_docs
        _get_store = getattr(lcode_kb, "get_store", None)
        _info = getattr(lcode_kb, "info", None)
        backend_name = "private"
        kb_available = True
    except Exception as exc:  # noqa: BLE001 — 缺省 auto 时降级；显式 private 时抛出
        if _REQUESTED == "private":
            raise RuntimeError(
                "LCODE_KB_BACKEND=private 但私有知识库包不可用（pip install lcode-kb 后重试）"
            ) from exc
        _reason = f"私有知识库包未安装（{type(exc).__name__}: {exc}）"

if _retrieve is None:
    # 通用降级实现：公开仓自带，零重依赖
    from rag.stub import get_store as _stub_get_store
    from rag.stub import info as _stub_info
    from rag.stub import retrieve_docs as _stub_retrieve

    _retrieve = _stub_retrieve
    _get_store = _stub_get_store
    _info = _stub_info
    backend_name = "stub"
    if not _reason:
        _reason = "LCODE_KB_BACKEND 指定使用通用模式（rag/stub.py）"

retrieve_docs = _retrieve
get_store = _get_store


def backend() -> str:
    """当前知识库后端名（'private' = 私有包接管 / 'stub' = 公开仓通用模式）。"""
    return backend_name


def available() -> bool:
    """是否具备领域知识库检索能力（stub 模式为 False）。"""
    return kb_available


def status() -> dict:
    """知识库状态（`/api/health` 用）：后端 / 是否可用 / 向量条数 / 说明。"""
    out: dict = {
        "kb_backend": backend_name,
        "kb_available": kb_available,
        "kb_docs": 0,
        "kb_note": _reason,
    }
    try:
        if _info is not None:
            data = _info() or {}
            out["kb_docs"] = int(data.get("docs", 0) or 0)
            if data.get("store_dir"):
                out["kb_store_dir"] = str(data["store_dir"])
            if data.get("version"):
                out["kb_version"] = str(data["version"])
            if data.get("reason") and not out["kb_note"]:
                out["kb_note"] = str(data["reason"])
    except Exception as exc:  # noqa: BLE001 — 健康检查不该因知识库问题失败
        out["kb_note"] = f"知识库状态读取失败：{exc}"
    return out


print(f"[rag] 知识库后端: {backend_name}（LCODE_KB_BACKEND={_REQUESTED}）")
if not kb_available and _reason:
    print(f"[rag] 提示: {_reason}")
