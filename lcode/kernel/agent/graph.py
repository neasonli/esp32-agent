"""LangGraph 状态机：节点注册、条件分支路由、节点事件包装（阶段2 W2）。

流程：
chip_select → rag_search → code_generate → compile_build
├─ 成功 → END
└─ 失败 → error_fix（分类+修复）→ code_generate（落盘）→ compile_build
   - 环境错误：不经过 error_fix，直接重试 compile_build（不消耗修复计数）
   - 引脚冲突：回 rag_search 重新核对硬件参数

W2 新增：
- L2 节点事件（进入/离开 + 耗时）自动落 events 表
- 取消检查：每个节点执行前检查 cancel 标志，取消则抛 CancelledError 终止
- checkpointer：启用 langgraph-checkpoint-sqlite，实现节点级断点续跑（D9）
"""
import time

from langgraph.graph import END, StateGraph

from agent.nodes.chip_select import node_chip_select
from agent.nodes.code_generate import node_code_generate
from agent.nodes.compile_build import node_compile_build
from agent.nodes.error_fix import node_error_fix
from agent.nodes.rag_search import node_rag_search
from agent.state import AgentState, ErrorType
from config.llm_config import clear_usage_context, set_usage_context
from config.settings import settings
from db import task_store


class CancelledError(Exception):
    """任务被用户取消。"""


def _emit(state: AgentState, level: str, message: str, node: str = "") -> None:
    task_id = state.task_id if isinstance(state, AgentState) else state.get("task_id", "")
    if task_id:
        task_store.add_event(task_id, level, message, node)


def check_cancel(state: AgentState) -> None:
    """执行前检查取消标志；已取消则终止。"""
    task_id = state.task_id if isinstance(state, AgentState) else state.get("task_id", "")
    if task_id and task_store.is_cancel_requested(task_id):
        _emit(state, "WARN", "任务已被用户取消，停止执行", node="agent")
        raise CancelledError("任务已取消")


def with_node_events(node_name: str, func):
    """节点包装器：进入/离开事件 + 耗时 + usage 上下文 + 取消检查。"""

    def wrapped(state: AgentState) -> dict:
        task_id = state.task_id if isinstance(state, AgentState) else state.get("task_id", "")
        check_cancel(state)
        set_usage_context(task_id or "", node_name)
        start = time.time()
        _emit(state, "NODE", f"进入节点 {node_name}", node=node_name)
        try:
            result = func(state)
            # 节点结束后再检查一次取消（编译等长节点期间被取消时及时生效）
            check_cancel(state)
            # 节点返回 dict 可能不含 task_id，事件归属用 state.task_id
            _emit(state, "NODE", f"节点 {node_name} 完成（{time.time() - start:.1f}s）", node=node_name)
            return result
        except CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            _emit(state, "ERROR", f"节点 {node_name} 异常：{e}", node=node_name)
            raise
        finally:
            clear_usage_context()

    return wrapped


def route_after_compile(state: AgentState) -> str:
    """编译后条件路由。"""
    if state.compile_success:
        return "success"
    if state.retry_times >= settings.max_retry:
        return "giveup"
    if state.compile_error_type == ErrorType.ENV:
        if state.env_retry_times >= settings.env_retry_max:
            return "giveup"
        return "retry_compile"
    if state.compile_error_type == ErrorType.PIN_CONFLICT:
        return "back_rag"
    # 语法错误 / 未定义标识符 / 类型不匹配 / 未知错误 → 修复后回代码生成
    return "fix"


def _make_checkpointer():
    """构建 SQLite checkpointer（同一 db 文件，但使用独立连接）。

    不能与 task_store 共用连接：LangGraph 的事务管理与我们的事件写入
    在同一连接上会互相冲突（"cannot start a transaction within a transaction"）。
    """
    import sqlite3

    from langgraph.checkpoint.sqlite import SqliteSaver

    conn = sqlite3.connect(str(settings.db_path), check_same_thread=False)
    conn.execute("PRAGMA busy_timeout=5000")
    return SqliteSaver(conn)


def build_graph(checkpointer=None, with_events: bool = True):
    """构建并编译状态机。

    checkpointer: 传入则启用断点（W2 起默认启用）；with_events=False 用于单元测试。
    """
    g = StateGraph(AgentState)

    if with_events:
        g.add_node("chip_select", with_node_events("chip_select", node_chip_select))
        g.add_node("rag_search", with_node_events("rag_search", node_rag_search))
        g.add_node("code_generate", with_node_events("code_generate", node_code_generate))
        g.add_node("compile_build", with_node_events("compile_build", node_compile_build))
        g.add_node("error_fix", with_node_events("error_fix", node_error_fix))
    else:
        g.add_node("chip_select", node_chip_select)
        g.add_node("rag_search", node_rag_search)
        g.add_node("code_generate", node_code_generate)
        g.add_node("compile_build", node_compile_build)
        g.add_node("error_fix", node_error_fix)

    g.set_entry_point("chip_select")
    g.add_edge("chip_select", "rag_search")
    g.add_edge("rag_search", "code_generate")
    g.add_edge("code_generate", "compile_build")

    g.add_conditional_edges(
        "compile_build",
        route_after_compile,
        {
            "success": END,
            "giveup": END,
            "retry_compile": "compile_build",
            "back_rag": "rag_search",
            "fix": "error_fix",
        },
    )
    g.add_edge("error_fix", "code_generate")

    if checkpointer is None and settings.kernel_mode:
        try:
            checkpointer = _make_checkpointer()
        except Exception:  # noqa: BLE001 - checkpointer 异常不阻断启动
            print("[graph] checkpointer 初始化失败，断点续跑不可用")
            checkpointer = None

    return g.compile(checkpointer=checkpointer)
