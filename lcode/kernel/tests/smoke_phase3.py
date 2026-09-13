"""阶段3 Phase3 冒烟测试：底座工具集（file_tree/glob/grep）、run_check TS 校验器、
工作区 git 化 + 会话 checkpoint（agent核心开发文档 §8 Phase 3）。

运行:
    python tests/smoke_phase3.py
前置: 无需 ESP-IDF；TS 校验器解析测试不依赖真实 tsc（纯日志解析）。
覆盖:
  1) 底座工具集：edit_file exact-match 三分支 + file_tree/glob/grep（临时目录）
  2) run_check：工程类型探测（esp-idf/ts/未知）+ tsc 日志 → CodeDiagnostic（两种格式）
  3) git_safe：eligible 判定 / 会话 git 化 / checkpoint（无变更不提交）/ 回滚到上一 checkpoint
"""
import shutil
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from tools.base_tools import (  # noqa: E402
    detect_project_type,
    parse_diagnostics,
    parse_ts_diagnostics,
    tool_edit_file,
    tool_file_tree,
    tool_glob,
    tool_grep,
)
from tools.git_safe import (  # noqa: E402
    checkpoint,
    ensure_workspace_git,
    find_repo_root,
    rollback,
    rollback_session,
    snapshot_session,
    workspace_git_eligible,
)
from tools.chat_tools import ToolContext  # noqa: E402


class CaptureCtx(ToolContext):
    """测试用 ctx：捕获 emit 事件（不写 DB）。"""

    def __init__(self, cwd: str):
        super().__init__(cwd, task_id="")
        self.events: list[tuple] = []

    def emit(self, level, message, node="", event_type="", payload=None) -> None:
        self.events.append((level, message, node, event_type, payload))


def _make_tree(root: Path) -> None:
    (root / "src").mkdir(parents=True)
    (root / "main").mkdir()
    (root / "src" / "app.c").write_text("void app_main(void) { printf(\"hi\"); }\n", encoding="utf-8")
    (root / "main" / "CMakeLists.txt").write_text("idf_component_register(...)\n", encoding="utf-8")
    (root / "CMakeLists.txt").write_text("cmake_minimum_required(VERSION 3.16)\n", encoding="utf-8")
    (root / "README.md").write_text("# demo\nTODO: fix later\n", encoding="utf-8")


# ---------------------------------------------------------------- 1. 底座工具集

def test_base_tools() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _make_tree(root)
        ctx = CaptureCtx(td)

        # file_tree：应含 src/ 与 main/ 且不含无关目录
        tree = tool_file_tree({"path": ""}, ctx)
        assert "src/" in tree and "main/" in tree and "CMakeLists.txt" in tree, tree[:300]
        print("file_tree OK")

        # glob：匹配全部 .c（rglob 语义递归）
        got = tool_glob({"path": "", "glob": "**/*.c"}, ctx)
        assert "src/app.c" in got, got
        print("glob OK")

        # grep：内容命中 README.md
        got = tool_grep({"path": "", "query": "TODO"}, ctx)
        assert "README.md:2" in got, got
        # grep 限定 glob 过滤
        got = tool_grep({"path": "", "query": "TODO", "glob": "**/*.md"}, ctx)
        assert "README.md:2" in got, got
        print("grep OK")

        # edit_file exact-match 三分支：唯一命中 / 多处拒绝 / 未找到提示
        target = root / "src" / "app.c"
        r = tool_edit_file(
            {"path": "src/app.c", "old_string": "printf(\"hi\")", "new_string": "printf(\"hello\")"}, ctx
        )
        assert "已编辑" in r, r
        assert target.read_text(encoding="utf-8").count("hello") == 1

        # 多处出现 → 拒绝（先造两处相同原文）
        target.write_text("puts(\"a\");\nputs(\"b\");\n", encoding="utf-8")
        r2 = tool_edit_file({"path": "src/app.c", "old_string": "puts", "new_string": "logs"}, ctx)
        assert "出现 2 次" in r2, r2

        # 未找到 → 定位提示
        r3 = tool_edit_file(
            {"path": "src/app.c", "old_string": "不存在的原文", "new_string": "x"}, ctx
        )
        assert "未找到" in r3, r3
        assert "patch/applied" in [e[3] for e in ctx.events]  # 事件类型已落
        print("edit_file exact-match 三分支 OK")


# ---------------------------------------------------------------- 2. run_check 工程类型 + TS 诊断

def test_project_detect() -> None:
    with tempfile.TemporaryDirectory() as td:
        esp = Path(td) / "esp"
        esp.mkdir()
        (esp / "CMakeLists.txt").write_text("cmake_minimum_required(VERSION 3.16)", encoding="utf-8")
        (esp / "main").mkdir()  # ESP-IDF 工程特征（main/ 目录）
        assert detect_project_type(esp) == "esp-idf"

        # 仅有 CMakeLists 的通用 CMake 工程 → 不误判为 esp-idf
        cmake = Path(td) / "cmake_only"
        cmake.mkdir()
        (cmake / "CMakeLists.txt").write_text("cmake_minimum_required(VERSION 3.16)", encoding="utf-8")
        assert detect_project_type(cmake) is None

        ts = Path(td) / "ts"
        ts.mkdir()
        (ts / "tsconfig.json").write_text("{}", encoding="utf-8")
        assert detect_project_type(ts) == "ts"

        other = Path(td) / "other"
        other.mkdir()
        assert detect_project_type(other) is None
    print("工程类型探测 OK（esp-idf / ts / 未知）")


def test_ts_diagnostics_parse() -> None:
    # --pretty false 格式: path(line,col): error TSxxxx: msg
    log_a = (
        "src/index.ts(5,9): error TS2322: Type 'string' is not assignable to type 'number'.\n"
        "src/index.ts(8,1): warning TS6198: All destructured elements are unused.\n"
        "Found 2 errors.\n"
    )
    diags = parse_ts_diagnostics(log_a, str(Path("ts_proj").resolve()), str(Path(".").resolve()))
    assert diags, "A 格式应解析出诊断"
    assert diags[0]["level"] == "error" and diags[0]["ruleId"] == "ts2322"
    assert diags[0]["range"]["start"] == {"line": 5, "column": 9}
    assert diags[1]["level"] == "warn" and diags[1]["ruleId"] == "ts6198"

    # 默认 pretty 格式: path:line:col - error TSxxxx: msg
    log_b = (
        "src/foo.ts:3:5 - error TS2304: Cannot find name 'x'.\n"
        "src/foo.ts:7:1 - error TS2554: Expected 2 arguments, but got 1.\n"
    )
    diags_b = parse_ts_diagnostics(log_b, str(Path("p2").resolve()), str(Path(".").resolve()))
    assert len(diags_b) == 2, diags_b
    assert diags_b[0]["ruleId"] == "ts2304" and diags_b[1]["range"]["start"]["line"] == 7
    print("TS 诊断解析 OK（pretty/非 pretty 两种格式）")


# ---------------------------------------------------------------- 3. git_safe 工作区 checkpoint/回滚

def test_git_workspace() -> None:
    if shutil.which("git") is None:
        print("git 不可用，跳过 git_safe 测试")
        return
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        # eligible：外部临时目录（非 outputs 且非仓库）应返回 False
        assert workspace_git_eligible(root) is False
        assert snapshot_session(root, "skip")["eligible"] is False

        # 制造一个"已是仓库"的工作区（模拟内核 outputs 内已 git 化）
        w = root / "ws"
        w.mkdir()
        (w / "a.c").write_text("int a;\n", encoding="utf-8")
        repo = ensure_workspace_git(w, baseline_message="baseline")
        assert repo is not None and find_repo_root(w) == repo
        assert workspace_git_eligible(w) is True  # 已成为仓库

        # 无变更 checkpoint → 不产生提交
        assert checkpoint(w, "noop") is None

        # 修改文件 → checkpoint 产生提交
        (w / "a.c").write_text("int a = 1;\n", encoding="utf-8")
        h1 = checkpoint(w, "change a")
        assert h1 is not None
        (w / "a.c").write_text("int a = 2;\n", encoding="utf-8")
        h2 = checkpoint(w, "change a again")
        assert h2 is not None and h2 != h1

        # snapshot_session（带 file_path）在已仓库工作区可用
        snap = snapshot_session(w, "session snap", file_path=w / "a.c")
        assert snap["repo"] is True

        # 回滚到上一 checkpoint（HEAD 是本模块提交 → HEAD~1）
        msg, ok = rollback(w)
        assert ok and (w / "a.c").read_text(encoding="utf-8") == "int a = 1;\n", (msg, (w / "a.c").read_text())

        # rollback_session 显式端点语义：reset 后历史为 baseline→h1(1)，再提交 h2'(2)，
        # 回滚 HEAD~1 = h1(1)
        (w / "a.c").write_text("int a = 2;\n", encoding="utf-8")
        _ = checkpoint(w, "change a third")
        msg2, ok2 = rollback_session(w)
        assert ok2 and (w / "a.c").read_text(encoding="utf-8") == "int a = 1;\n", msg2
    print("git_safe OK（eligible / git 化 / checkpoint 无空提交 / 回滚）")


def test_diagnostics_c_parser_still_ok() -> None:
    log = "D:/p/main/app.c:12:5: error: expected ';' before '}' token\n"
    diags = parse_diagnostics(log, str(Path("proj").resolve()), str(Path(".").resolve()))
    assert diags and diags[0]["level"] == "error"
    print("C 诊断解析回归 OK")


if __name__ == "__main__":
    test_base_tools()
    test_project_detect()
    test_ts_diagnostics_parse()
    test_git_workspace()
    test_diagnostics_c_parser_still_ok()
    print("ALL_PHASE3_TESTS_PASSED")
