"""Agent 全局状态定义（与文档 4.1 一致）。"""
from enum import Enum

from pydantic import BaseModel, Field


class ErrorType(str, Enum):
    """编译错误分类。"""
    NONE = "无错误"
    SYNTAX = "语法错误"
    UNDEFINED = "未定义标识符"
    PIN_CONFLICT = "引脚/外设冲突"
    TYPE_MISMATCH = "类型不匹配"
    ENV = "环境临时错误"
    UNKNOWN = "未知错误"


class AgentState(BaseModel):
    """所有节点共享、读写统一状态。"""
    task_id: str = ""                # 任务ID（与 SQLite 任务表关联）
    user_requirement: str = ""       # 用户原始需求
    workspace_id: str = ""           # 阶段2 W2：工作区ID（迭代已有工程时非空）
    chip_model: str = ""             # 最终选型芯片型号
    chip_datasheet_info: str = ""    # RAG检索到的芯片关键资料
    firmware_code: str = ""          # 生成的完整固件代码（main.c）
    project_dir: str = ""            # 生成的 ESP-IDF 工程目录（多文件）
    compile_log: str = ""            # 原始编译日志
    compile_error_type: ErrorType = ErrorType.NONE  # 错误分类
    compile_success: bool = False    # 编译是否成功
    retry_times: int = 0             # 修复重试次数（防死循环）
    env_retry_times: int = 0         # 环境类错误连续重试次数
    fix_history: list[str] = Field(default_factory=list)  # 已尝试修复记录
    last_error: str = ""             # 最近一次错误摘要
    final_result: str = ""           # 最终输出结果
