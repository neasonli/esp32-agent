# L-CODE · 嵌入式固件开发 Agent（桌面端）

> 面向 ESP32 等嵌入式固件的 AI Agent 桌面应用：**Electron 桌面壳 + DSH 规划器 + Python 内核**。
> 目标是把「提需求 → 选型 → 检索手册 → 生成固件 → 编译 → 按报错修复 → 烧录」这条链路做成一个能用的桌面工具。

## 架构

```
┌────────────────────────┐   IPC    ┌──────────────────────────┐  HTTP  ┌────────────────────────┐
│ 桌面端（Electron）      │ ───────► │ 规划器 planner（Node/TS） │ ─────► │ 内核 kernel（Python）    │
│ lcode/desktop          │          │ lcode/planner            │        │ lcode/kernel           │
│ 会话/项目/文件树/三栏    │ ◄─────── │ DSH agent 装配 + 工具桥   │ ◄───── │ FastAPI + SQLite + RAG │
└────────────────────────┘  事件轮询 └──────────────────────────┘        └────────────────────────┘
```

- **桌面端**（`lcode/desktop`）：Electron + React + Tailwind + Zustand。首页（项目 → 聊天记录）、
  工作区三栏（文件树 | 内容窗 | 聊天，可拖拽）、会话草稿、运行中排队/steer、帮助菜单等。
- **规划器**（`lcode/planner`）：基于 [DeepSeek Harness](https://github.com/deepseek-ai)（MIT）的 headless 装配，
  承载 Agent 循环，把事件/消息写回内核。
- **内核**（`lcode/kernel`）：FastAPI + SQLite；提供会话/事件/文件/编译/烧录接口与任务流水线。

## 环境要求

| 组件 | 要求 |
|---|---|
| 桌面端 | Node.js ≥ 20、pnpm/npm |
| 规划器 | 需要一份本地 [DeepSeek Harness](https://github.com/deepseek-ai) 检出（见下） |
| 内核 | Python ≥ 3.10；ESP-IDF（编译/烧录需要，`idf.py` 在 PATH 或配置 `IDF_PATH`） |

## 快速开始

```powershell
# 0) 目录约定：DSH 检出与仓库同级
#    <parent>\mcu_ai_agent          ← 本仓库
#    <parent>\deepseek\deepseek-harness-master
#    若路径不同，用环境变量指定：$env:LCORE_DSH_REPO = "D:\path\to\deepseek-harness-master"

# 1) 内核：创建 venv 并安装依赖
cd lcode\kernel
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env         # 填 LLM_API_KEY（DeepSeek / OpenAI 兼容端点均可）
#    桌面端按此顺序找内核解释器：LCODE_KERNEL_PYTHON → lcode\kernel\.venv → 其它历史路径；
#    想用别处的解释器就设 $env:LCODE_KERNEL_PYTHON = "D:\path\to\python.exe"

# 2) 规划器：安装 DSH profile（会创建 ~/.dsh/profiles/lcode-planner）
cd ..\planner
npm run setup

# 3) 桌面端：安装依赖并启动开发模式
cd ..\desktop
npm install
npm run dev                    # 或双击仓库根的「启动-LCODE-桌面开发.bat」
```

## 手册/知识库（可选）

内核的知识库后端是**可插拔**的，两种模式：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `private` | 装了私有知识库包 `lcode-kb`（`pip install` 到内核 venv） | 手册切片 + 向量检索全量能力 |
| `stub`（通用模式，默认） | 没装 | 检索返回空；Agent 会明确"本次不提供手册资料"，不让模型编造寄存器 |

由 `LCODE_KB_BACKEND` 控制（`auto` 缺省 / `private` 强制报错 / `stub` 强制通用），
桌面端在 Home「🔍 手册检索」与设置页「知识库」一行显示当前状态（通用模式下置灰）。

本仓库**不含**领域知识库实现与语料：切片策略、向量库、`data/rag_store` 都在私有仓 `lcode-kb` 里；
也不附带任何厂商 PDF（版权归各厂商所有）。想让通用模式也有检索能力，可自行实现
`rag/stub.py` 中同名的 `retrieve_docs(query, chip, top_k)`，或接入你自己的知识库。

## 许可

本项目以 **MIT License** 开源，见 `LICENSE`。
本项目使用/参考了 DeepSeek Harness（MIT）并保留其版权声明，见 `NOTICE` 与 `third_party/DSH-LICENSE`。

> 说明：授权/订阅服务端（`lcode/server`）与领域知识库（`lcode-kb`）不在本仓库中，属于私有组件；
> 本仓库可独立构建运行「通用能力」（会话、文件、模板编译链路），仅手册检索降级为空。
