"""对话式 Agent 执行循环（阶段2 W3）。

形态：用户自由对话/下达命令 → LLM 决定回复或调用工具（function calling）→
工具执行结果回填 → 循环，直到 LLM 给出最终回复。

- 会话记忆：user/assistant 文本消息持久化到 chat_messages；工具调用链
  （assistant tool_calls + tool 结果）也持久化，可跨轮次重建完整 OpenAI 消息序列。
- 事件：每轮对话写入 events 表（task_id = session_id），桌面端现有轮询即可展示。
- 并发：单会话串行（busy 锁），多会话可并行（走内核线程池）。
"""
import json
import threading

from config import context
from config.llm_config import adapter, clear_usage_context, set_usage_context
from config.settings import settings
from db import task_store
from tools.chat_tools import TOOL_DEFS, TOOL_HANDLERS, ToolContext

# 无限轮次：不再设硬上限；每 100 轮暂停并请求用户确认继续（弹窗/消息）
CONFIRM_EVERY_STEPS = 100    # 每执行这么多轮 LLM 调用，暂停请求确认
TOOL_RESULT_MAX = 3000         # 工具结果回传 LLM 的截断长度

# 环境事实注入（构建提示词时动态填充）：让 Agent 少走弯路（克隆整个 esp-idf、手工 export 等）
ENV_FACTS = """环境事实（务必利用，不要重复造轮子）：
- ESP-IDF 已安装在本机：{idf_path}（IDF_TARGET 默认 {idf_target}）
- IDF 自带大量示例工程：{idf_path}\\examples（如 get-started\\blink、get-started\\hello_world）
- 编译/烧录请直接用 build / flash 工具，它们内部会自动激活 ESP-IDF 环境（export.bat）并处理路径，
  不要用 shell 手动 call export.bat 或手动执行 idf.py（容易踩 Windows cmd 的坑）。
- 严禁 git clone 整个 esp-idf 仓库（几个 GB，且本机已安装）。拉取工程优先用 IDF 自带示例或小仓库。
- 这是 Windows cmd 环境：没有 tail/grep/sed 命令（用 findstr 代替）；不要用 Linux 命令。
"""

SYSTEM_PROMPT = """你是 L-CODE，运行在用户 Windows 电脑上的嵌入式固件开发助手。
你可以通过工具真正执行用户的命令：git 拉取工程、查看/修改文件、用 idf.py 编译固件、
把固件烧录到开发板、执行任意 shell 命令。

工作目录：{cwd}（所有相对路径都基于它）

{env_facts}
{access_rules}
行为规则：
1. 用户下达开发/操作类命令时，规划步骤并依次调用工具真正执行，不要只说不做。
2. 每完成一个关键步骤，用简短中文汇报结果（做了什么、成功与否）。
3. 工具失败时读取错误信息；能自动修复（如修改代码后重新编译）就修复，否则明确告诉用户原因。
4. 纯聊天/咨询类消息直接回答，不调用工具。
5. 烧录前确认端口；不确定端口时先列设备（如用 shell 执行 mode 或 dir）或让用户提供。
6. 涉及删除、覆盖、格式化等破坏性操作时，先向用户确认再执行。
7. 改源码首选 edit_file（exact-match：old_string→new_string，防静默乱改）；整文件新建/覆盖才用
   write_file；绝不用 shell/powershell 做文本替换（Windows 转义极易出错，已多次实测失败）。
8. 改完代码后（尤其 TS/ESP-IDF 工程）用 run_check 真实校验，把诊断作为下一步依据；
   build 失败后先读返回的诊断/【错误摘要】定位问题再动手，不要反复无脑重新编译。
9. 查找代码/引用用 glob（文件名）与 grep（内容正则），看工程结构用 file_tree / list_dir。
"""


def _session_lock(session_id: str) -> threading.Lock:
    """会话级串行锁（进程内字典）。"""
    if not hasattr(_session_lock, "locks"):
        _session_lock.locks = {}
    if session_id not in _session_lock.locks:
        _session_lock.locks[session_id] = threading.Lock()
    return _session_lock.locks[session_id]


def _check_access(full_access: bool, name: str, args: dict, ctx: ToolContext) -> str | None:
    """普通模式下的工具权限检查；返回拒绝原因（str）或 None（放行）。

    全部执行（full_access=True）：所有工具放行。
    普通模式：禁用 shell / flash；write_file 禁止覆盖已有文件。
    """
    if full_access:
        return None
    if name in ("shell", "flash"):
        return (
            f"[权限] 当前为普通模式，{name} 工具已禁用；"
            "可在聊天框下方切换为「全部执行」后重试。"
        )
    if name == "edit_file":
        # 底座工具集（阶段3 Phase2）：exact-match 编辑已有文件 → 普通模式禁用（同覆盖写）
        return (
            "[权限] 当前为普通模式，edit_file 工具已禁用（会修改已有文件）；"
            "可在聊天框下方切换为「全部执行」后重试。"
        )
    if name == "write_file":
        try:
            target = ctx.resolve(str(args.get("path", "")))
        except ValueError:
            return None
        if target.exists() and not bool(args.get("append")):
            return (
                f"[权限] 普通模式禁止覆盖已有文件 {target.name}；"
                "可在聊天框下方切换为「全部执行」后重试。"
            )
    return None


ACCESS_FULL = "权限：全部执行（Full Access）——你可以直接执行任意 shell 命令、覆盖写文件、git 拉取、编译、烧录固件到开发板。"
ACCESS_NORMAL = (
    "权限：普通模式（受限）——仅允许：读取/列目录/目录树（read_file、file_tree、list_dir）、"
    "搜索（glob、grep）、编译/校验（build、run_check）、git 拉取、新建文件（不覆盖已有文件）。\n"
    "禁止：执行任意 shell 命令（shell 工具被禁用）、烧录（flash 工具被禁用）、"
    "修改已有文件（write_file 覆盖与 edit_file 被禁用）。\n"
    "当用户要求这些操作时，明确告知需要切换到「全部执行」。"
)


def _build_system(cwd: str, full_access: bool = True) -> str:
    env_facts = ENV_FACTS.format(
        idf_path=settings.idf_path or "(未配置，需在 .env 设置 IDF_PATH)",
        idf_target=settings.idf_target,
    )
    access_rules = ACCESS_FULL if full_access else ACCESS_NORMAL
    return SYSTEM_PROMPT.format(cwd=cwd, env_facts=env_facts, access_rules=access_rules)


def _load_messages(session_id: str, cwd: str, full_access: bool) -> list[dict]:
    """从 DB 重建 OpenAI API 消息序列（system 由调用方拼接）。

    按 token 预算截断（config.context.history_budget_tokens），而不是固定条数：
    单条工具结果最长 3000 字符，60 条可能已超模型窗口；预算口径与
    task_store.get_chat_session_detail 的进度条估算完全一致。
    """
    from config import context

    budget = context.history_budget_tokens(cwd, full_access)
    rows = task_store.get_chat_messages_budgeted(session_id, budget)
    msgs: list[dict] = []
    for r in rows:
        role = r["role"]
        if role == "assistant" and r["tool_name"] == "__toolcalls__":
            try:
                payload = json.loads(r["content"])
            except Exception:  # noqa: BLE001
                continue
            tool_calls = payload.get("tool_calls") if isinstance(payload, dict) else payload
            content = payload.get("content") if isinstance(payload, dict) else None
            msgs.append(
                {"role": "assistant", "content": content, "tool_calls": tool_calls}
            )
        elif role == "tool":
            msgs.append(
                {
                    "role": "tool",
                    "tool_call_id": r["tool_call_id"],
                    "content": r["content"],
                }
            )
        else:
            msgs.append({"role": role, "content": r["content"]})
    return msgs


def _save_messages(session_id: str, api_messages: list[dict]) -> None:
    """把本次对话新增的 API 消息持久化（用户消息已单独持久化，跳过）。"""
    for m in api_messages:
        role = m["role"]
        try:
            if role == "user":
                continue
            if role == "assistant" and m.get("tool_calls"):
                task_store.append_chat_message(
                    session_id, "assistant",
                    json.dumps(
                        {"content": m.get("content"), "tool_calls": m["tool_calls"]},
                        ensure_ascii=False,
                    ),
                    tool_name="__toolcalls__",
                )
            elif role == "tool":
                task_store.append_chat_message(
                    session_id, "tool", m["content"],
                    tool_name=m.get("name", ""), tool_call_id=m.get("tool_call_id", ""),
                )
            else:
                task_store.append_chat_message(session_id, role, m.get("content", ""))
        except Exception as e:  # noqa: BLE001 - 单条消息失败不阻断整轮
            print(f"[chat] 消息持久化失败 role={role}: {e!r}", flush=True)


def _emit(session_id: str, level: str, message: str, node: str = "") -> None:
    task_store.add_event(session_id, level, message, node)


def run_chat_turn(session_id: str, user_message: str) -> None:
    """在后台线程执行一轮对话（可能含多次工具调用）。"""
    lock = _session_lock(session_id)
    with lock:
        task_store.set_chat_session_status(session_id, "running")
        sess = task_store.get_chat_session(session_id)
        if sess is None:
            return
        cwd = sess["cwd"] or str(settings.outputs_dir)
        full_access = bool(sess.get("full_access", 1))
        ctx = ToolContext(cwd, task_id=session_id)
        _emit(session_id, "INFO", user_message, node="user")

        # 首次消息 → 自动生成会话标题（首页胶囊默认标题 = 首条输入，最多 50 字）
        if not task_store.get_chat_messages(session_id, limit=1):
            title = user_message.strip().replace("\n", " ")[:50] or "新对话"
            task_store.update_chat_session(session_id, title=title)

        # 先加载历史（不含本条），再持久化本条并加入本次调用消息列表
        history = _load_messages(session_id, cwd, full_access)
        task_store.append_chat_message(session_id, "user", user_message)
        new_messages: list[dict] = [{"role": "user", "content": user_message}]

        set_usage_context(session_id, "chat")
        stopped = False
        step = task_store.get_chat_steps(session_id)  # 跨轮次累计（每 100 轮暂停确认）
        try:
            while True:
                # 用户主动停止：在每轮 LLM 调用前检查
                if task_store.is_chat_canceled(session_id):
                    stopped = True
                    break

                # 单轮上下文预算守卫：history 已按预算截断，但本轮 new_messages
                # 会随工具调用不断累积；若连同 system/tools 信封已接近窗口，继续调用
                # LLM 必然触发 context length 超限。此时先暂停请求确认，而不是硬撑。
                api_msgs = [*history, *new_messages]
                est_messages = sum(
                    context.estimate_message_tokens(json.dumps(m, ensure_ascii=False))
                    for m in api_msgs
                )
                if est_messages + context.estimate_envelope_tokens(cwd, full_access) \
                        >= context.window_tokens() - 2048:
                    budget_msg = (
                        "⏸ 本轮对话上下文已接近模型窗口上限，暂停执行。\n"
                        "建议：新建一个对话继续（历史记录仍可回看）；"
                        "或告诉我先总结已完成的部分。"
                    )
                    task_store.set_chat_steps(session_id, step)
                    try:
                        task_store.append_chat_message(session_id, "assistant", budget_msg)
                    except Exception as e:  # noqa: BLE001 - 消息失败不阻断（事件兜底）
                        print(f"[chat] 上下文提示消息写入失败: {e!r}", flush=True)
                    _emit(session_id, "WARN", budget_msg, node="agent")
                    break

                # LLM 请求可见性：绿色事件（UI 以 node=llm 显示为绿色）
                _emit(session_id, "INFO", f"正在请求 LLM（{adapter.model}）…", node="llm")
                content, tool_calls = adapter.chat_with_tools(
                    _build_system(cwd, full_access), api_msgs, TOOL_DEFS, max_tokens=4096
                )
                if tool_calls:
                    _emit(session_id, "INFO", f"LLM 响应完成，将执行 {len(tool_calls)} 个工具", node="llm")
                else:
                    _emit(session_id, "INFO", "LLM 响应完成", node="llm")

                if not tool_calls:
                    # 最终回复
                    final = content or "（完成）"
                    task_store.append_chat_message(session_id, "assistant", final)
                    _emit(session_id, "INFO", final, node="agent")
                    break

                # 记录 assistant 工具调用消息（OpenAI 协议要求：
                # 带 tool_calls 的 assistant 消息必须紧跟各 tool_call_id 的 tool 结果消息，
                # 文本说明放在同一消息的 content 字段，不能拆成独立消息）
                assistant_msg = {
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": json.dumps(tc["arguments"], ensure_ascii=False),
                            },
                        }
                        for tc in tool_calls
                    ],
                }
                new_messages.append(assistant_msg)

                # 逐个执行工具，结果回填（每个工具前检查停止）
                for idx, tc in enumerate(tool_calls):
                    if task_store.is_chat_canceled(session_id):
                        # 补齐未执行工具的占位结果，保证 OpenAI 消息链完整（tool_calls 后必须跟齐 tool 结果）
                        for rest in tool_calls[idx:]:
                            new_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": rest["id"],
                                    "name": rest["name"],
                                    "content": "[已由用户停止，未执行]",
                                }
                            )
                        stopped = True
                        break
                    name, args = tc["name"], tc["arguments"]
                    handler = TOOL_HANDLERS.get(name)
                    _emit(session_id, "INFO", f"▶ 执行工具 {name} {_args_preview(args)}", node=name)
                    deny = _check_access(full_access, name, args, ctx)
                    if deny:
                        result = deny
                        _emit(session_id, "WARN", deny, node=name)
                    else:
                        try:
                            result = handler(args, ctx) if handler else f"[错误] 未知工具: {name}"
                        except Exception as e:  # noqa: BLE001
                            result = f"[错误] 工具 {name} 执行异常: {e}"
                    new_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "name": name,
                            "content": result[:TOOL_RESULT_MAX],
                        }
                    )
                    _emit(session_id, "INFO", _result_preview(result), node=name)

                # 工具循环被用户停止 → 结束本轮
                if stopped:
                    break

                step += 1
                # 无限轮次：每 100 轮暂停，弹窗/消息请求用户确认（继续 or 停止）
                if step % 100 == 0:
                    task_store.set_chat_steps(session_id, step)
                    confirm_msg = (
                        f"⏸ 已连续执行 {step} 轮（工具调用），任务尚未完成。\n"
                        "是否继续？回复「继续」接着跑，或点击「停止」结束本轮。"
                    )
                    try:
                        task_store.append_chat_message(session_id, "assistant", confirm_msg)
                    except Exception as e:  # noqa: BLE001 - 消息失败不阻断（事件兜底）
                        print(f"[chat] 确认提示消息写入失败: {e!r}", flush=True)
                    _emit(session_id, "WARN", confirm_msg, node="agent")
                    task_store.set_waiting_confirm(session_id, True)
                    break

            # 用户主动停止：写入停止消息
            if stopped:
                task_store.append_chat_message(session_id, "assistant", "⏹ 已按你的要求停止本轮执行。")
                _emit(session_id, "WARN", "用户点击停止，本轮执行已停止", node="agent")

            # 持久化本轮工具调用链（assistant tool_calls + tool 结果）
            _save_messages(session_id, new_messages)
        except Exception as e:  # noqa: BLE001 - 单轮对话兜底
            err_str = str(e)
            if any(k in err_str.lower() for k in ("context length", "maximum context", "too long", "token limit", "context_length_exceeded")):
                hint = (
                    "⚠️ 上下文已达模型窗口上限，本轮对话内容过长。\n"
                    "建议：新建一个对话继续（历史记录仍可回看）；"
                    "或告诉我先总结已完成的部分。"
                )
            else:
                hint = f"执行出错：{e}"
            try:
                task_store.append_chat_message(session_id, "assistant", hint)
            except Exception as e2:  # noqa: BLE001
                print(f"[chat] 错误提示消息写入失败: {e2!r}", flush=True)
            _emit(session_id, "ERROR", hint, node="agent")
        finally:
            clear_usage_context()
            task_store.set_chat_steps(session_id, step)  # 记录轮次进度（跨轮次累计）
            task_store.set_chat_session_status(session_id, "idle")
            # 清除停止标志，保证下一次对话从干净状态开始
            task_store.set_chat_cancel(session_id, False)


def _args_preview(args: dict) -> str:
    s = json.dumps(args, ensure_ascii=False)
    return s if len(s) <= 120 else s[:120] + "…"


def _result_preview(result: str) -> str:
    first = result.strip().splitlines()
    head = first[0][:150] if first else ""
    return f"→ {head}" + ("" if len(first) <= 1 else "（详情已记录）")
