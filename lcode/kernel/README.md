# L-CODE Agent 内核（阶段 2，Python）

由桌面网关以子进程方式拉起的后台 Agent 内核。W1 在阶段 1 代码基础上新增：**内核模式入口、Token 鉴权、事件日志表与增量拉取**。

## 运行

```powershell
# 独立调试（同阶段1，端口 8000）
python run_kernel.py

# 内核模式（桌面网关使用：指定端口 + 启动令牌 → 开启鉴权）
python run_kernel.py --port 8090 --token dev123
```

## 与阶段 1 的差异（W1 新增）

| 文件 | 新增 |
|---|---|
| `run_kernel.py` | 内核入口：`--port` / `--token` / `--host` 命令行覆盖配置 |
| `config/settings.py` | `kernel_mode` / `kernel_port` / `kernel_token` / `kernel_log_file` |
| `db/task_store.py` | `events` 事件表 + `add_event()` / `get_events()`（增量 seq） |
| `api/main.py` | `X-Kernel-Token` 鉴权中间件、`GET /api/events`、`POST /api/shutdown`、任务生命周期事件 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（app= L-CODE Kernel；含 `idf_py` / `kb_*` 状态） |
| GET | `/api/config` | 当前配置（LLM + 并发数 + ESP-IDF 字段） |
| POST | `/api/config` | 热更新 LLM / 并发数 / ESP-IDF（`idf_path`、`idf_tools_path`、`idf_python_env_path`、`idf_target`），无需重启 |
| GET | `/api/env_probe?deep=` | ESP-IDF 环境检测（浅=解析路径与文件；`deep=true` 真跑 `idf.py --version`） |
| GET | `/api/llm/models` | 列出当前 LLM 端点可用模型（OpenAI 兼容 `GET /models`；端点不支持时回退厂商预置清单，`source=endpoint/preset/none`；`endpoint_models` 是端点登记清单，`models` 额外含当前配置值） |
| GET | `/api/llm/probe?model=` | LLM 连通性测试（一次极小真实调用），返回 `served_model` = 服务端**实际**服务的模型 |
| POST | `/api/run_task` | 提交任务 |
| GET | `/api/get_result?task_id=` | 查询结果 |
| GET | `/api/events?task_id=&after_seq=` | 增量事件（500ms 轮询） |
| POST | `/api/shutdown` | 优雅退出 |

请求头：内核模式（配置了 token）下必须携带 `X-Kernel-Token`。

## 配置

复制 `.env.example` 为 `.env`，填写 `LLM_API_KEY`、`IDF_PATH` 等（与阶段 1 一致）。
未配置 LLM key 时任务会在代码生成节点快速失败并写入 ERROR 事件（W1 已验证该链路）。

除 `.env` 外，**桌面端设置页也能改这些配置**（LLM 与 ESP-IDF）：写入
`%APPDATA%\LCode\kernel-env.json`，启动时以环境变量注入内核/规划器子进程，并通过
`POST /api/config` 热更新到本进程。命令行还有 `--data-dir`（可写数据目录，打包安装后必传）
与 `--outputs`（工程输出目录）。

> **优先级（2026-09-13 修正）**：桌面端启动时会在子进程环境里声明
> `LCODE_CONFIG_AUTHORITY=desktop`，内核据此把注入的 `LLM_*` / `IDF_*` **置顶**
> （`.env` 只作缺省）。开发模式下若从终端直接跑 `python run_kernel.py`，该标记不存在，
> 行为与过去一致：`.env` 覆盖 shell 里继承的同名变量。
> 旧行为是"`.env` 一律覆盖注入值"，后果是 `.env` 里的**过期 Key 每次内核重启都会复活**，
> 设置页填的新 Key 看着保存成功却用不上 —— 排查记录见 `docs/配置优先级与Key排查.md`。
> 打包版没有 `.env`，设置页是唯一来源。
>
> ⚠️ 注意：**真正跑对话的是规划器（DSH 子进程），不是内核**。它的环境在 spawn 时定型，
> 设置页改 Key 后主进程会自动重启规划器；规划器实际生效的模型/Key 末 4 位见设置页
> 「对话实际生效（规划器进程）」与 `main.log` 的 `[planner-manager] LLM: key = ****xxxx`。

### 模型 id 与别名（2026-09 实测，选模型前必读）

端点 `GET /models` **只登记规范模型**，但会接受一批**未登记的别名**——只看 `models` 列表会误判
自己实际用的是什么档位。实测 `https://api.deepseek.com/v1`：

| 填写的 id | 可否调用 | 服务端实际执行的模型（响应 `model`） |
|---|---|---|
| `deepseek-flash` | ✅ | `deepseek-flash` |
| `deepseek-v4-pro` | ✅ | `deepseek-v4-pro` |
| `deepseek-chat` | ✅ | **`deepseek-flash`**（别名） |
| `deepseek-reasoner` | ✅ | **`deepseek-flash`**（别名） |
| `deepseek-v4-flash` | ✅ | **`deepseek-flash`**（别名，DSH 目录里用的就是这个） |

因此：**别把"能调用"当成"用的就是它"**。要确认实际档位，用 `GET /api/llm/probe`（桌面端设置页
「测试连接」按钮）看 `served_model`；`GET /api/config` 的 `llm_served_model` 也会反映最近一次调用。

## 知识库（可选，方案 A 的可插拔后端）

`rag/` 只有「接缝 + 通用降级」两件事：

| 文件 | 角色 |
|---|---|
| `rag/backend.py` | **唯一接缝**：按 `LCODE_KB_BACKEND` 选定后端并暴露 `retrieve_docs` / `get_store` / `status` |
| `rag/stub.py` | 通用模式实现：零重依赖（不 import torch/langchain-*），检索返回空 + 明确原因 |
| `rag/__init__.py` | 后端无关入口：`from rag import retrieve_docs` |

真正的领域知识库是**闭源资产**（切片策略、向量库、语料），在私有包 `lcode-kb` 里：

```powershell
# 装了（内核 venv 里）→ 日志显示 [rag] 知识库后端: private
.venv\Scripts\python.exe -m pip install -e D:\1_ai_project\lcode-kb
```

| `LCODE_KB_BACKEND` | 行为 |
|---|---|
| `auto`（默认） | 装了就 private，没装就 stub |
| `private` | 必须 private，装不上直接抛错（早期暴露问题） |
| `stub` | 强制通用模式（旧值 `local` 等价） |

公开仓**不包含** `retriever.py` / `vector_store.py` / `load_docs.py` / 向量数据；
通用模式下检索返回空、`rag_search` 节点会明确告知"本次不提供手册资料"。
桌面端据 `/api/health` 的 `kb_backend` / `kb_available` 提示：Home 顶部「手册检索」能力标置灰、
设置页「知识库」一行显示通用模式。实测见 `tests/smoke_kb_backend.py`：

```powershell
.venv\Scripts\python.exe tests\smoke_kb_backend.py   # KB_BACKEND_TEST_PASSED
```

完整实测记录（5 个用例的原始输出、`/api/health` 两种后端对照、桌面端链路证据）见
`docs/开源方案A-知识库后端-实测证据.md`。

## 后续（W2+）

- 节点级事件（nodes 开始/结束）、任务取消、断点续跑（checkpointer 启用）、工作区迭代
- Nuitka 打包：`scripts/build_kernel.ps1`（standalone 目录 + Inno Setup 封装，D10）
