"""核心逻辑冒烟测试（无需重型依赖，仅 pydantic/pydantic-settings）。

运行:
    python tests/smoke_core.py
覆盖: settings 加载 / AgentState / SQLite 任务存储 / 编译错误分类规则。
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from config.settings import settings  # noqa: E402
from agent.state import AgentState, ErrorType  # noqa: E402
from db.task_store import (  # noqa: E402
    STATUS_RUNNING,
    create_task,
    get_task,
    recover_running_tasks,
    update_task,
)
from tools.error_parse import classify_error  # noqa: E402


def test_settings() -> None:
    assert settings.embedding_model == "BAAI/bge-small-zh-v1.5"
    assert settings.idf_target == "esp32s3"
    assert settings.max_retry == 5
    print("settings OK")


def test_state() -> None:
    s = AgentState(task_id="t1", user_requirement="test")
    assert s.chip_model == ""
    assert s.compile_error_type == ErrorType.NONE
    print("state OK")


def test_task_store() -> None:
    tid = create_task("实现 ESP32-S3 LED 闪烁")
    update_task(tid, status=STATUS_RUNNING)
    update_task(tid, status="SUCCESS", chip_model="esp32s3", project_dir="outputs/x", result_json="{}")
    t = get_task(tid)
    assert t and t["status"] == "SUCCESS" and t["chip_model"] == "esp32s3"
    assert get_task("not-exist") is None
    recover_running_tasks()
    print("task_store OK")


def test_error_parse() -> None:
    cases = [
        ("main.c:12:5: error: expected ';' before '}'", ErrorType.SYNTAX),
        ("main.c:34:9: error: implicit declaration of function 'foo'", ErrorType.UNDEFINED),
        ("ninja: error: loading build.ninja: No such file or directory", ErrorType.ENV),
        ("main.c:50:7: error: incompatible types when assigning to type 'int' from type 'char *'", ErrorType.TYPE_MISMATCH),
        ("error: 'GPIO_NUM_5' undeclared (first use in this function)", ErrorType.UNDEFINED),
    ]
    for log, expect in cases:
        got = classify_error(log).type
        assert got == expect, f"{log!r}: expect {expect}, got {got}"
    print("error_parse OK (5 类规则全命中)")


if __name__ == "__main__":
    test_settings()
    test_state()
    test_task_store()
    test_error_parse()
    print("ALL_CORE_TESTS_PASSED")
