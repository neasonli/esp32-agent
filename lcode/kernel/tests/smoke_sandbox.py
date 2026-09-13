"""沙盒策略镜像冒烟（V3.1 · agent核心开发文档 附录 D）：与 DSH rc.5 语义/文本对齐。

运行:
    python tests/smoke_sandbox.py

覆盖:
  1) read-only：一切变更类工具拒绝，文本 = DSH marker + escalation hint（逐字）
  2) workspace-write：workspace 内写放行 / 外部目标拒绝（含 Windows 大小写不敏感）/ 平台 temp 根放行
  3) danger-full-access 与缺省策略放行
  4) enforce_write 经 API 层调用路径（write_file/edit_file 目标）
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.sandbox_policy import (  # noqa: E402
    MUTATION_TOOLS,
    SandboxDenied,
    _denial_text,
    enforce_write,
    mode_of,
    writable_roots,
)

EXPECTED_MARKER_LINES = [
    "[sandbox: file access denied under read-only mode]",
    "[sandbox: escalation available — retry this exact operation once with sandbox_permissions "
    "(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
]


def _expect(cond: bool, label: str) -> None:
    print(("OK  " if cond else "FAIL") + " " + label)
    if not cond:
        raise AssertionError(label)


def test_denial_text() -> None:
    text = _denial_text("read-only").splitlines()
    _expect(text == EXPECTED_MARKER_LINES, "read-only 拒绝文本与 DSH 逐字一致")


def test_read_only_denies_all_mutation_tools() -> None:
    policy = {"mode": "read-only", "workspace_root": os.getcwd(), "session_id": ""}
    # MUTATION_TOOLS 覆盖：write_file/edit_file/shell/git_clone/build/run_check/flash
    for name in ("write_file", "edit_file", "shell", "git_clone", "build", "run_check", "flash"):
        _expect(name in MUTATION_TOOLS, f"read-only 拒绝面含 {name}")
    try:
        enforce_write(policy, os.path.join(os.getcwd(), "x.txt"))
        _expect(False, "read-only 下 enforce_write 应抛 SandboxDenied")
    except SandboxDenied as e:
        _expect(e.mode == "read-only", "read-only 拒绝带 mode")
        _expect(str(e).splitlines() == EXPECTED_MARKER_LINES, "read-only 拒绝文本正确")


def test_workspace_write_containment() -> None:
    with tempfile.TemporaryDirectory() as td:
        ws = td
        # 外部目标取“非 temp、非 workspace”的真实绝对路径（内核目录的父目录下）
        outside = str(Path(os.getcwd()).resolve().parent / "dsh_sandbox_outside.txt")
        policy = {"mode": "workspace-write", "workspace_root": ws, "session_id": ""}
        # 根内（含大小写变体，Windows 大小写不敏感）
        enforce_write(policy, os.path.join(ws, "a.txt"))
        _expect(True, "workspace 内写放行")
        enforce_write(policy, os.path.join(ws, "sub", "nested.txt"))
        _expect(True, "workspace 子目录写放行")
        enforce_write(policy, os.path.join(ws, "A.TXT"))
        _expect(True, "大小写变体放行（Windows 大小写不敏感）")
        # workspace 外拒绝
        try:
            enforce_write(policy, outside)
            _expect(False, "workspace 外目标应拒绝")
        except SandboxDenied as e:
            _expect(e.mode == "workspace-write", "workspace-write 拒绝带 mode")
        # 平台 temp 根放行（writableRoots 语义）
        roots = writable_roots(policy)
        tmp = tempfile.gettempdir()
        _expect(any(os.path.realpath(tmp).lower() == r.lower() for r in roots), "writableRoots 含平台 temp 根")
        enforce_write(policy, os.path.join(tmp, "dsh-smoke.txt"))
        _expect(True, "平台 temp 根内写放行")


def test_danger_and_absent_pass() -> None:
    enforce_write({"mode": "danger-full-access", "workspace_root": os.getcwd()}, r"C:\anything\out.txt")
    _expect(True, "danger-full-access 放行")
    enforce_write({"workspace_root": os.getcwd()}, r"C:\anything\out.txt")
    _expect(True, "缺省策略（无 mode）放行")
    _expect(mode_of({"mode": "nonsense"}) is None, "非法 mode 视为无策略")


if __name__ == "__main__":
    test_denial_text()
    test_read_only_denies_all_mutation_tools()
    test_workspace_write_containment()
    test_danger_and_absent_pass()
    print("ALL_SANDBOX_TESTS_PASSED")
