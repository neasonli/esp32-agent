"""固件代码生成节点：从模板复制 ESP-IDF 工程，LLM 生成 main.c 并落盘。

输出契约为多文件工程（文档 5.6）：
outputs/根下（--outputs 指定目录）: CMakeLists.txt, sdkconfig.defaults, main/CMakeLists.txt, main/main.c, README.md
修复轮幂等：state 已有 firmware_code 时直接落盘，跳过重新生成。
"""
import shutil
from pathlib import Path

from agent.state import AgentState
from config.llm_config import adapter, build_prompt
from config.settings import settings
from db import task_store

TEMPLATE_NAME = "esp32s3_basic"


def _emit(state: AgentState, level: str, message: str, node: str = "") -> None:
    if state.task_id:
        task_store.add_event(state.task_id, level, message, node)


def node_code_generate(state: AgentState) -> dict:
    """输入 用户需求 + 芯片硬件资料，输出完整固件工程（多文件）。

    工作区迭代（D11）：state.workspace_id 非空时复用该工作区工程目录，
    在其上增量修改/优化；否则新建 outputs/{task_id} 工程。
    """
    task_id = state.task_id or "default"

    # 工作区模式：复用已有工程目录（不复制模板）
    if state.workspace_id:
        ws = task_store.get_workspace(state.workspace_id)
        if not ws:
            raise FileNotFoundError(f"工作区不存在: {state.workspace_id}")
        proj_dir = Path(ws["project_dir"])
        _emit(state, "INFO", f"工作区迭代：复用工程 {proj_dir.name}/", node="code_generate")
    else:
        # 工程直接生成在 outputs_dir 根下（不再套一层 task_id 子目录）
        proj_dir = settings.outputs_dir
        proj_dir.mkdir(parents=True, exist_ok=True)

    # 以 CMakeLists.txt 是否已存在判断是否需要复制模板
    # （outputs_dir 本身一定存在，不能用 proj_dir.exists() 判断）
    if not (proj_dir / "CMakeLists.txt").exists():
        template_dir = settings.templates_dir / TEMPLATE_NAME
        if not template_dir.exists():
            raise FileNotFoundError(f"工程模板不存在: {template_dir}")
        shutil.copytree(template_dir, proj_dir, dirs_exist_ok=True)
        _emit(state, "INFO", f"复制工程模板 → {proj_dir.name}/", node="code_generate")
    elif not state.workspace_id:
        _emit(state, "INFO", f"复用已有工程目录 {proj_dir.name}/", node="code_generate")

    if state.firmware_code:
        # 修复轮：使用 error_fix 生成的修复代码
        main_c = state.firmware_code
        _emit(state, "INFO", "使用修复后的代码覆盖 main.c", node="code_generate")
    else:
        # 首次生成：LLM 生成 main.c
        prompt = build_prompt(state.user_requirement, state.chip_datasheet_info)
        prompt += f"\n目标芯片: {state.chip_model}\n开发板: ESP32-S3-DevKitC-1（WROOM-1 模组）\n"
        _emit(state, "INFO", "LLM 生成固件代码中…", node="code_generate")
        main_c = adapter.chat("你是资深嵌入式固件工程师，只输出可编译的 C 代码。", prompt)
        _emit(state, "INFO", f"LLM 代码生成完成（{len(main_c)} 字符）", node="code_generate")

    (proj_dir / "main" / "main.c").write_text(main_c, encoding="utf-8")
    _emit(state, "INFO", "已写入 main/main.c", node="code_generate")

    # 工程说明
    readme = (
        f"# {state.chip_model} 固件工程（Agent 自动生成）\n\n"
        f"用户需求: {state.user_requirement}\n\n"
        "编译: idf.py -B build build\n"
        "烧录: idf.py -B build flash monitor（需连接开发板）\n"
    )
    (proj_dir / "README.md").write_text(readme, encoding="utf-8")
    _emit(state, "INFO", "已写入 README.md", node="code_generate")

    return {"firmware_code": main_c, "project_dir": str(proj_dir)}
