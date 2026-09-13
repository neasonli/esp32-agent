"""错误修复节点：分类编译错误，LLM 针对性生成修复后的代码。

计数规则（文档 4.5）：仅修复类循环消耗 retry_times；
环境类错误不经过本节点（compile_build 直接重试）。
"""
from agent.state import AgentState
from config.llm_config import adapter
from tools.error_parse import classify_error


def node_error_fix(state: AgentState) -> dict:
    """输入 编译日志，输出修复后的新固件代码 + 错误分类。"""
    err = classify_error(state.compile_log)

    history = "\n".join(f"- {h}" for h in state.fix_history) or "（无）"
    prompt = (
        "你是资深嵌入式固件工程师。以下 C 代码编译失败，请修复后只输出完整的、可编译的 main.c 代码"
        "（包含所有头文件与 app_main），不要解释。\n\n"
        f"【错误类型】{err.type.value}\n"
        f"【错误信息】{err.message}\n"
        f"【原始代码】\n{state.firmware_code}\n\n"
        f"【已尝试过的修复（避免重复）】\n{history}"
    )
    try:
        fixed = adapter.chat(
            "只输出修复后的完整 C 代码，不要 markdown 代码块标记，不要解释。", prompt
        )
    except Exception as e:
        raise RuntimeError(f"LLM 修复失败: {e}") from e

    return {
        "firmware_code": fixed,
        "compile_error_type": err.type,
        "retry_times": state.retry_times + 1,
        "env_retry_times": 0,  # 修复轮重置环境重试计数
        "fix_history": [*state.fix_history, f"[{err.type.value}] {err.message[:120]}"],
        "last_error": err.message,
    }
