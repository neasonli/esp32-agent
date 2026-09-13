"""编译执行节点：调用 ESP-IDF 交叉编译（包装 idf.py build）。

阶段2 W2：通过 on_progress 回调产生 L4 进度事件（CMake 配置/编译组件/生成二进制/产物清单）。
"""
from agent.state import AgentState
from db import task_store
from tools.compile_tool import compile_project


def _make_progress_emitter(task_id: str):
    def emit(line: str, phase: str) -> None:
        if phase.startswith("产物"):
            task_store.add_event(task_id, "INFO", phase, node="compile_build")
        elif phase:
            task_store.add_event(task_id, "INFO", f"编译阶段：{phase}", node="compile_build")

    return emit


def node_compile_build(state: AgentState) -> dict:
    """输入固件工程目录，输出原始编译日志 + 编译成败。"""
    if not state.project_dir:
        return {
            "compile_log": "[环境错误] 工程目录为空，无法编译",
            "compile_success": False,
        }
    task_id = state.task_id
    emitter = _make_progress_emitter(task_id) if task_id else None
    if task_id:
        task_store.add_event(task_id, "INFO", "启动 idf.py build（首次约 1~4 分钟）", node="compile_build")
    log, ok = compile_project(state.project_dir, on_progress=emitter)
    if task_id:
        task_store.add_event(
            task_id,
            "INFO" if ok else "ERROR",
            "编译完成，产物已就绪" if ok else "编译失败，进入错误修复",
            node="compile_build",
        )
    return {"compile_log": log, "compile_success": ok}
