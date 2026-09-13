"""SQLite 任务存储（stdlib sqlite3，零中间件，文档 5.5）。

同一 db 文件可同时供 LangGraph checkpoint-sqlite 使用（阶段 1 默认未启用）。
"""
import json
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from config.settings import settings

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

# 任务状态枚举
STATUS_PENDING = "PENDING"
STATUS_RUNNING = "RUNNING"
STATUS_SUCCESS = "SUCCESS"
STATUS_FAILED = "FAILED"
STATUS_INTERRUPTED = "INTERRUPTED"
STATUS_CANCELED = "CANCELED"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id         TEXT PRIMARY KEY,
    user_requirement TEXT NOT NULL,
    status          TEXT NOT NULL,
    chip_model      TEXT DEFAULT '',
    project_dir     TEXT DEFAULT '',
    result_json     TEXT DEFAULT '',
    error_msg       TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    cancel_requested INTEGER DEFAULT 0,   -- 阶段2 W2：取消标志
    workspace_id    TEXT DEFAULT ''       -- 阶段2 W2：工作区关联
);

-- 阶段2 W1：事件日志表（桌面网关增量轮询，实现流式日志）
CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    ts         TEXT NOT NULL,
    level      TEXT NOT NULL,          -- INFO / WARN / ERROR / NODE
    node       TEXT DEFAULT '',        -- 节点名（chip_select 等，非节点事件为空）
    message    TEXT NOT NULL,
    event_type TEXT DEFAULT '',        -- 阶段3 Phase2：统一事件字典类型（agent核心开发文档 §5.2：turn/start、tool/call、check/start、diagnostic…）
    payload    TEXT DEFAULT ''         -- 阶段3 Phase2：结构化载荷（JSON 字符串；无载荷为空）
);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);

-- 阶段2 W2：LLM Token 用量统计
CREATE TABLE IF NOT EXISTS task_llm_usage (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          TEXT NOT NULL,
    node             TEXT DEFAULT '',
    model            TEXT DEFAULT '',
    prompt_tokens    INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cost             REAL DEFAULT 0,
    ts               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_task ON task_llm_usage(task_id);

-- 阶段2 W2：工作区（D11 持久工作目录）
CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id   TEXT PRIMARY KEY,
    project_dir    TEXT NOT NULL,
    chip           TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    last_updated   TEXT NOT NULL,
    history        TEXT DEFAULT '[]'
);

-- 阶段2 W3：对话式 Agent 会话（自由聊天 + 工具调用）
CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id       TEXT PRIMARY KEY,
    title            TEXT DEFAULT '',
    cwd              TEXT DEFAULT '',          -- 会话工作目录（shell/文件工具的基准目录）
    status           TEXT DEFAULT 'idle',      -- idle / running
    cancel_requested INTEGER DEFAULT 0,        -- 阶段2 W3：用户主动停止标志
    waiting_confirm  INTEGER DEFAULT 0,        -- 阶段2 W3：每 100 轮暂停，等待用户确认继续/停止
    chat_steps       INTEGER DEFAULT 0,        -- 阶段2 W3：已执行的 LLM 轮次（跨轮次累计，用于 100 轮确认）
    full_access      INTEGER DEFAULT 1,        -- 阶段2 W3：全部执行模式（1=全开；0=普通模式受限工具）
    pending_flash    TEXT DEFAULT '',          -- 阶段3 Phase2：待烧录请求（JSON：{project_dir, port}；防误烧，会话确认后由用户显式确认端口执行）
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    role         TEXT NOT NULL,           -- user / assistant / tool
    content      TEXT NOT NULL,
    tool_name    TEXT DEFAULT '',         -- 工具名（tool 消息）；assistant 工具调用消息 = "__toolcalls__"
    tool_call_id TEXT DEFAULT '',         -- OpenAI tool_call_id（tool 消息回填用）
    ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_messages(session_id, id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    """获取全局 SQLite 连接（懒初始化）。"""
    global _conn
    if _conn is None:
        settings.data_dir_resolved
        _conn = sqlite3.connect(str(settings.db_path), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(_SCHEMA)  # 多条 DDL 必须用 executescript
        _migrate(_conn)
        _conn.commit()
    return _conn


def _migrate(conn: sqlite3.Connection) -> None:
    """轻量迁移：为已存在的旧表补充新增列（IF NOT EXISTS 不会改旧表）。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    if "cancel_requested" not in cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER DEFAULT 0")
    if "workspace_id" not in cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT ''")
    # chat_sessions 已存在（含旧数据）时补列
    has_chat = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions'"
    ).fetchone()
    if has_chat:
        chat_cols = {r["name"] for r in conn.execute("PRAGMA table_info(chat_sessions)").fetchall()}
        if "cancel_requested" not in chat_cols:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN cancel_requested INTEGER DEFAULT 0")
        if "waiting_confirm" not in chat_cols:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN waiting_confirm INTEGER DEFAULT 0")
        if "chat_steps" not in chat_cols:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN chat_steps INTEGER DEFAULT 0")
        if "full_access" not in chat_cols:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN full_access INTEGER DEFAULT 1")
        if "pending_flash" not in chat_cols:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN pending_flash TEXT DEFAULT ''")
    # 阶段3 Phase2：events 表补充统一事件字典字段（event_type/payload，§5.2）
    ev_cols = {r["name"] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    if "event_type" not in ev_cols:
        conn.execute("ALTER TABLE events ADD COLUMN event_type TEXT DEFAULT ''")
    if "payload" not in ev_cols:
        conn.execute("ALTER TABLE events ADD COLUMN payload TEXT DEFAULT ''")


def init_db() -> None:
    get_conn()


def recover_running_tasks() -> int:
    """服务启动恢复：残留 RUNNING 任务置为 INTERRUPTED。返回受影响数量。"""
    conn = get_conn()
    with _lock:
        cur = conn.execute(
            "UPDATE tasks SET status=?, updated_at=? WHERE status=?",
            (STATUS_INTERRUPTED, _now(), STATUS_RUNNING),
        )
        conn.commit()
        return cur.rowcount


def create_task(requirement: str) -> str:
    """创建任务，返回 task_id。"""
    task_id = uuid.uuid4().hex[:16]
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO tasks (task_id, user_requirement, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?)",
            (task_id, requirement, STATUS_PENDING, _now(), _now()),
        )
        conn.commit()
    return task_id


def update_task(task_id: str, **fields) -> None:
    """按字段更新任务（白名单字段，避免 SQL 注入）。"""
    allowed = {"status", "chip_model", "project_dir", "result_json", "error_msg"}
    clean = {k: v for k, v in fields.items() if k in allowed}
    if not clean:
        return
    conn = get_conn()
    cols = ", ".join(f"{k}=?" for k in clean)
    with _lock:
        conn.execute(
            f"UPDATE tasks SET {cols}, updated_at=? WHERE task_id=?",
            (*clean.values(), _now(), task_id),
        )
        conn.commit()


def get_task(task_id: str) -> dict | None:
    """查询任务；不存在返回 None。"""
    conn = get_conn()
    row = conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if row is None:
        return None
    result = dict(row)
    if result.get("result_json"):
        try:
            result["result"] = json.loads(result["result_json"])
        except Exception:  # noqa: BLE001
            pass
    return result


def list_tasks(limit: int = 50) -> list[dict]:
    """最近任务列表（会话记录 V1.5 4.2.2）。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT task_id, user_requirement, status, chip_model, project_dir, error_msg, created_at, updated_at"
        " FROM tasks ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def delete_tasks(task_ids: list[str]) -> dict:
    """批量删除任务及其关联数据与工程目录（运行中/排队中任务跳过）。

    返回 {"deleted": n, "skipped": [task_ids]}。
    """
    conn = get_conn()
    skipped: list[str] = []
    deleted = 0
    with _lock:
        for tid in task_ids:
            row = conn.execute(
                "SELECT status, project_dir FROM tasks WHERE task_id=?", (tid,)
            ).fetchone()
            if row is None:
                continue
            if row["status"] in (STATUS_PENDING, STATUS_RUNNING):
                skipped.append(tid)
                continue
            # 删除工程目录（工作区项目目录或默认 outputs/{task_id}）
            if row["project_dir"] and Path(row["project_dir"]).exists():
                shutil.rmtree(row["project_dir"], ignore_errors=True)
            default_dir = settings.outputs_dir / tid
            if default_dir.exists():
                shutil.rmtree(default_dir, ignore_errors=True)
            # 关联数据
            conn.execute("DELETE FROM tasks WHERE task_id=?", (tid,))
            conn.execute("DELETE FROM events WHERE task_id=?", (tid,))
            conn.execute("DELETE FROM task_llm_usage WHERE task_id=?", (tid,))
            conn.execute(
                "DELETE FROM workspaces WHERE workspace_id=? OR project_dir=?",
                (tid, row["project_dir"] or ""),
            )
            # LangGraph checkpoint 数据（thread_id = task_id 或 task_id_restart_*）
            for tbl in ("checkpoints", "writes"):
                if _table_exists(conn, tbl):
                    conn.execute(
                        f"DELETE FROM [{tbl}] WHERE thread_id=? OR thread_id LIKE ?",
                        (tid, tid + "_%"),
                    )
            deleted += 1
        conn.commit()
    return {"deleted": deleted, "skipped": skipped}


# ---------- 事件日志（阶段2 W1） ----------

def add_event(
    task_id: str,
    level: str,
    message: str,
    node: str = "",
    event_type: str = "",
    payload: dict | None = None,
) -> int:
    """写入一条事件，返回其 seq（供网关增量拉取）。

    - event_type：统一事件字典类型（agent核心开发文档 §5.2），如 turn/start、tool/call、
      check/start、diagnostic；历史调用不传则存空串（兼容旧事件）。
    - payload：结构化载荷（可 JSON 序列化），序列化后存字符串。
    """
    conn = get_conn()
    payload_json = json.dumps(payload, ensure_ascii=False) if payload is not None else ""
    with _lock:
        cur = conn.execute(
            "INSERT INTO events (task_id, ts, level, node, message, event_type, payload)"
            " VALUES (?,?,?,?,?,?,?)",
            (task_id, _now(), level, node, message, event_type, payload_json),
        )
        conn.commit()
        return int(cur.lastrowid)


def get_events(task_id: str, after_seq: int = 0, limit: int = 500) -> list[dict]:
    """增量拉取事件：seq > after_seq 的最新 limit 条（含统一事件字典字段）。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT seq, task_id, ts, level, node, message, event_type, payload FROM events"
        " WHERE task_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
        (task_id, after_seq, limit),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if d.get("payload"):
            try:
                d["payload"] = json.loads(d["payload"])
            except (ValueError, TypeError):
                pass  # 非 JSON 载荷保留原字符串
        out.append(d)
    return out


# ---------- 取消（阶段2 W2） ----------

def request_cancel(task_id: str) -> None:
    """请求取消任务（幂等）。节点会在执行前检查该标志。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE tasks SET cancel_requested=1, updated_at=? WHERE task_id=?",
            (_now(), task_id),
        )
        conn.commit()


def is_cancel_requested(task_id: str) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT cancel_requested FROM tasks WHERE task_id=?", (task_id,)
    ).fetchone()
    return bool(row and row["cancel_requested"])


def reset_cancel(task_id: str) -> None:
    """清除取消标志（断点续跑前调用，避免旧取消状态影响新执行）。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE tasks SET cancel_requested=0, updated_at=? WHERE task_id=?",
            (_now(), task_id),
        )
        conn.commit()


# ---------- LLM Token 用量（阶段2 W2） ----------

def add_usage(
    task_id: str, node: str, model: str, prompt_tokens: int, completion_tokens: int, cost: float = 0.0
) -> None:
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO task_llm_usage (task_id, node, model, prompt_tokens, completion_tokens, cost, ts)"
            " VALUES (?,?,?,?,?,?,?)",
            (task_id, node, model, prompt_tokens, completion_tokens, cost, _now()),
        )
        conn.commit()


def get_usage(task_id: str) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT node, model, prompt_tokens, completion_tokens, cost, ts FROM task_llm_usage"
        " WHERE task_id=? ORDER BY id ASC",
        (task_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_usage_summary(task_id: str) -> dict:
    """按任务汇总：总 token / 按节点分布 / 估算费用。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, SUM(cost) AS c"
        " FROM task_llm_usage WHERE task_id=?",
        (task_id,),
    ).fetchone()
    by_node = conn.execute(
        "SELECT node, COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct"
        " FROM task_llm_usage WHERE task_id=? GROUP BY node",
        (task_id,),
    ).fetchall()
    return {
        "total_prompt_tokens": int(row["pt"] or 0),
        "total_completion_tokens": int(row["ct"] or 0),
        "total_tokens": int((row["pt"] or 0) + (row["ct"] or 0)),
        "cost": round(float(row["c"] or 0), 6),
        "by_node": [dict(r) for r in by_node],
    }


# ---------- 工作区（阶段2 W2，D11） ----------

def create_workspace(workspace_id: str, project_dir: str, chip: str = "") -> None:
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT OR REPLACE INTO workspaces (workspace_id, project_dir, chip, created_at, last_updated, history)"
            " VALUES (?,?,?,?,?,'[]')",
            (workspace_id, project_dir, chip, _now(), _now()),
        )
        conn.commit()


def update_workspace(workspace_id: str, chip: str = "", history_item: str = "") -> None:
    conn = get_conn()
    with _lock:
        row = conn.execute(
            "SELECT history, chip FROM workspaces WHERE workspace_id=?", (workspace_id,)
        ).fetchone()
        history = json.loads(row["history"]) if row else []
        if history_item:
            history.append(history_item)
        conn.execute(
            "UPDATE workspaces SET chip=?, history=?, last_updated=? WHERE workspace_id=?",
            (chip or (row["chip"] if row else ""), json.dumps(history, ensure_ascii=False), _now(), workspace_id),
        )
        conn.commit()


def list_workspaces() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT workspace_id, project_dir, chip, created_at, last_updated, history FROM workspaces ORDER BY last_updated DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_workspace(workspace_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT workspace_id, project_dir, chip, created_at, last_updated, history FROM workspaces WHERE workspace_id=?",
        (workspace_id,),
    ).fetchone()
    return dict(row) if row else None


# ---------- 产物收集（阶段2 W2，7.5） ----------

def collect_artifacts(project_dir: str) -> list[dict]:
    """扫描工程 build 目录，返回已生成产物清单（bootloader/partition/app 等）。"""
    from pathlib import Path

    build = Path(project_dir) / "build"
    artifacts = []
    if build.exists():
        for f in sorted(build.glob("*.bin")) + sorted(build.glob("*.elf")):
            artifacts.append(
                {"name": f.name, "path": str(f), "size_kb": round(f.stat().st_size / 1024, 1)}
            )
    return artifacts


# ---------- 对话式 Agent 会话（阶段2 W3） ----------

def create_chat_session(cwd: str = "", title: str = "", full_access: bool = True) -> str:
    """创建对话会话，返回 session_id（默认全部执行模式）。"""
    session_id = uuid.uuid4().hex[:16]
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO chat_sessions (session_id, title, cwd, status, full_access, created_at, updated_at)"
            " VALUES (?,?,?,'idle',?,?,?)",
            (session_id, title or "新对话", cwd, 1 if full_access else 0, _now(), _now()),
        )
        conn.commit()
    return session_id


def create_chat_session_with_id(session_id: str, cwd: str = "", title: str = "", full_access: bool = True) -> None:
    """以指定 session_id 创建对话会话（规划器用：三端同 ID，agent核心开发文档 §5.2）。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT OR IGNORE INTO chat_sessions"
            " (session_id, title, cwd, status, full_access, created_at, updated_at)"
            " VALUES (?,?,?,'idle',?,?,?)",
            (session_id, title or "新对话", cwd, 1 if full_access else 0, _now(), _now()),
        )
        conn.commit()


def fork_chat_session(session_id: str, at_message_id: int, title: str = "") -> str | None:
    """在新对话中分支（阶段4 W4 · 参考 DSH session.fork）。

    以某条 chat_messages 消息为锚点，把「该会话此前全部消息前缀（id<=锚点）」复制到
    一个全新会话（cwd / full_access 继承，状态置 idle，chat_steps/待烧录等归零）。
    返回新 session_id；源会话或锚点消息不存在返回 None。
    """
    conn = get_conn()
    with _lock:
        src = conn.execute(
            "SELECT title, cwd, full_access FROM chat_sessions WHERE session_id=?",
            (session_id,),
        ).fetchone()
        if src is None:
            return None
        anchor = conn.execute(
            "SELECT 1 FROM chat_messages WHERE session_id=? AND id=?",
            (session_id, at_message_id),
        ).fetchone()
        if anchor is None:
            return None
        new_id = uuid.uuid4().hex[:16]
        src_title = (src["title"] or "").strip()
        if title:
            base_title = title
        elif src_title and src_title != "新对话":
            base_title = f"{src_title}（分支）"
        else:
            base_title = "新对话"
        now = _now()
        conn.execute(
            "INSERT INTO chat_sessions (session_id, title, cwd, status, full_access, created_at, updated_at)"
            " VALUES (?,?,?,'idle',?,?,?)",
            (new_id, base_title, src["cwd"] or "", int(bool(src["full_access"])), now, now),
        )
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, content, tool_name, tool_call_id, ts)"
            " SELECT ?, role, content, tool_name, tool_call_id, ts FROM chat_messages"
            " WHERE session_id=? AND id<=? ORDER BY id",
            (new_id, session_id, at_message_id),
        )
        conn.commit()
    return new_id


def get_chat_session(session_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT session_id, title, cwd, status, cancel_requested, waiting_confirm, chat_steps, full_access,"
        " pending_flash, created_at, updated_at FROM chat_sessions WHERE session_id=?",
        (session_id,),
    ).fetchone()
    if row is None:
        return None
    d = dict(row)
    raw = d.get("pending_flash")
    if not raw:
        d["pending_flash"] = None  # 空串归一化为 None（桌面端以 null 判断无待烧录）
    else:
        try:
            d["pending_flash"] = json.loads(raw)
        except (ValueError, TypeError):
            d["pending_flash"] = None
    return d


def set_pending_flash(session_id: str, payload: dict | None) -> None:
    """登记/清除会话待烧录请求（防误烧：对话中只登记，会话确认后由用户显式确认端口执行）。"""
    conn = get_conn()
    text = json.dumps(payload, ensure_ascii=False) if payload is not None else ""
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET pending_flash=?, updated_at=? WHERE session_id=?",
            (text, _now(), session_id),
        )
        conn.commit()


def get_pending_flash(session_id: str) -> dict | None:
    """读取会话待烧录请求（无则 None）。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT pending_flash FROM chat_sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if not row or not row["pending_flash"]:
        return None
    try:
        p = json.loads(row["pending_flash"])
        return p if isinstance(p, dict) else None
    except (ValueError, TypeError):
        return None


def list_chat_sessions(limit: int = 50) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT s.session_id, s.title, s.cwd, s.status, s.created_at, s.updated_at,"
        " (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS msg_count"
        " FROM chat_sessions s ORDER BY s.updated_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def delete_chat_sessions(session_ids: list[str]) -> int:
    """删除对话会话（含消息历史与事件，任务/会话记录同 ID 打通；不可恢复）。返回删除的会话数。"""
    ids = [s for s in (session_ids or []) if s]
    if not ids:
        return 0
    conn = get_conn()
    with _lock:
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"DELETE FROM chat_sessions WHERE session_id IN ({placeholders})", ids
        )
        conn.execute(
            f"DELETE FROM chat_messages WHERE session_id IN ({placeholders})", ids
        )
        conn.execute(
            f"DELETE FROM events WHERE task_id IN ({placeholders})", ids
        )
        conn.commit()
        return int(cur.rowcount or 0)


def set_chat_session_status(session_id: str, status: str) -> None:
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET status=?, updated_at=? WHERE session_id=?",
            (status, _now(), session_id),
        )
        conn.commit()


def update_chat_session(session_id: str, title: str = "", cwd: str = "") -> None:
    """更新会话标题/工作目录（只更新非空字段）。"""
    conn = get_conn()
    sets, vals = [], []
    if title:
        sets.append("title=?")
        vals.append(title)
    if cwd:
        sets.append("cwd=?")
        vals.append(cwd)
    if not sets:
        return
    vals.append(session_id)
    with _lock:
        conn.execute(
            f"UPDATE chat_sessions SET {', '.join(sets)}, updated_at=? WHERE session_id=?",
            (*vals, _now()),
        )
        conn.commit()


def append_chat_message(
    session_id: str, role: str, content: str, tool_name: str = "", tool_call_id: str = ""
) -> int:
    """写入一条会话消息，返回 id。同时刷新会话 updated_at。"""
    conn = get_conn()
    with _lock:
        cur = conn.execute(
            "INSERT INTO chat_messages (session_id, role, content, tool_name, tool_call_id, ts)"
            " VALUES (?,?,?,?,?,?)",
            (session_id, role, content, tool_name, tool_call_id, _now()),
        )
        conn.execute(
            "UPDATE chat_sessions SET updated_at=? WHERE session_id=?",
            (_now(), session_id),
        )
        conn.commit()
        return int(cur.lastrowid)


def get_chat_messages(session_id: str, limit: int = 200) -> list[dict]:
    """按时间正序返回会话消息（最多 limit 条最近消息）。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, session_id, role, content, tool_name, tool_call_id, ts FROM chat_messages"
        " WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    rows = list(reversed(rows))
    return [dict(r) for r in rows]


def count_chat_messages(session_id: str) -> int:
    """会话消息真实总数（进度条口径用，不受渲染 limit 影响）。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) FROM chat_messages WHERE session_id=?", (session_id,)
    ).fetchone()
    return int(row[0]) if row else 0


def get_chat_messages_budgeted(session_id: str, max_tokens: int) -> list[dict]:
    """按 token 预算取会话消息（与 chat_agent._load_messages 同一口径）。

    从最新往回累计估算 token（密度 4 字符/token + 结构开销），超过预算即截断，
    保证 assistant tool_calls 与 tool 结果配对完整。返回保持时间正序。
    """
    from config.context import select_by_token_budget

    rows = get_chat_messages(session_id, limit=10000)
    picked, _ = select_by_token_budget(rows, max_tokens)
    return picked


def get_chat_session_detail(session_id: str) -> dict | None:
    """会话详情：基本信息 + 消息列表 + 最近事件 + 上下文使用估算。"""
    from config import context

    sess = get_chat_session(session_id)
    if sess is None:
        return None
    sess["messages"] = get_chat_messages(session_id)
    sess["events"] = get_events(session_id, after_seq=0, limit=1000)
    total_messages = count_chat_messages(session_id)

    # 上下文使用估算：与 chat_agent._load_messages 完全同口径
    # （同样按 token 预算截断、同样的 4 字符/token 密度），避免"按 200 条估算
    # 97%、实际只发预算内消息 31%"的虚高误导。窗口按当前模型映射，不再写死 64K。
    cwd = sess.get("cwd") or ""
    full_access = bool(sess.get("full_access", 1))
    window = context.window_tokens()
    budget = context.history_budget_tokens(cwd, full_access)
    budgeted = get_chat_messages_budgeted(session_id, budget)
    total_chars = sum(len(m["content"]) for m in budgeted)
    est_tokens = sum(context.estimate_message_tokens(m["content"]) for m in budgeted)
    envelope = context.estimate_envelope_tokens(cwd, full_access)
    total_est = envelope + est_tokens  # 信封(system+tools) + 消息
    sess["context"] = {
        "total_tokens_estimate": total_est,
        "message_tokens": est_tokens,
        "envelope_tokens": envelope,
        "total_chars": total_chars,
        "message_count": len(budgeted),
        "total_messages": total_messages,
        "window_tokens": window,
        "ratio": round(min(1.0, total_est / window), 4),
        "level": "ok" if total_est < window * 0.8 else ("warn" if total_est < window * 0.95 else "danger"),
    }
    return sess


# ---------- 对话会话取消（阶段2 W3：用户主动停止） ----------

def set_chat_cancel(session_id: str, flag: bool = True) -> None:
    """设置/清除会话停止标志（幂等）。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET cancel_requested=?, updated_at=? WHERE session_id=?",
            (1 if flag else 0, _now(), session_id),
        )
        conn.commit()


def is_chat_canceled(session_id: str) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT cancel_requested FROM chat_sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    return bool(row and row["cancel_requested"])


# ---------- 每 100 轮暂停确认（阶段2 W3：无限轮次 + 用户确认） ----------

def set_waiting_confirm(session_id: str, flag: bool = True) -> None:
    """设置/清除"等待用户确认"标志（每 100 轮暂停时置位，用户回应后清除）。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET waiting_confirm=?, updated_at=? WHERE session_id=?",
            (1 if flag else 0, _now(), session_id),
        )
        conn.commit()


def get_chat_steps(session_id: str) -> int:
    """读取会话已执行的 LLM 轮次（跨轮次累计）。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT chat_steps FROM chat_sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    return int(row["chat_steps"] or 0) if row else 0


def set_chat_steps(session_id: str, steps: int) -> None:
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET chat_steps=?, updated_at=? WHERE session_id=?",
            (int(steps), _now(), session_id),
        )
        conn.commit()


def set_chat_full_access(session_id: str, full_access: bool) -> None:
    """设置会话执行权限：True=全部执行（工具全开）；False=普通模式（受限工具）。"""
    conn = get_conn()
    with _lock:
        conn.execute(
            "UPDATE chat_sessions SET full_access=?, updated_at=? WHERE session_id=?",
            (1 if full_access else 0, _now(), session_id),
        )
        conn.commit()
