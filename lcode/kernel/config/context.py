"""对话上下文估算与预算（token 口径，与 DeepSeek Harness token-meter 启发式对齐）。

DSH 的做法（packages/llm/token-meter/src/estimate.ts）：
- 固定密度：每 4 字符 ≈ 1 token（CHARS_PER_TOKEN = 4）
- 每条消息/内容块加固定结构开销（4）
- 系统提示词、工具 schema 按同样密度单独计价

lcode 用它做两件事：
1. chat_agent._load_messages —— 用 token 预算截断历史（替代固定 60 条消息数，
   因为"条数"无法表达单条消息大小差异，固定条数可能仍超模型窗口）。
2. task_store.get_chat_session_detail —— 进度条估算与 _load_messages 同口径，
   避免"按 200 条估算 97% / 实际只发 60 条 31%"的虚高误导。
"""
from __future__ import annotations

import json
import math

from config.settings import settings

CHARS_PER_TOKEN = 4
MESSAGE_OVERHEAD = 4       # 每条消息的角色/JSON 结构开销
BLOCK_OVERHEAD = 4         # system / tools 信封块的结构开销

# 输出预留：chat_with_tools 的 max_tokens=4096；再加少量安全余量
OUTPUT_RESERVE_TOKENS = 4096
SAFETY_MARGIN_TOKENS = 1024

# 已知模型的上下文窗口（tokens）；未列出的回退 DEFAULT_WINDOW_TOKENS
# .env 的 LLM_CONTEXT_WINDOW 可显式覆盖任意模型
MODEL_WINDOW_TOKENS: dict[str, int] = {
    "deepseek-chat": 64_000,
    "deepseek-reasoner": 64_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4.1": 1_047_576,
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-haiku-20241022": 200_000,
    "qwen-plus": 131_072,
    "qwen-max": 32_768,
    "glm-4": 128_000,
    "llama3.1": 128_000,
    "llama3.2": 128_000,
}
DEFAULT_WINDOW_TOKENS = 64_000


def window_tokens(model: str | None = None) -> int:
    """模型上下文窗口（tokens）。.env 的 LLM_CONTEXT_WINDOW 显式覆盖优先。"""
    if settings.llm_context_window:
        return int(settings.llm_context_window)
    key = (model or settings.llm_model or "").lower()
    return MODEL_WINDOW_TOKENS.get(key, DEFAULT_WINDOW_TOKENS)


def estimate_text_tokens(text: str) -> int:
    """按固定密度估算一段文本（信封块用，含结构开销）。"""
    return math.ceil(len(text or "") / CHARS_PER_TOKEN) + BLOCK_OVERHEAD


def estimate_message_tokens(content: str) -> int:
    """按一条消息的存储内容估算 token（密度 + 消息级结构开销）。"""
    return math.ceil(len(content or "") / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD


def estimate_envelope_tokens(cwd: str, full_access: bool) -> int:
    """估算下一次请求的 system + tools 信封 token（与 chat_agent 实际构建同源）。

    惰性导入避免 config → agent/tools 的循环依赖；函数运行时模块均已加载。
    """
    from agent.chat_agent import _build_system  # noqa: PLC0415
    from tools.chat_tools import TOOL_DEFS  # noqa: PLC0415

    system = _build_system(cwd or "", full_access)
    tools = json.dumps(TOOL_DEFS, ensure_ascii=False)
    return estimate_text_tokens(system) + estimate_text_tokens(tools)


def history_budget_tokens(cwd: str, full_access: bool) -> int:
    """留给历史消息的 token 预算：窗口 - 信封(system+tools) - 输出预留 - 安全余量。"""
    window = window_tokens()
    envelope = estimate_envelope_tokens(cwd, full_access)
    return max(1_000, window - envelope - OUTPUT_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS)


def select_by_token_budget(rows: list[dict], max_tokens: int) -> tuple[list[dict], int]:
    """从旧→新的消息行中，按 token 预算从最新往回选取（至少保留最新 1 条）。

    - rows: get_chat_messages 的返回（id 升序，旧→新）
    - 返回 (picked, total_tokens)：picked 保持旧→新顺序

    配对保证：OpenAI 协议要求 assistant tool_calls 消息与其所有 tool 结果消息
    成对出现。从最新往回扫描时维护 need 集合（尚未匹配到 assistant 声明的
    tool_call_id），只要还有孤儿 tool 结果就继续往前取，确保边界不会
    切在"assistant tool_calls ↔ tool 结果"之间。
    """
    picked: list[dict] = []
    total = 0
    need: set[str] = set()
    for r in reversed(rows):
        role = r.get("role") or ""
        tool_name = r.get("tool_name") or ""
        content = r.get("content") or ""
        if role == "assistant" and tool_name == "__toolcalls__":
            try:
                ids = {tc.get("id") for tc in (json.loads(content).get("tool_calls") or [])}
            except Exception:  # noqa: BLE001 - 解析失败按无声明处理
                ids = set()
            need -= ids
        elif role == "tool":
            need.add(r.get("tool_call_id") or "")
        cost = estimate_message_tokens(content)
        # 预算已超且当前没有孤儿 tool 结果时停止；否则继续（保证配对完整）
        if picked and total + cost > max_tokens and not need:
            break
        total += cost
        picked.append(r)
    picked.reverse()
    return picked, total
