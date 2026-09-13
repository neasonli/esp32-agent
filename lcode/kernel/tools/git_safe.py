"""工作区 git 化 + 会话 checkpoint 安全兜底（阶段3 Phase3，agent核心开发文档 §3.1/§8 Phase 3）。

三个便宜机制之一 = **git + 会话 checkpoint 安全兜底**：工作区（会话 cwd）自动 git 化，
每次用户回合结束（会话回 idle）落一个 checkpoint 提交，回滚靠 git（`git reset --hard`
到上一 checkpoint），**不做工程快照事务**（§3.1 表）。本模块只做确定性 git 操作：

- `find_repo_root`    向上找最近 `.git`（在已有仓库内工作区不重复 init）。
- `ensure_workspace_git(cwd)`  工作区 git 化：无仓库 → `git init` + 默认 .gitignore
  （build/ node_modules/ 等可再生成目录）+ 本地身份兜底 + baseline 提交（如工作区非空）。
- `checkpoint(cwd, message)`   `git add -A` + commit；无变更不产生空提交。
- `rollback(cwd, commit=None)` 回滚到指定提交（默认上一 checkpoint）；`--hard` 语义，
  由显式端点触发（桌面「回滚」按钮），不做对话中自动回滚。
- `repo_info(cwd)`     只读状态：是否仓库/根目录/HEAD/dirty 计数，供 UI 展示。

安全约束：所有 git 命令仅作用在「cwd 所在仓库根」内，绝不递归到工作区外；
git 不可用时全部静默降级（不影响文件工具本身可用性）。
"""
import shutil
import subprocess
from pathlib import Path

GIT_TIMEOUT = 60           # 单条 git 命令超时（秒）
GIT_INIT_MAX_FILES = 20000  # 自动 git 化最大文件数守卫（防超大目录误 init）
GIT_IGNORE_DEFAULT = (
    "# L-CODE 工作区自动生成（可追加修改；build/ 等可再生成目录不入库）\n"
    "build/\nmanaged_components/\n.venv/\n__pycache__/\n*.pyc\n"
    "node_modules/\n.pio/\n.spiffs/\n"
)
_LC_PREFIX = "[lcode] "


def _git_available() -> bool:
    return shutil.which("git") is not None


def _run(cwd: Path, *args: str) -> tuple[str, int]:
    """执行 git 命令，返回 (stdout+stderr, returncode)。"""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT,
    )
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return out, proc.returncode


def find_repo_root(cwd: Path) -> Path | None:
    """从 cwd 向上找第一个含 .git 的目录；找不到返回 None。"""
    p = cwd.resolve()
    for d in [p, *p.parents]:
        if (d / ".git").exists():
            return d
    return None


# 工程特征文件（判定"这是一个工程根"，避免把 outputs 整根/用户目录当工程）
_PROJECT_MARKERS = {
    "CMakeLists.txt", "package.json", "pyproject.toml", "tsconfig.json",
    "sdkconfig", "setup.py", "Cargo.toml", "go.mod",
}


def project_root_for(file_path: str | Path, stop: Path | None = None) -> Path | None:
    """从被编辑文件向上找工程根（最近含工程特征文件 或 .git 的目录）。

    - 优先：最近祖先含 _PROJECT_MARKERS 或 .git → 该目录为工程根；
    - 都没有 → None（调用方回退：eligible 的 cwd 或跳过）。
    stop：向上搜索的边界（默认无限）；通常传会话 cwd，避免越出工作区。
    """
    p = Path(file_path).resolve()
    candidates = [p, *p.parents] if p.is_dir() else [*p.parents]
    if stop is not None:
        boundary = Path(stop).resolve()
        inside = [d for d in candidates if d == boundary or boundary in d.parents]
        if inside:
            candidates = inside
    for d in candidates:
        if (d / ".git").exists():
            return d
        if any((d / m).exists() for m in _PROJECT_MARKERS):
            return d
    return None


def _ensure_local_identity(repo: Path) -> None:
    """仓库本地身份兜底（不覆盖已有配置；避免无 user.name 提交失败）。"""
    for key in ("user.name", "user.email"):
        out, _ = _run(repo, "config", "--local", "--get", key)
        if not out.strip():
            default = "L-CODE Agent" if key == "user.name" else "lcode@local"
            _run(repo, "config", "--local", key, default)


def _ensure_gitignore(repo: Path) -> None:
    """无 .gitignore 时写入默认忽略（存在则不覆盖，尊重用户自定义）。"""
    gi = repo / ".gitignore"
    if not gi.exists():
        try:
            gi.write_text(GIT_IGNORE_DEFAULT, encoding="utf-8")
        except OSError:
            pass


def ensure_workspace_git(cwd: str | Path, baseline_message: str = "workspace baseline") -> Path | None:
    """工作区 git 化：在 cwd 内 init（若 cwd 已在仓库内则复用），返回仓库根。

    - 已在仓库（向上有 .git）→ 直接复用，不重复 init / 不写 .gitignore / 不提交。
    - 无仓库 → `git init`，写默认 .gitignore，兜底本地身份；
      工作区已有文件时做 baseline 提交（幂等：仅无 HEAD 时提交）。
    返回 None = git 不可用或 init 失败（调用方静默降级）。
    """
    if not _git_available():
        return None
    root = Path(cwd).resolve()
    root.mkdir(parents=True, exist_ok=True)
    existing = find_repo_root(root)
    if existing is not None:
        return existing

    out, code = _run(root, "init", "-q")
    if code != 0:
        return None
    _ensure_gitignore(root)
    _ensure_local_identity(root)
    # 无 HEAD 才打 baseline（幂等）；工作区为空时跳过空提交。
    head_out, head_code = _run(root, "rev-parse", "--verify", "HEAD")
    if head_code != 0:
        _run(root, "add", "-A")
        staged, code2 = _run(root, "diff", "--cached", "--quiet")
        if code2 != 0:
            _run(root, "commit", "-q", "-m", f"{_LC_PREFIX}{baseline_message}")
    return root


def checkpoint(cwd: str | Path, message: str) -> str | None:
    """会话 checkpoint：add -A + commit；无变更返回 None；成功返回短哈希。"""
    if not _git_available():
        return None
    root = find_repo_root(Path(cwd).resolve())
    if root is None:
        return None
    _run(root, "add", "-A")
    _, code = _run(root, "diff", "--cached", "--quiet")
    if code == 0:
        return None  # 无变更，不产生空提交
    _ensure_local_identity(root)
    out, code = _run(root, "commit", "-q", "-m", f"{_LC_PREFIX}{message}")
    if code != 0:
        return None
    short, _ = _run(root, "rev-parse", "--short", "HEAD")
    return short.strip() or None


def rollback(cwd: str | Path, commit: str | None = None) -> tuple[str, bool]:
    """回滚工作区到指定提交（默认「上一 checkpoint」= HEAD^，仅当 HEAD 是本模块提交）。

    返回 (说明文本, 是否成功)。`--hard` 丢弃工作区未提交修改——由显式用户动作触发。
    """
    if not _git_available():
        return "[git] git 不可用", False
    root = find_repo_root(Path(cwd).resolve())
    if root is None:
        return f"[git] 工作区未 git 化: {cwd}", False

    target = commit
    if not target:
        head, _ = _run(root, "rev-parse", "--short", "HEAD")
        subject, _ = _run(root, "log", "-1", "--format=%s")
        if subject.startswith(_LC_PREFIX):
            # HEAD 是本模块提交 → 回退到它的父提交（上一个 checkpoint/baseline）
            target = "HEAD~1"
        else:
            target = "HEAD"
    out, code = _run(root, "reset", "--hard", target)
    if code != 0:
        return f"[git] 回滚失败（{target}）: {out[-500:]}", False
    now, _ = _run(root, "rev-parse", "--short", "HEAD")
    return f"✅ 已回滚工作区到 {now}（{target}）", True


def repo_info(cwd: str | Path) -> dict:
    """只读仓库状态（供桌面/端点展示，不修改任何东西）。"""
    base = {"repo": False, "root": "", "head": "", "subject": "", "dirty": 0}
    if not _git_available():
        return base
    root = find_repo_root(Path(cwd).resolve())
    if root is None:
        return base
    base.update(repo=True, root=str(root))
    head, _ = _run(root, "rev-parse", "--short", "HEAD")
    base["head"] = head or ""
    subject, _ = _run(root, "log", "-1", "--format=%s")
    base["subject"] = subject or ""
    status, _ = _run(root, "status", "--porcelain")
    base["dirty"] = len([ln for ln in status.splitlines() if ln.strip()])
    return base


def _under_outputs(path: Path) -> bool:
    """path 是否位于内核 outputs 工作区内（kernel-managed）。"""
    try:
        from config.settings import settings  # noqa: PLC0415 - 延迟导入避免循环
        outputs = settings.outputs_dir_resolved.resolve()
    except Exception:  # noqa: BLE001 - 配置异常时不阻断
        return False
    p = path.resolve()
    return p == outputs or outputs in p.parents


def workspace_git_eligible(cwd: str | Path) -> bool:
    """判断 cwd 是否应自动 git 化：已是仓库，或位于内核 outputs 工作区内。

    避免在用户任意外部目录（如桌面/个人工程）无感 `git init`：
    只有「内核管理的 workspace（outputs 工作区）」或「已是 git 仓库」的目录
    才参与自动会话 checkpoint；其余目录的 LLM 编辑仍然可用，仅不做自动 git 兜底。
    """
    p = Path(cwd).resolve()
    if find_repo_root(p) is not None:
        return True
    return _under_outputs(p)


def _file_count_guard(root: Path) -> bool:
    """超大目录守卫：预估文件数（仅算一层+深度剪枝，快检）超限则跳过自动 init。"""
    import os  # noqa: PLC0415

    total = 0
    for _, dirs, files in os.walk(root):
        total += len(files)
        if total > GIT_INIT_MAX_FILES:
            return False
    return True


def ensure_session_git(cwd: str | Path, message: str = "workspace baseline") -> dict:
    """会话创建时的工作区 git 化：幂等、只读不改文件。

    规则：cwd 已是 git 仓库 → 复用；否则仅当 cwd 本身是工程根
    （含 CMakeLists/package.json/tsconfig.json 等特征）才 `git init` + baseline。
    容器型目录（如多工程 outputs 根）不在会话创建时 git 化——交给被编辑文件所属
    工程（`_resolve_project_root` 按特征文件向上定位），避免把一整个树无感 init。
    返回 {repo, created, root}；created=True 表示本次新 init（含 baseline）。
    """
    if not _git_available():
        return {"repo": False, "created": False, "root": ""}
    base = Path(cwd).resolve()
    if not base.exists():
        return {"repo": False, "created": False, "root": ""}
    existing = find_repo_root(base)
    if existing is not None:
        return {"repo": True, "created": False, "root": str(existing)}
    # 仅当 cwd 是工程根才 init（避免容器目录整体 git 化）
    if project_root_for(base) != base:
        return {"repo": False, "created": False, "root": ""}
    if not _file_count_guard(base):
        return {"repo": False, "created": False, "root": ""}
    root = ensure_workspace_git(base, baseline_message=message)
    if root is None:
        return {"repo": False, "created": False, "root": ""}
    return {"repo": True, "created": True, "root": str(root)}


def _resolve_project_root(cwd: str | Path, file_path: str | Path | None) -> Path | None:
    """决定 checkpoint 的仓库根（避免嵌套 git init / 容器整树 init / 用户目录无感 init）：

    1. 文件/cwd 向上已有仓库（用户/子工程自建）→ 直接用该仓库根（不重复 init）；
    2. 否则被编辑文件所在「工程根」（含 CMakeLists/package.json 等特征，cwd 内）
       且属于 eligible 工作区 → 用它（多工程 outputs 里每工程独立成仓）；
    3. 否则 cwd 是 eligible 工作区且本身是工程根 → git 化 cwd；
    返回 None = 无仓库且不可 git 化（跳过自动 git 兜底，编辑仍可用）。
    """
    base = Path(cwd).resolve()
    # 1) 已有仓库优先：编辑动作只会发生在 cwd 内，向上找到即用
    anchors = ([Path(file_path).resolve()] if file_path is not None else []) + [base]
    for a in anchors:
        repo = find_repo_root(a if a.is_dir() else a.parent)
        if repo is not None:
            return repo
    # 2/3) 候选 git 化根必须属于 eligible 工作区（outputs 内），避免无感 init 用户目录
    if file_path is not None:
        proot = project_root_for(file_path, stop=base)
        if proot is not None and workspace_git_eligible(proot):
            return proot
    if workspace_git_eligible(base) and project_root_for(base) == base:
        return base
    return None


def snapshot_session(cwd: str | Path, message: str, file_path: str | Path | None = None) -> dict:
    """会话 checkpoint：被编辑文件的工程根（或 eligible cwd）先 git 化再 add+commit。

    返回 {repo, created, commit, eligible}；无变更 commit=None（不产生空提交）。
    """
    if not _git_available():
        return {"repo": False, "created": False, "commit": None, "eligible": False}
    root = _resolve_project_root(cwd, file_path)
    if root is None:
        return {"repo": False, "created": False, "commit": None, "eligible": False}
    root = ensure_workspace_git(root, baseline_message="workspace baseline")
    if root is None:
        return {"repo": False, "created": False, "commit": None, "eligible": True}
    commit = checkpoint(root, message)
    return {"repo": True, "created": True, "commit": commit, "eligible": True}


def rollback_session(cwd: str | Path, commit: str | None = None) -> tuple[str, bool]:
    """会话回滚（显式端点触发）：回滚 cwd 所在仓库到指定/上一 checkpoint。"""
    return rollback(cwd, commit)
