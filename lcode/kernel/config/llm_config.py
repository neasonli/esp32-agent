"""统一 LLM 适配器：基于 openai SDK，兼容任意 OpenAI 格式接口。

支持：DeepSeek / OpenAI / 通义千问 / 讯飞星火（云端）、Ollama（本地）。
切换模型只改 .env 或调用 reconfigure（阶段2 W2 热更新），不改代码。
Token 用量自动统计（阶段2 W2 5.5）：节点包装器设置上下文后，每次调用
的 prompt/completion tokens 写入 task_llm_usage 表。
"""
import json
import threading
import time

from openai import OpenAI

from config.settings import settings

# 线程局部上下文：节点包装器设置，chat() 读取以归属 usage（并发任务互不干扰）
_ctx = threading.local()


def set_usage_context(task_id: str, node: str) -> None:
    _ctx.task_id = task_id
    _ctx.node = node


def clear_usage_context() -> None:
    _ctx.task_id = ""
    _ctx.node = ""


class LLMError(Exception):
    """LLM 调用失败（重试后仍失败）。"""


class LLMAdapter:
    """统一 LLM 适配器。"""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
    ):
        self.base_url = base_url or settings.llm_base_url
        self.api_key = api_key if api_key is not None else settings.llm_api_key
        self.model = model or settings.llm_model
        self.temperature = temperature if temperature is not None else settings.llm_temperature
        # 服务端"实际"服务了哪个模型（响应里的 model 字段）。与配置的 model 不同时说明
        # 配置的是别名（实测：deepseek-chat / deepseek-reasoner / deepseek-v4-flash
        # 目前都由 deepseek-flash 服务）。
        self.served_model = ""
        self._build_client()

    def _build_client(self) -> None:
        # 60s 超时 + 关闭 SDK 内部重试（用下方自定义重试，避免任务长时间挂起）
        self._client = OpenAI(
            base_url=self.base_url,
            api_key=self.api_key or "EMPTY",
            timeout=60.0,
            max_retries=0,
        )

    def reconfigure(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
    ) -> None:
        """热更新配置（阶段2 W2：设置面板调用 /api/config → 本方法）。"""
        if base_url is not None:
            self.base_url = base_url
            settings.llm_base_url = base_url
        if api_key is not None:
            self.api_key = api_key
            settings.llm_api_key = api_key
        if model is not None:
            self.model = model
            settings.llm_model = model
            self.served_model = ""  # 换了模型，旧的"实际服务模型"作废
        if temperature is not None:
            self.temperature = float(temperature)
            settings.llm_temperature = self.temperature
        self._build_client()

    def probe(self, model: str | None = None) -> dict:
        """连通性测试：一次极小的真实调用（max_tokens=1）。

        返回 `served_model` = 服务端**实际**服务的模型。实测 DeepSeek 端点会接受一批未登记的
        别名（deepseek-chat / deepseek-reasoner / deepseek-v4-flash 目前都解析到 deepseek-flash），
        只看配置名会误判能力档位，所以必须把服务端的回答暴露出来。
        """
        use_model = (model or "").strip() or self.model
        started = time.time()
        out: dict = {
            "requested_model": use_model,
            "configured_model": self.model,
            "base_url": self.base_url,
            "ok": False,
            "served_model": "",
            "latency_ms": 0,
            "error": "",
        }
        try:
            resp = self._client.chat.completions.create(
                model=use_model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            out["ok"] = True
            out["served_model"] = str(getattr(resp, "model", "") or "")
            if out["served_model"] and use_model == self.model:
                self.served_model = out["served_model"]
        except Exception as exc:  # noqa: BLE001 — 测试失败要把原因回给界面
            out["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        out["latency_ms"] = int((time.time() - started) * 1000)
        return out

    def _precheck(self) -> None:
        """未配置 key 且非本地模型时快速失败，给出明确提示。"""
        local = any(k in self.base_url.lower() for k in ("localhost", "127.0.0.1", "ollama"))
        if not self.api_key and not local:
            raise LLMError(
                "LLM_API_KEY 未配置：请在 .env 填写（复制 .env.example 为 .env），"
                "或使用本地 Ollama（LLM_BASE_URL 指向 localhost）"
            )

    def chat(
        self,
        system: str,
        user: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """统一对话入口，内置重试。返回纯文本内容。自动记录 token 用量。"""
        self._precheck()
        last_err: Exception | None = None
        for attempt in range(settings.llm_retry_times + 1):
            try:
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=settings.llm_temperature if temperature is None else temperature,
                    max_tokens=max_tokens or settings.llm_max_tokens,
                )
                content = resp.choices[0].message.content
                if content is None or not content.strip():
                    raise LLMError("LLM 返回空内容")
                self._record_usage(resp)
                return content.strip()
            except Exception as e:  # noqa: BLE001 - 统一兜底重试
                last_err = e
                if attempt < settings.llm_retry_times:
                    time.sleep(2 * (attempt + 1))
        raise LLMError(f"LLM 调用失败（已重试 {settings.llm_retry_times} 次）: {last_err}")

    def chat_with_tools(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> tuple[str, list[dict]]:
        """工具调用对话入口（OpenAI 兼容 function calling）。

        messages: 完整消息列表（不含 system，由本方法拼接）。
        tools: OpenAI tools 定义列表。
        返回 (content, tool_calls)；tool_calls 元素为
        {"id": str, "name": str, "arguments": dict}；无工具调用时为空列表。
        """
        self._precheck()
        last_err: Exception | None = None
        for attempt in range(settings.llm_retry_times + 1):
            try:
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "system", "content": system}, *messages],
                    tools=tools,
                    temperature=settings.llm_temperature if temperature is None else temperature,
                    max_tokens=max_tokens or settings.llm_max_tokens,
                )
                msg = resp.choices[0].message
                content = (msg.content or "").strip()
                tool_calls: list[dict] = []
                for tc in (msg.tool_calls or []):
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except Exception:  # noqa: BLE001
                        args = {}
                    tool_calls.append(
                        {"id": tc.id, "name": tc.function.name, "arguments": args}
                    )
                self._record_usage(resp)
                return content, tool_calls
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < settings.llm_retry_times:
                    time.sleep(2 * (attempt + 1))
        raise LLMError(f"LLM 工具调用失败（已重试 {settings.llm_retry_times} 次）: {last_err}")

    def _record_usage(self, resp) -> None:
        """将本次调用 usage 写入 task_llm_usage（节点包装器设置了上下文才记录）。"""
        # 记录服务端实际使用的模型（别名会被解析成规范模型，界面上要能看出来）
        served = getattr(resp, "model", "") or ""
        if served:
            self.served_model = str(served)
        task_id = getattr(_ctx, "task_id", "")
        if not task_id:
            return
        usage = getattr(resp, "usage", None)
        if usage is None:
            return
        try:
            from db import task_store

            task_store.add_usage(
                task_id=task_id,
                node=getattr(_ctx, "node", ""),
                model=self.model,
                prompt_tokens=int(usage.prompt_tokens or 0),
                completion_tokens=int(usage.completion_tokens or 0),
            )
        except Exception:  # noqa: BLE001 - 用量记录失败不影响主流程
            pass


# 全局单例，所有节点统一使用
adapter = LLMAdapter()


def build_prompt(requirement: str, datasheet_info: str) -> str:
    """组装代码生成 prompt 模板（公共部分，节点可再扩展）。"""
    return (
        "请根据以下用户需求与芯片资料，编写完整可编译的 ESP-IDF C 代码。\n"
        f"【用户需求】\n{requirement}\n\n"
        f"【芯片资料（RAG 检索结果）】\n{datasheet_info}\n\n"
        "要求：\n"
        "1. 使用 ESP-IDF v5.x + FreeRTOS API（app_main 入口，xTaskCreate 创建任务）\n"
        "2. 只输出 C 代码，不要解释，不要 markdown 代码块标记\n"
        "3. 包含所需头文件，代码可直接放入 main/main.c 编译\n"
    )
