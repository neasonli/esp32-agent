"""L-CODE Agent 内核 API（阶段2 W2）。

- POST /api/run_task         提交开发任务（线程池并发执行）
- POST /api/cancel_task      取消任务（节点执行前检查）
- POST /api/resume_task      断点续跑（节点级默认 / full_restart 任务级重跑）
- GET  /api/get_result       查询任务结果（含 Token 用量汇总 + 产物清单）
- GET  /api/events           增量事件（桌面网关 500ms 轮询 → 流式日志）
- GET  /api/conversations    会话记录列表（V1.5 4.2.2）
- GET  /api/conversation     单会话详情（任务+事件+结果）
- GET  /api/workspace_files  工程文件树（V1.5 4.2.1，防目录穿越）
- GET  /api/workspace_file   读取文件内容（防目录穿越）
- GET  /api/workspace_export 导出目录为 zip（W2 补全，防目录穿越）
- POST /api/config           热更新 LLM 配置 + 并发数（W2 补全）
- GET  /api/config           查询当前配置（含并发数）
- GET  /api/health           健康检查 + 环境状态
- GET  /api/workspaces       工作区列表
- POST /api/shutdown         优雅退出

鉴权：kernel_mode 且配置了 kernel_token 时，所有请求必须携带
X-Kernel-Token 请求头（桌面网关启动时 --token 传入）。
"""
import io
import json
import os
import threading
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agent.graph import CancelledError, build_graph
from config.llm_config import adapter
from config.settings import settings
from db import task_store

app = FastAPI(
    title="L-CODE Agent 内核",
    description="对话式 Agent：自由聊天 + 工具调用（git/shell/编译/烧录）+ 固定流水线模式",
    version="0.3.0-kernel",
)

# 任务并发执行器（S4：默认 2，可调 1~4）
_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()


def _get_executor() -> ThreadPoolExecutor:
    """获取线程池；并发数变化时重建（旧池排空不取消，新任务走新池）。"""
    global _executor
    with _executor_lock:
        workers = max(1, min(settings.kernel_concurrency, 4))
        if _executor is None or _executor._max_workers != workers:
            if _executor is not None:
                # 不取消：已入队的任务继续在旧池跑完，避免调整并发丢任务
                _executor.shutdown(wait=False, cancel_futures=False)
            _executor = ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="agent-task",
            )
    return _executor


class RunTaskRequest(BaseModel):
    user_requirement: str = Field(..., min_length=3, description="用户产品需求")
    workspace_id: str = Field(default="", description="工作区 ID（迭代已有工程）")


class CancelTaskRequest(BaseModel):
    task_id: str


class DeleteTasksRequest(BaseModel):
    task_ids: list[str] = Field(..., min_length=1, description="要删除的任务ID列表")


class ResumeTaskRequest(BaseModel):
    task_id: str
    full_restart: bool = Field(default=False, description="True=任务级重跑（从头）")


class ConfigRequest(BaseModel):
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None
    llm_temperature: float | None = None
    kernel_concurrency: int | None = Field(default=None, ge=1, le=4, description="任务并发数（W2 补全，S4）")
    # ESP-IDF 编译环境（桌面端设置页可改；热更新后立即生效，无需重启内核）
    idf_path: str | None = None
    idf_tools_path: str | None = None
    idf_python_env_path: str | None = None
    idf_target: str | None = None


class ChatRequest(BaseModel):
    session_id: str = Field(default="", description="对话会话 ID；空 = 新建会话")
    message: str = Field(..., min_length=1, max_length=4000, description="用户消息/命令")
    cwd: str = Field(default="", description="新建会话时的工作目录（默认内核 outputs 目录）")
    full_access: bool | None = Field(default=None, description="新建会话时的执行权限（默认全部执行）")


# ---------------------------------------------------------------- 鉴权中间件
@app.middleware("http")
async def kernel_token_auth(request: Request, call_next):
    """内核模式下校验 X-Kernel-Token（未配置 token 时放行，便于开发调试）。"""
    if settings.kernel_mode and settings.kernel_token:
        token = request.headers.get("X-Kernel-Token", "")
        if token != settings.kernel_token:
            return JSONResponse({"detail": "无效的令牌"}, status_code=401)
    return await call_next(request)


# ---------------------------------------------------------------- 任务执行
def _invoke_graph(
    task_id: str, requirement: str, thread_id: str, workspace_id: str = "", resume: bool = False
) -> dict:
    """以指定 thread_id 调用状态机。

    resume=False：新任务，传入初始状态。
    resume=True：传入 None，LangGraph 从该 thread 的 checkpoint 继续（节点级续跑）。
    """
    graph = build_graph()  # kernel_mode 下自动启用 SqliteSaver checkpointer
    config = {"configurable": {"thread_id": thread_id}}
    if resume:
        return graph.invoke(None, config=config)
    init = {"task_id": task_id, "user_requirement": requirement}
    if workspace_id:
        init["workspace_id"] = workspace_id
    return graph.invoke(init, config=config)


def _run_agent_task(
    task_id: str, requirement: str, thread_id: str | None = None, workspace_id: str = "", resume: bool = False
) -> None:
    """后台执行 LangGraph 状态机（线程池中运行）。"""
    task_store.add_event(task_id, "INFO", f"任务开始执行：{requirement[:60]}")
    task_store.update_task(task_id, status=task_store.STATUS_RUNNING)
    task_store.add_event(task_id, "INFO", "Agent 状态机启动", node="agent")
    thread_id = thread_id or task_id
    try:
        result = _invoke_graph(task_id, requirement, thread_id, workspace_id, resume)
        payload = _build_payload(result)
        status = task_store.STATUS_SUCCESS if payload["compile_success"] else task_store.STATUS_FAILED
        task_store.update_task(
            task_id,
            status=status,
            chip_model=payload["chip_model"],
            project_dir=payload["project_dir"],
            result_json=json.dumps(payload, ensure_ascii=False),
            error_msg="" if payload["compile_success"] else (result.get("last_error") or "编译未通过"),
        )
        # 7.5：产物就绪收尾事件（附路径与文件清单），成功时必有
        if status == task_store.STATUS_SUCCESS and payload["artifacts"]:
            arts = "、".join(a["name"] for a in payload["artifacts"])
            task_store.add_event(
                task_id, "INFO", f"产物就绪：{payload['project_dir']}\\build\\（{arts}）", node="agent"
            )
        # D11：工程自动登记为工作区（供"继续优化"复用）
        if payload["project_dir"]:
            ws_id = workspace_id or task_id
            task_store.create_workspace(ws_id, payload["project_dir"], payload["chip_model"])
            task_store.update_workspace(ws_id, chip=payload["chip_model"], history_item=requirement[:60])
        task_store.add_event(
            task_id,
            "INFO" if status == task_store.STATUS_SUCCESS else "ERROR",
            "任务完成，编译通过" if status == task_store.STATUS_SUCCESS else "任务失败，编译未通过",
            node="agent",
        )
    except CancelledError:
        task_store.add_event(task_id, "WARN", "任务已取消", node="agent")
        task_store.update_task(task_id, status=task_store.STATUS_CANCELED)
    except Exception as e:  # noqa: BLE001 - 后台任务统一兜底
        task_store.add_event(task_id, "ERROR", f"任务异常：{e}", node="agent")
        task_store.update_task(task_id, status=task_store.STATUS_FAILED, error_msg=str(e))


def _build_payload(result: dict) -> dict:
    payload = {
        "chip_model": result.get("chip_model", ""),
        "project_dir": result.get("project_dir", ""),
        "compile_success": result.get("compile_success", False),
        "compile_error_type": (
            result.get("compile_error_type", "").value
            if hasattr(result.get("compile_error_type"), "value") else result.get("compile_error_type", "")
        ),
        "retry_times": result.get("retry_times", 0),
        "final_result": result.get("final_result", ""),
        "firmware_code": result.get("firmware_code", ""),
        "compile_log_tail": (result.get("compile_log") or "")[-2000:],
        "artifacts": task_store.collect_artifacts(result.get("project_dir", "")) if result.get("project_dir") else [],
    }
    return payload


# ---------------------------------------------------------------- 生命周期
@app.on_event("startup")
def _startup() -> None:
    task_store.init_db()
    recovered = task_store.recover_running_tasks()
    if recovered:
        print(f"[startup] 恢复 {recovered} 个中断任务 → INTERRUPTED")
    mode = "kernel(鉴权)" if (settings.kernel_mode and settings.kernel_token) else "standalone"
    print(f"[kernel] 模式={mode} 端口={settings.port} 并发={settings.kernel_concurrency}")


@app.on_event("shutdown")
def _shutdown() -> None:
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------- API
@app.post("/api/run_task")
def run_task(req: RunTaskRequest):
    """提交开发任务。线程池并发执行（默认 2 路）。"""
    task_id = task_store.create_task(req.user_requirement)
    task_store.add_event(task_id, "INFO", "任务已提交，进入队列")
    _get_executor().submit(_run_agent_task, task_id, req.user_requirement, None, req.workspace_id)
    return {"task_id": task_id, "status": task_store.STATUS_PENDING}


# ---------------------------------------------------------------- 对话式 Agent（阶段2 W3）
@app.post("/api/chat")
def chat(req: ChatRequest):
    """发送一条消息/命令到对话会话（可新建会话）。

    会话内串行执行（同一会话同时只能处理一条）；不同会话可并行。
    事件流：/api/events?task_id={session_id}（工具调用过程 + 最终回复）。
    消息历史：/api/chat_session?session_id=...
    """
    from agent.chat_agent import run_chat_turn

    if req.session_id:
        sess = task_store.get_chat_session(req.session_id)
        if sess is None:
            raise HTTPException(status_code=404, detail="会话不存在")
        if sess["status"] == "running":
            raise HTTPException(status_code=409, detail="会话正在执行中，请稍候")
        session_id = req.session_id
        if sess["waiting_confirm"]:
            # 每 100 轮暂停确认：用户发来任何消息都视为"继续"，清除标志后接着跑
            # （新消息会进入上下文；想停止请调 /api/chat_cancel）
            task_store.set_waiting_confirm(req.session_id, False)
    else:
        cwd = req.cwd or str(settings.outputs_dir_resolved)
        full_access = True if req.full_access is None else req.full_access
        session_id = task_store.create_chat_session(cwd=cwd, full_access=full_access)
        # 工作区 git 化（会话 checkpoint 兜底；eligible 目录才 init，失败静默）
        _ensure_session_git(session_id, cwd)

    _get_executor().submit(run_chat_turn, session_id, req.message)
    return {"session_id": session_id, "status": "running"}


@app.get("/api/chat_sessions")
def chat_sessions(limit: int = 50):
    """对话会话列表（标题/状态/消息数）。"""
    return {"sessions": task_store.list_chat_sessions(limit=limit)}


@app.get("/api/chat_session")
def chat_session(session_id: str):
    """单会话详情：基本信息 + 消息历史 + 最近事件。"""
    detail = task_store.get_chat_session_detail(session_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return detail


@app.post("/api/chat_cancel")
def chat_cancel(req: CancelTaskRequest):
    """请求停止正在执行的对话会话（幂等）。

    内核在每轮 LLM 调用前 / 每个工具执行前检查该标志；
    标志在会话回归 idle 时自动清除。
    """
    sess = task_store.get_chat_session(req.task_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    task_store.set_chat_cancel(req.task_id, True)
    return {"session_id": req.task_id, "status": "stop_requested"}


class ForkChatRequest(BaseModel):
    session_id: str = Field(..., description="源会话 ID")
    at_message_id: int = Field(..., description="分支锚点 chat_messages.id（复制该条及之前的全部消息前缀）")


@app.post("/api/chat_fork")
def chat_fork(req: ForkChatRequest):
    """在新对话中分支：以某条消息为锚点复制会话前缀开新会话（阶段4 W4 · 参考 DSH session.fork）。

    返回 {session_id: 新会话 ID}；新会话标题 = 源标题（分支），继承 cwd/full_access，
    状态 idle、消息 = 源会话 id<=at_message_id 的全部前缀（模型继续对话时前文可见）。
    """
    sess = task_store.get_chat_session(req.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess["status"] == "running":
        raise HTTPException(status_code=409, detail="会话正在执行中，请先停止再分支")
    new_id = task_store.fork_chat_session(req.session_id, req.at_message_id)
    if new_id is None:
        raise HTTPException(status_code=400, detail="锚点消息不存在（at_message_id 无效）")
    return {"session_id": new_id}


class DeleteChatSessionsRequest(BaseModel):
    session_ids: list[str] = Field(..., min_length=1, description="要删除的对话会话 ID 列表（不可恢复）")


@app.post("/api/chat_delete")
def chat_delete(req: DeleteChatSessionsRequest):
    """删除对话会话（含消息历史与事件，不可恢复）。"""
    if len(req.session_ids) > 200:
        raise HTTPException(status_code=400, detail="一次最多删除 200 个会话")
    deleted = task_store.delete_chat_sessions(req.session_ids)
    return {"deleted": deleted}


class ChatAccessRequest(BaseModel):
    session_id: str
    full_access: bool = Field(..., description="True=全部执行（工具全开）；False=普通模式（受限工具）")


# ---------------------------------------------------------------- 规划器协议（阶段3 Phase1）
class PlannerToolRequest(BaseModel):
    cwd: str = Field(default="", description="工具执行工作目录（默认内核 outputs 目录）")
    args: dict = Field(default_factory=dict, description="工具参数")
    full_access: bool = Field(default=True, description="执行权限（普通模式受限工具）")
    task_id: str = Field(default="", description="会话/任务 ID（工具侧底座事件落库用，§5.2 task_id=session_id）")
    sandbox: dict | None = Field(
        default=None,
        description="沙盒策略包 {mode, workspace_root, session_id}（V3.1 · 附录 D；"
        "规划器 ctx.sandboxPolicy.resolve() 产出，None=无策略等价 danger-full-access 旧行为）",
    )


class PlannerEventRequest(BaseModel):
    task_id: str
    level: str = Field(default="INFO", pattern="^(INFO|WARN|ERROR)$")
    message: str
    node: str = ""
    event_type: str = Field(default="", description="统一事件字典类型（§5.2：turn/start、tool/call、check/start、diagnostic…）")
    payload: dict | None = Field(default=None, description="结构化载荷（JSON）")


class PlannerChatMessageRequest(BaseModel):
    session_id: str
    role: str = Field(..., pattern="^(user|assistant|tool)$")
    content: str
    tool_name: str = ""
    tool_call_id: str = ""


class PlannerChatSessionRequest(BaseModel):
    session_id: str = Field(default="", description="空=内核生成；非空=规划器指定（三端同 ID）")
    cwd: str = ""
    full_access: bool = True
    title: str = ""


class PlannerChatStateRequest(BaseModel):
    session_id: str
    status: str | None = None
    waiting_confirm: bool | None = None
    chat_steps: int | None = None
    cancel_requested: bool | None = None
    full_access: bool | None = None


class PlannerFlashConfirmRequest(BaseModel):
    session_id: str
    project_dir: str
    port: str = ""


class PlannerFlashDismissRequest(BaseModel):
    session_id: str


class PlannerGitCheckpointRequest(BaseModel):
    session_id: str
    message: str = Field(default="session checkpoint", max_length=200)
    project_dir: str = Field(default="", description="可选：工程目录（相对 cwd 或绝对）；空=会话 cwd")


class PlannerGitRollbackRequest(BaseModel):
    session_id: str
    commit: str = Field(default="", description="空=回滚到上一 checkpoint")
    project_dir: str = Field(default="", description="可选：工程目录（相对 cwd 或绝对）；空=会话 cwd")


class PlannerGitStatusRequest(BaseModel):
    session_id: str
    project_dir: str = Field(default="", description="可选：工程目录（相对 cwd 或绝对）；空=会话 cwd")


@app.post("/api/planner/tool/{name}")
def planner_tool(name: str, req: PlannerToolRequest):
    """规划器工具透传：按名称调度内核工具（与对话模式同一权限检查，防目录穿越）。

    agent核心开发文档 §1.8：`POST /api/planner/tool/*` 底座工具透传。
    V3.1 · 附录 D：沙盒围栏（策略由规划器解析并随调用携带）——
    read-only 拒绝一切变更类工具；workspace-write 对 write_file/edit_file 校验目标在
    workspace/temp 根内；danger-full-access/缺省放行。拒绝文本与 DSH 逐字一致。
    """
    from agent.chat_agent import _check_access
    from tools.chat_tools import TOOL_HANDLERS, ToolContext
    from tools.sandbox_policy import (
        MUTATION_TOOLS,
        TARGET_TOOLS,
        SandboxDenied,
        enforce_write,
        mode_of,
    )

    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        return JSONResponse({"ok": False, "error": f"未知工具: {name}"}, status_code=404)
    cwd = req.cwd or str(settings.outputs_dir_resolved)
    ctx = ToolContext(cwd, task_id=req.task_id)
    mode = mode_of(req.sandbox)
    if mode is not None:
        ctx.sandbox = req.sandbox
    deny = _check_access(req.full_access, name, req.args, ctx)
    if deny:
        return {"ok": False, "denied": True, "error": deny}
    # ---- 沙盒围栏（V3.1 · 附录 D）----
    try:
        if mode == "read-only" and name in MUTATION_TOOLS:
            raise SandboxDenied(mode)
        if mode == "workspace-write" and name in TARGET_TOOLS:
            target = ctx.resolve(str((req.args or {}).get("path", "")))
            enforce_write(req.sandbox, str(target))
    except ValueError as e:
        return {"ok": False, "error": f"[错误] {e}"}
    except SandboxDenied as e:
        return {"ok": False, "sandbox_denied": True, "sandbox_mode": e.mode, "error": str(e)}
    try:
        result = handler(req.args, ctx)
    except SandboxDenied as e:
        return {"ok": False, "sandbox_denied": True, "sandbox_mode": e.mode, "error": str(e)}
    except Exception as e:  # noqa: BLE001 - 工具异常统一回传规划器
        return {"ok": False, "error": f"工具 {name} 执行异常: {e}"}
    return {"ok": True, "result": result}


@app.post("/api/planner/event")
def planner_event(req: PlannerEventRequest):
    """规划层事件写入 events 表（task_id=session_id，桌面 500ms 轮询不变）。

    event_type/payload 按 agent核心开发文档 §5.2 统一事件字典落库。
    """
    task_store.add_event(
        req.task_id, req.level, req.message, req.node, req.event_type, req.payload
    )
    return {"status": "ok"}


@app.post("/api/planner/chat_message")
def planner_chat_message(req: PlannerChatMessageRequest):
    """规划层消息落库（chat_messages 表，UI 聊天历史不变）。"""
    task_store.append_chat_message(req.session_id, req.role, req.content, req.tool_name, req.tool_call_id)
    return {"status": "ok"}


@app.post("/api/planner/chat_session")
def planner_chat_session(req: PlannerChatSessionRequest):
    """upsert 会话；session_id 为空时由内核生成（规划器/内核/桌面三端同 ID）。"""
    if req.session_id:
        task_store.create_chat_session_with_id(req.session_id, req.cwd, req.title, req.full_access)
        if req.title:
            task_store.update_chat_session(req.session_id, title=req.title)
        if req.cwd:
            task_store.update_chat_session(req.session_id, cwd=req.cwd)
        task_store.set_chat_full_access(req.session_id, req.full_access)
        session_id = req.session_id
        _ensure_session_git(session_id, req.cwd or str(settings.outputs_dir_resolved))
    else:
        session_id = task_store.create_chat_session(req.cwd, req.title, req.full_access)
        _ensure_session_git(session_id, req.cwd or str(settings.outputs_dir_resolved))
    sess = task_store.get_chat_session(session_id) or {}
    return {
        "session_id": session_id,
        "cwd": sess.get("cwd", ""),
        "full_access": bool(sess.get("full_access", 1)),
    }


@app.post("/api/planner/chat_state")
def planner_chat_state(req: PlannerChatStateRequest):
    """同步会话状态字段（只更新传入的字段）。"""
    if req.status is not None:
        task_store.set_chat_session_status(req.session_id, req.status)
    if req.waiting_confirm is not None:
        task_store.set_waiting_confirm(req.session_id, req.waiting_confirm)
    if req.chat_steps is not None:
        task_store.set_chat_steps(req.session_id, req.chat_steps)
    if req.cancel_requested is not None:
        task_store.set_chat_cancel(req.session_id, req.cancel_requested)
    if req.full_access is not None:
        task_store.set_chat_full_access(req.session_id, req.full_access)
    return {"status": "ok"}


def _run_flash(session_id: str, project_dir: str, port: str) -> None:
    """后台执行显式烧录（会话确认后；事件走 events 表，桌面轮询不变）。"""
    from tools.chat_tools import IDF_FLASH_TIMEOUT, _extract_error_summary
    from tools.compile_tool import run_idf

    extra_env = {"ESPPORT": port} if port else {}
    task_store.add_event(
        session_id, "INFO",
        f"开始烧录：{project_dir}" + (f"（端口 {port}）" if port else "（自动探测端口）"),
        "flash", "flash/start", {"project_dir": project_dir, "port": port},
    )
    log, ok = run_idf(
        str(project_dir), ["-B", "build", "flash"], timeout=IDF_FLASH_TIMEOUT, extra_env=extra_env
    )
    if ok:
        task_store.add_event(session_id, "INFO", "✅ 烧录完成", "flash", "flash/end", {"ok": True})
    else:
        summary = _extract_error_summary(log)
        body = f"{summary}\n\n【日志尾部】\n{log[-2500:]}" if summary else log[-2500:]
        task_store.add_event(
            session_id, "ERROR", f"❌ 烧录失败（请检查开发板连接与端口）\n{body}",
            "flash", "flash/end", {"ok": False},
        )
    task_store.set_pending_flash(session_id, None)
    task_store.set_chat_session_status(session_id, "idle")


@app.post("/api/planner/flash_confirm")
def planner_flash_confirm(req: PlannerFlashConfirmRequest):
    """会话确认结束后显式启动烧录（防误烧，agent核心开发文档 §0.6/§8 Phase 2）。

    仅当会话存在对应待烧录登记（project_dir 一致）时执行；烧录在后台线程运行，
    flash/start → 输出 → flash/end 事件经 events 表回流桌面（500ms 轮询不变）。
    """
    sess = task_store.get_chat_session(req.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    pending = task_store.get_pending_flash(req.session_id)
    if not pending or pending.get("project_dir") != req.project_dir:
        raise HTTPException(
            status_code=409,
            detail="待烧录登记不存在或工程不匹配，请先在对话中发起烧录",
        )
    if not Path(req.project_dir).joinpath("build").exists():
        raise HTTPException(status_code=400, detail=f"尚未编译（无 build 目录）: {req.project_dir}")
    task_store.set_pending_flash(req.session_id, None)
    task_store.set_chat_session_status(req.session_id, "running")
    _get_executor().submit(_run_flash, req.session_id, req.project_dir, req.port.strip())
    return {"session_id": req.session_id, "status": "flashing"}


@app.post("/api/planner/flash_dismiss")
def planner_flash_dismiss(req: PlannerFlashDismissRequest):
    """取消待烧录（清除登记，不执行烧录）。"""
    sess = task_store.get_chat_session(req.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    task_store.set_pending_flash(req.session_id, None)
    task_store.add_event(
        req.session_id, "WARN", "已取消待烧录（未执行）", "flash", "flash/cancelled"
    )
    return {"session_id": req.session_id, "status": "cancelled"}


# ---------------------------------------------------------------- 工作区 git 会话 checkpoint（阶段3 Phase3）

def _session_cwd(session_id: str) -> str:
    """取会话工作目录（cwd）；会话不存在抛 404。"""
    sess = task_store.get_chat_session(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return sess.get("cwd") or str(settings.outputs_dir_resolved)


def _resolve_project(req_path: str, base: str) -> str:
    """把请求里的工程目录（相对 cwd/绝对）解析为绝对路径；越界 403。"""
    from pathlib import Path

    base_p = Path(base).resolve()
    raw = req_path or base
    p = Path(raw)
    if not p.is_absolute():
        p = base_p / p
    p = p.resolve()
    try:
        p.relative_to(base_p)
    except ValueError:
        raise HTTPException(status_code=403, detail="路径越界（仅允许工作区内）") from None
    return str(p)


def _ensure_session_git(session_id: str, cwd: str) -> None:
    """会话创建时的工作区 git 化兜底（阶段3 Phase3 §8）：best-effort，失败不阻断会话。"""
    try:
        from tools.git_safe import ensure_session_git as _ensure

        result = _ensure(cwd, message=f"session {session_id} baseline")
        if result.get("created"):
            task_store.add_event(
                session_id, "INFO",
                f"工作区已 git 化（{result.get('root', '')}）",
                "base", "git/checkpoint",
                {"root": result.get("root", ""), "action": "init"},
            )
    except Exception as e:  # noqa: BLE001 - git 兜底失败不影响会话可用
        print(f"[kernel] 会话 git 化跳过（{e!r}）", flush=True)


@app.post("/api/planner/git_checkpoint")
def planner_git_checkpoint(req: PlannerGitCheckpointRequest):
    """会话 checkpoint：工作区 git 化 + add/commit（agent核心开发文档 §8 Phase 3）。

    - 仓库根解析：project_dir 显式指定 → 该工程；否则会话 cwd（仅当它是工程根/已 git 化）；
    - 只对 eligible 工作区自动 git 化（outputs 内 / 已是仓库），容器根/用户目录返回
      eligible=False（不强制 git init）；
    - 有变更才产生提交（commit 字段），无变更 commit=null（不产生空提交）；
    - 落 git/checkpoint 事件（payload 带 commit），桌面轮询可见。
    """
    from tools.git_safe import snapshot_session

    base = _session_cwd(req.session_id)
    cwd = _resolve_project(req.project_dir, base)
    snap = snapshot_session(cwd, req.message, file_path=None)
    if snap.get("repo") and snap.get("commit"):
        task_store.add_event(
            req.session_id, "INFO",
            f"git checkpoint：{snap['commit']}（{req.message[:60]}）",
            "base", "git/checkpoint",
            {"commit": snap["commit"], "root": snap.get("root", ""), "message": req.message},
        )
    return {"session_id": req.session_id, **snap}


@app.post("/api/planner/git_rollback")
def planner_git_rollback(req: PlannerGitRollbackRequest):
    """会话回滚（显式端点，用户触发）：把工作区回滚到指定/上一 checkpoint。

    project_dir 显式指定 → 该工程；否则会话 cwd。`--hard` 语义会丢弃工作区未提交修改——
    必须在桌面 UI 显式确认后调用，不做对话中自动回滚。
    """
    from tools.git_safe import rollback_session

    base = _session_cwd(req.session_id)
    cwd = _resolve_project(req.project_dir, base)
    text, ok = rollback_session(cwd, req.commit or None)
    task_store.add_event(
        req.session_id, "WARN" if ok else "ERROR", text, "base", "git/rollback"
    )
    return {"session_id": req.session_id, "ok": ok, "message": text}


@app.post("/api/planner/git_status")
def planner_git_status(req: PlannerGitStatusRequest):
    """只读：会话工作区 git 状态（repo/root/head/dirty），供桌面「回滚」入口展示。"""
    from tools.git_safe import repo_info

    base = _session_cwd(req.session_id)
    cwd = _resolve_project(req.project_dir, base)
    return {"session_id": req.session_id, **repo_info(cwd)}


@app.get("/api/planner/info")
def planner_info():
    """规划器读取内核信息（默认工作目录 / LLM / IDF）。"""
    return {
        "outputs_dir": str(settings.outputs_dir_resolved),
        "llm_model": adapter.model,
        "llm_base_url": adapter.base_url,
        "idf_path": settings.idf_path,
        "idf_target": settings.idf_target,
    }


@app.post("/api/chat_access")
def chat_access(req: ChatAccessRequest):
    """切换会话执行权限：全部执行 / 普通模式（W3，类 DeepSeek Harness 的 Full Access）。"""
    sess = task_store.get_chat_session(req.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    task_store.set_chat_full_access(req.session_id, req.full_access)
    return {
        "session_id": req.session_id,
        "full_access": req.full_access,
        "mode": "full" if req.full_access else "normal",
    }


@app.post("/api/cancel_task")
def cancel_task(req: CancelTaskRequest):
    """请求取消任务（幂等）：设置标志，节点执行前检查。"""
    task = task_store.get_task(req.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    task_store.request_cancel(req.task_id)
    return {"task_id": req.task_id, "status": "cancel_requested"}


@app.post("/api/delete_tasks")
def delete_tasks(req: DeleteTasksRequest):
    """批量删除任务（含工程目录与关联数据；运行中/排队中任务跳过）。"""
    if len(req.task_ids) > 200:
        raise HTTPException(status_code=400, detail="一次最多删除 200 个任务")
    return task_store.delete_tasks(req.task_ids)


@app.post("/api/resume_task")
def resume_task(req: ResumeTaskRequest):
    """断点续跑：默认节点级（同 thread_id 从 checkpoint 继续）；full_restart 从头重跑。"""
    task = task_store.get_task(req.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    requirement = task["user_requirement"]
    task_store.reset_cancel(req.task_id)  # 清除旧取消标志
    task_store.update_task(req.task_id, status=task_store.STATUS_PENDING, error_msg="")
    thread_id = req.task_id if not req.full_restart else f"{req.task_id}_restart_{uuid.uuid4().hex[:8]}"
    _get_executor().submit(
        _run_agent_task, req.task_id, requirement, thread_id, "", resume=not req.full_restart
    )
    return {"task_id": req.task_id, "status": task_store.STATUS_PENDING, "resume": "node" if not req.full_restart else "full"}


@app.get("/api/get_result")
def get_result(task_id: str):
    """查询任务结果（含 Token 用量汇总 + 产物清单）。"""
    task = task_store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    result = dict(task)
    result["usage"] = task_store.get_usage_summary(task_id)
    return result


@app.get("/api/events")
def get_events(task_id: str, after_seq: int = 0, limit: int = 500):
    """增量拉取任务事件（seq > after_seq），桌面网关轮询实现流式日志。"""
    events = task_store.get_events(task_id, after_seq=after_seq, limit=limit)
    return {"task_id": task_id, "events": events}


@app.post("/api/config")
def update_config(req: ConfigRequest):
    """热更新配置（阶段2 W2：设置面板调用，无需重启）。

    - LLM 配置 → adapter.reconfigure
    - kernel_concurrency → 更新 settings 并重建线程池（旧池排空）
    - ESP-IDF（idf_path / idf_tools_path / idf_python_env_path / idf_target）→ 更新 settings，
      编译节点每次执行时都会重新读 settings（见 tools/compile_tool.py），因此立即生效
    """
    if req.llm_base_url is not None or req.llm_api_key is not None or req.llm_model is not None or req.llm_temperature is not None:
        adapter.reconfigure(
            base_url=req.llm_base_url,
            api_key=req.llm_api_key,
            model=req.llm_model,
            temperature=req.llm_temperature,
        )
    if req.kernel_concurrency is not None:
        settings.kernel_concurrency = max(1, min(req.kernel_concurrency, 4))
        _get_executor()  # 触发重建（若变化）
    if req.idf_path is not None:
        settings.idf_path = req.idf_path.strip()
    if req.idf_tools_path is not None:
        settings.idf_tools_path = req.idf_tools_path.strip()
    if req.idf_python_env_path is not None:
        settings.idf_python_env_path = req.idf_python_env_path.strip()
    if req.idf_target is not None and req.idf_target.strip():
        settings.idf_target = req.idf_target.strip()
    return {
        "status": "ok",
        "model": adapter.model,
        "base_url": adapter.base_url,
        "kernel_concurrency": settings.kernel_concurrency,
        **_idf_config(),
    }


def _idf_config() -> dict:
    """ESP-IDF 相关配置快照（供设置页回填/展示）。"""
    from tools.compile_tool import find_idf_py

    return {
        "idf_path": settings.idf_path,
        "idf_tools_path": settings.idf_tools_path,
        "idf_python_env_path": settings.idf_python_env_path,
        "idf_target": settings.idf_target,
        "idf_py": find_idf_py(),
    }


@app.get("/api/config")
def get_config():
    """查询当前配置（LLM + 并发数 + ESP-IDF）。"""
    return {
        "llm_model": adapter.model,
        "llm_base_url": adapter.base_url,
        # 服务端实际服务的模型：与 llm_model 不同 = 当前用的是别名（如 deepseek-chat → deepseek-flash）
        "llm_served_model": adapter.served_model,
        "kernel_concurrency": settings.kernel_concurrency,
        **_idf_config(),
    }


# 常见厂商的模型预置清单（仅在端点不支持 GET /models 时兜底；能拉取时以端点为准）。
# 说明：L-CODE 的 base_url 是用户可配的任意 OpenAI 兼容端点，所以没有 DSH 那种
# "适配器里写死的模型目录"——改成"优先问端点，端点答不上来才用这份兜底"。
_LLM_MODEL_PRESETS: dict[str, list[str]] = {
    "api.deepseek.com": ["deepseek-chat", "deepseek-reasoner"],
    "api.openai.com": ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
    "dashscope.aliyuncs.com": ["qwen-max", "qwen-plus", "qwen-turbo"],
}


@app.get("/api/llm/models")
def llm_models():
    """列出当前 LLM 端点可用的模型（OpenAI 兼容 `GET /models`）。

    设置页「获取模型列表」按钮用它把"手填模型名"变成"下拉选择"：
    - `source=endpoint`：端点真的返回了清单（最权威；Ollama 之类只会列出本地已拉取的模型）
    - `source=preset`  ：端点不支持/请求失败 → 回退到常见厂商预置清单，`note` 里说明原因
    - `source=none`    ：既拿不到也没有预置（本地端点未启动等情况），界面提示手动填写
    """
    from urllib.parse import urlparse

    from openai import OpenAI

    out: dict = {
        "base_url": adapter.base_url,
        "current": adapter.model,
        "models": [],
        "endpoint_models": [],
        "current_from_endpoint": True,
        "source": "",
        "note": "",
    }
    try:
        client = OpenAI(
            base_url=adapter.base_url,
            api_key=adapter.api_key or "EMPTY",
            timeout=15.0,
            max_retries=0,
        )
        ids = sorted({str(m.id) for m in client.models.list().data if getattr(m, "id", None)})
        if ids:
            out["endpoint_models"] = ids
            out["models"] = list(ids)
            out["source"] = "endpoint"
        else:
            out["note"] = "端点返回了空列表"
    except Exception as exc:  # noqa: BLE001 — 拿不到列表不是错误，回退即可
        out["note"] = f"{type(exc).__name__}: {exc}"

    if out["source"] != "endpoint":
        host = urlparse(adapter.base_url).netloc.lower()
        for key, preset in _LLM_MODEL_PRESETS.items():
            if key in host:
                out["models"] = list(preset)
                out["source"] = "preset"
                break
        if not out["models"]:
            out["source"] = "none"
            out["note"] = out["note"] or "无法从端点获取模型列表（本地端点请确认服务已启动）"

    # 当前配置的模型永远要出现在可选项里（否则用户一保存就被改掉）。
    # 实测：DeepSeek 的 /models 只登记规范模型（deepseek-flash / deepseek-v4-pro），
    # 而 deepseek-chat / deepseek-reasoner / deepseek-v4-flash 都是**可用但未登记**的别名
    # （都解析到 deepseek-flash）——所以"当前值不在清单里"完全正常，界面要把它标出来，
    # 别让用户以为后端多检测出了一个模型。
    if adapter.model:
        if adapter.model in out["models"]:
            out["current_from_endpoint"] = True
        else:
            out["models"].insert(0, adapter.model)
            out["current_from_endpoint"] = False
    return out


@app.get("/api/llm/probe")
def llm_probe(model: str | None = None):
    """测试 LLM 连通性 + 暴露"实际服务模型"（设置页「测试连接」按钮）。

    做一次极小的真实调用（max_tokens=1，由适配器实现）。之所以要暴露 served_model：
    DeepSeek 端点会接受一批**未登记的别名**（deepseek-chat / deepseek-reasoner /
    deepseek-v4-flash 目前都解析到 deepseek-flash），只看配置的模型名会误判能力档位。
    """
    return adapter.probe(model)


@app.get("/api/env_probe")
def env_probe(deep: bool = False):
    """ESP-IDF 环境检测（设置页「检测」按钮）。

    - 浅检测（deep=false，毫秒级）：解析 idf.py 路径 + 检查 IDF_PATH / 工具目录 / 导出脚本是否存在；
    - 深检测（deep=true）：真跑一次 `idf.py --version`（要几秒~几十秒，需已安装工具链），
      返回版本号与输出尾部，用于确认工具链真的可用。
    """
    import subprocess

    from tools.compile_tool import _build_env, _idf_python, find_idf_py

    idf_root = Path(settings.idf_path) if settings.idf_path else None
    tools_root = Path(settings.idf_tools_path) if settings.idf_tools_path else None
    export_name = "export.bat" if os.name == "nt" else "export.sh"
    out: dict = {
        **_idf_config(),
        "idf_path_exists": bool(idf_root and idf_root.exists()),
        "export_script": str(idf_root / export_name) if idf_root else "",
        "export_script_exists": bool(idf_root and (idf_root / export_name).exists()),
        "idf_tools_path_exists": bool(tools_root and tools_root.exists()),
        "python_env_exists": bool(
            settings.idf_python_env_path and Path(settings.idf_python_env_path).exists()
        ),
        "ok": bool(find_idf_py()),
        "deep": bool(deep),
        "idf_version": "",
        "probe_log": "",
    }
    if not out["ok"] and not settings.idf_path:
        out["hint"] = "未找到 idf.py：请在设置页填写 ESP-IDF 目录（含 export.bat/export.sh 的那一层）"
    elif not out["ok"]:
        out["hint"] = f"IDF_PATH 下没找到 tools/idf.py：{settings.idf_path}"

    if deep:
        idf_py = find_idf_py()
        if not idf_py:
            out["probe_log"] = "跳过深检测：未找到 idf.py"
            return out
        try:
            proc = subprocess.run(
                [_idf_python(), idf_py, "--version"],
                env=_build_env(),
                capture_output=True,
                text=True,
                timeout=120,
            )
            text = ((proc.stdout or "") + (proc.stderr or "")).strip()
            out["probe_log"] = text[-2000:]
            out["idf_version"] = text.splitlines()[0] if text else ""
            out["ok"] = proc.returncode == 0 or bool(out["idf_version"])
            if not out["ok"]:
                out["hint"] = "idf.py --version 执行失败：检查 IDF_TOOLS_PATH / IDF_PYTHON_ENV_PATH 是否正确"
        except Exception as exc:  # noqa: BLE001 — 检测失败不该 500，把原因回给界面
            out["probe_log"] = f"{type(exc).__name__}: {exc}"
            out["hint"] = "深检测异常（多为工具链未安装或路径不对）"
    return out


@app.get("/api/workspaces")
def workspaces():
    """工作区列表（D11）。"""
    return {"workspaces": task_store.list_workspaces()}


# ---------------------------------------------------------------- 工程源码浏览（V1.5 4.2.1）
def _safe_resolve(raw: str) -> Path:
    """将相对/绝对路径解析到 outputs 目录内，越界抛 403（防目录穿越）。"""
    base = settings.outputs_dir.resolve()
    target = (base / raw).resolve() if raw else base
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=403, detail="路径越界") from None
    return target


@app.get("/api/workspace_files")
def workspace_files(dir: str = ""):
    """列出工程目录内容（文件树）。dir 为空时列出 outputs 根（各工程）。"""
    target = _safe_resolve(dir)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")
    entries = []
    for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        try:
            size = p.stat().st_size if p.is_file() else 0
        except OSError:
            size = 0
        entries.append(
            {"name": p.name, "type": "dir" if p.is_dir() else "file", "size": size, "path": str(p)}
        )
    return {"path": str(target), "entries": entries}


@app.get("/api/workspace_file")
def workspace_file(path: str):
    """读取文件内容（文本，限 200KB）。"""
    target = _safe_resolve(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    size = target.stat().st_size
    if size > 200 * 1024:
        raise HTTPException(status_code=413, detail="文件过大（>200KB），请用外部编辑器打开")
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"无法读取文件：{e}") from e
    return {"path": str(target), "name": target.name, "size": size, "content": content}


@app.get("/api/workspace_export")
def workspace_export(dir: str = ""):
    """导出目录为 zip（W2 补全：4.2.1 '导出 zip' 入口）。

    - dir 为空 = 导出 outputs 根（或工作区根由网关 --outputs 决定）
    - 防目录穿越：复用 _safe_resolve
    - 跳过 build/ 与 .git（可再生成/体积大），其余全量打包
    """
    target = _safe_resolve(dir)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")

    buf = io.BytesIO()
    skip_dirs = {"build", ".git", "__pycache__", ".pio", "managed_components"}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os_walk_skip(target, skip_dirs):
            root_path = Path(root)
            rel_root = root_path.relative_to(target)
            for f in sorted(files):
                fp = root_path / f
                try:
                    zf.write(fp, (rel_root / f).as_posix())
                except OSError:
                    continue
    buf.seek(0)
    fname = f"{target.name or 'workspace'}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def os_walk_skip(root: Path, skip_dirs: set[str]):
    """os.walk 变体：按目录名剪枝（不进入被跳过目录）。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        yield dirpath, dirnames, filenames


# ---------------------------------------------------------------- 会话记录（V1.5 4.2.2）
@app.get("/api/conversations")
def conversations(limit: int = 50):
    """会话记录列表：任务卡片（需求→结果/状态/用量/产物）。"""
    tasks = task_store.list_tasks(limit=limit)
    items = []
    for t in tasks:
        usage = task_store.get_usage_summary(t["task_id"])
        artifacts = (
            task_store.collect_artifacts(t["project_dir"]) if t["project_dir"] else []
        )
        items.append(
            {
                "task_id": t["task_id"],
                "requirement": t["user_requirement"],
                "status": t["status"],
                "chip": t["chip_model"],
                "project_dir": t["project_dir"],
                "error_msg": t["error_msg"],
                "created_at": t["created_at"],
                "updated_at": t["updated_at"],
                "total_tokens": usage["total_tokens"],
                "artifacts": artifacts,
            }
        )
    return {"conversations": items}


@app.get("/api/conversation")
def conversation(task_id: str):
    """单会话详情：任务 + 事件流 + 结果 + 用量。"""
    task = task_store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    result = dict(task)
    result["usage"] = task_store.get_usage_summary(task_id)
    result["events"] = task_store.get_events(task_id, after_seq=0, limit=2000)
    return result


@app.get("/api/health")
def health():
    """健康检查 + 环境状态（含知识库后端：桌面端据此提示"通用模式"）。"""
    from rag import status as kb_status
    from tools.compile_tool import find_idf_py

    llm_ok = bool(settings.llm_api_key) or any(
        k in settings.llm_base_url.lower() for k in ("localhost", "127.0.0.1", "ollama")
    )
    return {
        "status": "ok",
        "app": "L-CODE Kernel",
        "version": "0.2.0-kernel",
        "kernel_mode": settings.kernel_mode,
        "concurrency": settings.kernel_concurrency,
        "llm_configured": llm_ok,
        "llm_model": settings.llm_model,
        "embedding_model": settings.embedding_model,
        "idf_py": find_idf_py(),
        "idf_target": settings.idf_target,
        # kb_backend: private | stub；kb_available: 是否具备领域知识库检索能力
        **kb_status(),
    }


@app.post("/api/shutdown")
def shutdown():
    """优雅退出（桌面网关退出时调用）。"""
    task_store.add_event("SYSTEM", "INFO", "内核收到退出指令，正在停止")
    threading.Timer(0.5, _do_shutdown).start()
    return {"status": "shutting_down"}


def _do_shutdown() -> None:
    import os
    import signal

    os.kill(os.getpid(), signal.SIGTERM)
