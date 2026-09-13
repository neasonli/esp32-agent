"""rag 包（公开仓侧：只有接缝 + 通用降级实现）。

对外只暴露「后端无关」的入口：

    from rag import retrieve_docs        # 业务代码统一走这里
    from rag import status, available    # 能力探测（桌面端/健康检查）

两种后端（选择规则见 `rag/backend.py`）：

| 后端 | 实现 | 何时使用 |
|---|---|---|
| `private` | 私有包 `lcode_kb`（闭源，`pip install lcode-kb`） | 有领域知识库（手册/向量/检索）时 |
| `stub`    | 本仓 `rag/stub.py`：零重依赖，检索返回空 | 公开仓默认（通用模式） |

⚠️ 公开仓**不含** `retriever.py` / `vector_store.py` / `load_docs.py`：切片策略、向量库实现、
语料与向量数据都是闭源资产，已迁到私有仓 `lcode-kb`。业务代码请勿 import 具体实现模块，
否则私有后端无法接管。
"""
from rag.backend import available, backend, backend_name, get_store, retrieve_docs, status

__all__ = ["retrieve_docs", "get_store", "backend", "backend_name", "available", "status"]
