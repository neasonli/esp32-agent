"""DSH rc.5 沙盒策略的 Python 镜像（V3.1 · agent核心开发文档 附录 D）。

语义与 @deepseek-ai/dsh-sandbox(-policy / -fs-sandbox) 对齐，规划器侧才是策略所有者
（ctx.sandboxPolicy：部署默认 mode + workspaceRoot + 每会话 sandbox/mode 覆盖折叠），
内核只负责在工具边界按每次调用携带的 {mode, workspace_root, session_id} 执行围栏：

- read-only            —— 拒绝一切会变更文件/设备/仓库的工具（fail-closed，同 DSH "cannot modify files"）；
- workspace-write      —— write_file/edit_file 的目标必须落在 canonical(workspace_root) 与平台 temp 根内
                          （dsh-fs-sandbox checkedTarget 的 writableRoots 语义）；子进程类工具
                          （shell/build/flash/run_check…）已由内核 cwd 防穿越约束，OS 级进程限制
                          是规划器 ctx.sandbox（Windows ACL restricted-token runner）的职责，见附录 D 边界；
- danger-full-access   —— 放行（升级前行为）。

模型可见的拒绝文本与 DSH 逐字一致（tool-fs mapError 产出）：
  [sandbox: file access denied under <mode> mode]
  [sandbox: escalation available — retry this exact operation once with sandbox_permissions
   (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
"""
import os
import tempfile

SANDBOX_MODES = ('read-only', 'workspace-write', 'danger-full-access')

# 会变更文件/仓库/构建产物/设备的工具：read-only 下整工具拒绝（无 OS 级进程围栏时的 fail-closed）。
MUTATION_TOOLS = frozenset({'write_file', 'edit_file', 'shell', 'git_clone', 'build', 'run_check', 'flash'})

# 目标路径可静态解析、需 workspace-write 围栏校验的工具（参数名 = 目标路径）。
TARGET_TOOLS = frozenset({'write_file', 'edit_file'})

_DENIAL_MARKER_TEMPLATE = '[sandbox: file access denied under {mode} mode]'
_ESCALATION_HINT = (
    '[sandbox: escalation available — retry this exact operation once with sandbox_permissions '
    '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
)


class SandboxDenied(Exception):
    """一次策略拒绝。str(e) = DSH 逐字双行文本（marker + escalation hint）。"""

    def __init__(self, mode: str):
        super().__init__(_denial_text(mode))
        self.mode = mode


def _denial_text(mode: str) -> str:
    return f'{_DENIAL_MARKER_TEMPLATE.format(mode=mode)}\n{_ESCALATION_HINT}'


def mode_of(policy) -> str | None:
    if isinstance(policy, dict):
        mode = policy.get('mode')
        if mode in SANDBOX_MODES:
            return mode  # type: ignore[return-value]
    return None


def _canonical(path: str) -> str:
    # Node realpathSync.native 语义近似：已存在路径解析符号链接；缺失路径保留拼写（保守：匹配不到即拒绝）。
    try:
        return os.path.realpath(path)
    except OSError:
        return str(path)


def writable_roots(policy: dict) -> list[str]:
    """workspace-write 的可写根（dsh-sandbox writableRoots：workspace_root + 平台 temp 根）。
    '/tmp' 仅在本机真实存在时加入（Windows 上 Node canonicalPath 失败保留拼写、匹配不到任何路径）。"""
    roots: list[str] = [_canonical(str(policy.get('workspace_root') or ''))]
    tmp = tempfile.gettempdir()
    if tmp:
        roots.append(_canonical(tmp))
    if os.path.exists('/tmp'):
        roots.append(_canonical('/tmp'))
    seen: set[str] = set()
    out: list[str] = []
    for r in roots:
        key = r.lower() if os.name == 'nt' else r
        if r and key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _lexically_under(path: str, root: str, ci: bool) -> bool:
    if ci:
        path = path.lower()
        root = root.lower()
    if path == root:
        return True
    prefix = root if root.endswith(os.sep) else root + os.sep
    return path.startswith(prefix)


def enforce_write(policy: dict, abs_target: str) -> None:
    """按策略围栏一次写/编辑目标（dsh-fs-sandbox checkedTarget 语义；越界/拒绝抛 SandboxDenied）。"""
    mode = mode_of(policy)
    if mode is None or mode == 'danger-full-access':
        return
    if mode == 'read-only':
        raise SandboxDenied(mode)
    # workspace-write：目标 canonical 后必须在可写根内（含符号链接祖先已解析）。
    ci = os.name == 'nt'
    target = _canonical(str(abs_target))
    for root in writable_roots(policy):
        if _lexically_under(target, root, ci):
            return
    raise SandboxDenied(mode)
