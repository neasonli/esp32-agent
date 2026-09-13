"""芯片选型节点：首批支持 ESP32-S3。

策略：需求关键词匹配优先（确定性），否则 LLM 从支持列表选择（兜底默认 esp32s3）。
后续扩展芯片：在 SUPPORTED_CHIPS 中加条目 + templates 中加工程模板即可。
"""
import json

from agent.state import AgentState
from config.llm_config import adapter
from config.settings import settings

# 首批支持芯片库（与 templates/ 目录一一对应）
SUPPORTED_CHIPS = [
    {
        "model": "esp32s3",
        "name": "ESP32-S3",
        "arch": "Xtensa LX7 双核 240MHz",
        "toolchain": "esp-idf v5.x (xtensa-esp32-elf-gcc)",
        "board": "ESP32-S3-DevKitC-1 / 合宙 ESP32-S3 (WROOM-1)",
    },
]

# 需求关键词 → 芯片型号
_KEYWORD_MAP = [
    (["esp32-s3", "esp32s3", "esp32 s3", "esp32"], "esp32s3"),
]


def _match_by_keyword(requirement: str) -> str | None:
    lower = requirement.lower()
    for keywords, chip in _KEYWORD_MAP:
        if any(k in lower for k in keywords):
            return chip
    return None


def _llm_select(requirement: str) -> str:
    """LLM 从支持列表选型；解析失败兜底默认芯片。"""
    candidates = ", ".join(f"{c['model']}({c['name']})" for c in SUPPORTED_CHIPS)
    prompt = (
        "你是嵌入式硬件选型工程师。请从支持列表中选择最匹配用户需求的一款芯片，"
        f"只输出 JSON：{{\"chip\": \"芯片model\"}}。\n"
        f"支持列表: {candidates}\n用户需求: {requirement}"
    )
    try:
        text = adapter.chat("只输出 JSON。", prompt, temperature=0.0)
        chip = json.loads(text).get("chip", "").strip().lower()
        if any(c["model"] == chip for c in SUPPORTED_CHIPS):
            return chip
    except Exception:
        pass
    return SUPPORTED_CHIPS[0]["model"]


def node_chip_select(state: AgentState) -> dict:
    """输入用户需求，输出确定唯一芯片型号。"""
    requirement = state.user_requirement or ""
    chip = _match_by_keyword(requirement) or _llm_select(requirement)
    return {"chip_model": chip}
