"""通用降级实现（公开仓自带）：不依赖 torch / 向量库 / 领域语料。

公开仓**不包含**领域知识库（切片策略、向量库、语料都是闭源资产），所以这里保证三件事：

1. 接口与私有实现完全一致（`retrieve_docs` / `get_store` / `info`）→ 业务代码零分支；
2. 不引入任何重依赖（torch、sentence-transformers、langchain-* 都不导入）→ 轻装内核就能跑；
3. 检索**返回空列表**并给出明确原因，让上层能提示"通用模式未启用手册检索"，
   而不是静默返回看起来像结果的噪声。

装上私有包（`pip install lcode-kb`）后，`rag/backend.py` 会自动改用私有实现，本文件不再参与。
"""
from pathlib import Path
from typing import Any

reason = "通用模式：未启用领域知识库（公开仓不含语料；安装私有包 lcode-kb 后由它接管）"


class NullStore:
    """空向量库：属性/方法与 numpy 实现对齐，`count` 恒为 0。"""

    def __init__(self, data_dir: Path | str | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else None

    @property
    def count(self) -> int:
        return 0

    def load(self) -> None:
        return None

    def save(self) -> None:
        return None

    def build(self, vectors: list, texts: list[str], metadatas: list[dict]) -> int:
        raise RuntimeError(
            "公开仓的通用模式不能建库：建库/向量化属私有知识库能力（pip install lcode-kb）"
        )

    def query(self, query_vec: list[float], top_k: int = 5, chip: str | None = None) -> list[dict]:
        return []


_store: NullStore | None = None


def get_store() -> NullStore:
    global _store
    if _store is None:
        _store = NullStore()
    return _store


def retrieve_docs(query: str, chip: str | None = None, top_k: int | None = None) -> list[Any]:
    """通用模式：没有语料可检索，返回空列表（调用方据此走"无手册资料"分支）。"""
    return []


def info() -> dict:
    return {
        "backend": "stub",
        "version": "-",
        "store_dir": "",
        "docs": 0,
        "reason": reason,
    }
