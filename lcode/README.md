# L-CODE（阶段 2 项目）

嵌入式固件开发 Agent 产品化：**Electron 桌面网关 + Python Agent 内核 + Go 服务端**（阶段 2 架构，详见仓库 `../docs/阶段2-产品化详细开发文档.md` V1.3）。

> 当前状态：**W3 服务端完成**——Go 单二进制 + SQLite + Docker Compose + Cloudflare Tunnel 示例，聚合支付/订阅签发/在线校验/7 天试用/机器码管理已实现并全链路测试通过；支付平台按 S2 试用后定（默认 mock，可插拔）。

---

## 目录结构地图（先看这张图，找问题按此定位）

```
lcode\
├── README.md                     ★ 本文件：结构说明 + 问题定位速查表
│
├── desktop\                      【网关层】Electron + React + TS（阶段2文档 第4章）
│   ├── package.json              Electron 依赖与脚本（dev/build/build:win 等）
│   ├── electron.vite.config.ts   三端构建配置（main/preload/renderer）
│   ├── tsconfig*.json            TS 编译配置（node 侧 / web 侧分离）
│   ├── electron-builder.yml      打包配置（W4 细化；内核 EXE 走 extraResources）
│   ├── resources\
│   │   └── README.md             Nuitka 内核 EXE 放置说明（W4 产物）
│   └── src\
│       ├── main\                 ★ 主进程（Node 环境，D19 铁律：业务只在主进程+内核）
│       │   ├── index.ts          入口：窗口创建、IPC 注册、拉起内核
│       │   ├── kernel-manager.ts ★ 内核进程管理：spawn/健康检查/崩溃自动重启
│       │   ├── ipc-client.ts     本地 HTTP 客户端（X-Kernel-Token 鉴权）
│       │   └── event-poller.ts   ★ 事件增量轮询（500ms）→ 推送渲染进程
│       ├── preload\              contextBridge 白名单（渲染进程唯一入口）
│       │   ├── index.ts          暴露 window.lcode API（最小化）
│       │   └── index.d.ts        类型声明
│       └── renderer\             React 渲染进程（W1 最小验证页，UI 组件 W2 建设）
│           ├── index.html
│           └── src\
│               ├── main.tsx      入口
│               ├── App.tsx       ★ 内核状态 + 任务事件流验证页
│               └── styles.css
│
├── kernel\                       【内核层】Python Agent（阶段2文档 第5章）
│   ├── run_kernel.py             ★ 内核入口：--port --token（桌面网关以子进程拉起）
│   ├── config\settings.py        全局配置（含内核模式：kernel_port/kernel_token）
│   ├── api\main.py               ★ FastAPI：token 鉴权 / run_task / events / health / shutdown
│   ├── db\task_store.py          ★ SQLite：tasks 表 + events 事件表（增量 seq）
│   ├── agent\                    LangGraph 状态机 + 5 节点（阶段1 原样保留）
│   ├── rag\                      知识库（numpy 向量库）
│   ├── tools\                    编译封装 / 错误分类
│   ├── templates\                ESP-IDF 工程模板
│   ├── scripts\
│   │   └── build_kernel.ps1      ★ Nuitka 打包 PoC（standalone 目录，W4 封装安装包）
│   ├── tests\                    阶段1 冒烟测试（可复用）
│   ├── assets\                   知识库资料（安装包内置 D6）
│   ├── requirements.txt          Python 依赖
│   └── .env.example              配置模板（复制为 .env 填 LLM key / IDF 路径）
│
└── server\                       【服务端】Go 单二进制 + SQLite + Docker（阶段2文档 §3.3/§8）
    ├── cmd\server\main.go        入口：配置/密钥/Provider 注册/优雅退出
    ├── internal\
    │   ├── config\                LC_* 环境变量（.env.example 有模板）
    │   ├── store\                 SQLite：machines/orders/subscriptions/trials/updates/usage/audit
    │   ├── pay\                   Provider 接口 + mock（默认）+ PayJS/虎皮椒/蓝兔 适配器（S2 待定）
    │   ├── license\               Ed25519 密钥 + 授权载荷签发/验签（在线校验核心）
    │   └── api\                   订单/回调/在线校验/试用/机器码管理/更新 handlers
    ├── Dockerfile                 静态构建（CGO_ENABLED=0）
    ├── docker-compose.yml         本地部署（D24）
    ├── docker-compose.cloudflared.yml  Cloudflare Tunnel 公网暴露（S3）
    └── README.md                  ★ API 契约 + 部署 + S2 支付平台接入说明
```

---

## 问题定位速查表（出问题先查这里）

| 现象 | 先看哪里 |
|---|---|
| 桌面窗口打不开 / 渲染空白 | `desktop/src/main/index.ts`（窗口创建）→ 控制台报错 |
| 内核没起来 / 一直"启动中" | `desktop/src/main/kernel-manager.ts`（spawn 命令、kernelDir/kernelExe 路径）→ 主进程控制台看 spawn 输出 |
| 内核起来又被杀 / 反复重启 | `kernel-manager.ts` 健康检查逻辑（HEALTH_INTERVAL / MAX_FAILS）；内核侧 `run_kernel.py` 启动日志 |
| 事件流不显示 / 日志不滚动 | ① `kernel/db/task_store.py`（events 表写入）② `desktop/src/main/event-poller.ts`（轮询）③ `App.tsx`（渲染） |
| 接口 401 | 内核 token 不匹配：`kernel-manager.ts` 生成 → 子进程 `--token` 传入 → `ipc-client.ts` 请求头带回 |
| 任务提交报错 | `ipc-client.ts` → `kernel/api/main.py`（run_task）→ 看任务事件（events 接口） |
| 数据库文件在哪 | `kernel/data/tasks.db`（开发模式）；产品化后迁 AppData（阶段2文档 第10章） |
| LLM key / IDF 未配置 | `kernel/.env`（从 `.env.example` 复制填写） |

---

## 快速开始（W1 验证）

### 1. 先启动内核（终端 1）

```powershell
cd D:\1_ai_project\mcu_ai_agent\lcode\kernel
copy .env.example .env            # 首次：填写 LLM_API_KEY / IDF 路径（可参考阶段1的 .env）
..\..\embedded_agent_stage1\.venv\Scripts\python.exe run_kernel.py --port 8090 --token dev123
```

验证：`http://127.0.0.1:8090/api/health`（带 `X-Kernel-Token: dev123`）应返回 ok。

### 2. 启动桌面（终端 2，需 Node.js ≥ 18）

```powershell
cd D:\1_ai_project\mcu_ai_agent\lcode\desktop
npm install
npm run dev
```

窗口出现"内核状态：运行中"，提交任务后事件区实时滚动即 W1 链路打通。

> 桌面侧会自动拉起内核（开发模式回退到 Python），无需手动开终端 1；手动开是为了先看内核日志。

---

## W1 验收对照（阶段2文档 第11章）

- [x] 主进程拉起内核 / 健康检查握手（内核侧已实测：401 拦截 + health + events + shutdown 全通）
- [x] 桌面代码编译（TypeScript 类型检查通过，electron-vite 三端构建成功）
- [x] 桌面窗口显示内核状态（`npm run dev` 实测：内核 pid 启动 → 健康检查通过 → 状态"运行中"）
- [x] 事件流式推送渲染进程（GUI 提交任务，事件区实时滚动，任务 SUCCESS）
- [x] 崩溃自动重启（死亡螺旋竞态已定位修复：killProc 锁定进程；重启链路经多轮实测）
- [ ] Nuitka 打包 PoC（脚本就绪，按计划 W4 执行，不阻塞 W2）

> W1 结论：**核心链路全部验证通过**（2026-08-30）。唯一未执行项为 Nuitka 打包 PoC，按里程碑计划放在 W4。

---

## W2 进度（阶段2文档 第11章）

### 第一批：内核侧（✅ 完成并实测）

| 功能 | 状态 |
|---|---|
| L2~L4 事件（节点/动作/进度/产物） | ✅ 实测：四级事件全链路 |
| Token 用量统计（task_llm_usage + 按节点） | ✅ 实测：493 tokens 按节点分布 |
| 产物就绪收尾事件 + 产物清单 | ✅ 实测 |
| 取消（节点前后检查，编译中及时生效） | ✅ 实测：快速 CANCELED |
| 节点级断点续跑（checkpointer + invoke(None)） | ✅ 实测：从被取消节点继续，chip/rag 不重跑 |
| 任务级重跑（full_restart） | ✅ |
| 工作区（workspaces 表 + 自动登记 + workspace_id 迭代） | ✅ 实测 |
| /api/config 热更新 | ✅ 实测 |
| 并发线程池（默认 2，S4） | ✅ |

### 第二批：UI 侧（✅ 完成，构建通过）

**任务详情 = 三栏 IDE 布局（类 Cursor/Qoder），无左侧栏，导航在右上角**

```
┌─────────────────────────────────────────────────────────┐
│ L-CODE · 固件开发 Agent                    [🏠 任务][⚙️ 设置]│
├──────────┬──────────────────────┬───────────────────────┤
│ 📁 源码树 │    📄 中间内容窗     │    💬 Agent 聊天框      │
└──────────┴──────────────────────┴───────────────────────┘
```

| 栏 | 说明 |
|---|---|
| 源码文件树 | 工程目录树（只读），点击文件在中间窗打开；**可与聊天框左右对调**（设置页，持久化） |
| 中间内容窗 | **所有点击打开**都在此显示：文件内容（语法高亮）、产物（二进制提示+路径） |
| Agent 聊天框 | 用户需求气泡 → Agent 进度流式气泡 → 结果摘要（状态/芯片/Token）；**📦 产物图标按钮**（悬停显示列表，点击中间窗打开）；底部输入框 = **对同一工程追加需求**（工作区迭代，多轮对话） |

其他界面：
- 主界面：需求输入 + 会话记录列表（状态/芯片/Token/产物，自动刷新）
- 设置页：**面板布局对调** + LLM 配置面板（热更新）+ 内核状态 + 工作区列表

> 说明：UI 当前用 Tailwind + 手写 shadcn 风格组件（W2 基础版）；Radix 无障碍原语与 shadcn CLI 组件库在 W3 打磨时接入。

### W2 补全（2026-08-30，对照阶段2文档 §4.2.1/§4.2.2/§4.3 细则）

| 缺项 | 实现 |
|---|---|
| 语法高亮（点文件查看） | ✅ `components/codeHighlight.ts` 轻量高亮（C/CMake/INI/Python/JSON，无第三方依赖，token 全转义防 XSS） |
| 导出 zip | ✅ 内核 `GET /api/workspace_export`（zipfile，防目录穿越，跳过 build/.git 等）+ 文件树 📦 按钮 → 保存对话框 |
| 在资源管理器中打开 | ✅ 文件树 📂 按钮（复用 `app:openWorkspaceFolder`） |
| 会话卡片"继续优化" | ✅ HomeView 卡片 💬 按钮 → 工作区视图加载该任务会话（`continueTask`，不改变工作区根） |
| 设置页并发数 1~4 可调 | ✅ SettingsView 选择器 + 内核 `POST /api/config` 热更新（线程池按需重建，旧任务排空不取消） |

新增内核 API：`GET /api/workspace_export`、`GET /api/config`；`POST /api/config` 增加 `kernel_concurrency`。
新增 IPC：`app:exportWorkspace`、`kernel:getKernelConfig`、`kernel:updateKernelConfig`。

### 内核新增 API（第二批配套）

```
GET /api/conversations       会话记录列表（V1.5 4.2.2）
GET /api/conversation        单会话详情（任务+事件+结果+用量）
GET /api/workspace_files     工程文件树（V1.5 4.2.1，防目录穿越）
GET /api/workspace_file      读取文件内容（防目录穿越，限 200KB）
```

## 运行（W2 验证）

```powershell
cd D:\1_ai_project\mcu_ai_agent\lcode\desktop
npm run dev
```

验证点：提交任务 → 自动跳任务详情看实时日志 → 完成后切"工程源码"看文件树与 main.c → "Token 用量"看分布 → 主界面会话记录可回看 → 设置页可热更新 LLM 配置。

---

## W3 进度（阶段2文档 第11章）

### 服务端（✅ 完成，Go 单二进制 + SQLite + Docker，详见 `server/README.md`）

| 功能 | 状态 |
|---|---|
| 聚合支付订单创建/回调确认（Provider 接口 + mock 默认，S2 试用后切真实平台） | ✅ 实现，回调验签 401 拦截伪造 |
| 订阅签发（绑定机器码、半年有效，§8.2 标准 ¥59 / 内测 ¥29） | ✅ 扫码支付 → 自动激活 → 到期拦截全链路测试通过 |
| **在线校验**（启动/定时调用；Ed25519 签名响应，离线缓存可验签） | ✅ 签名 + 客户端验签协议已定义 |
| 7 天试用（D5B，单 IP 配额风控） | ✅ |
| 机器码管理（换机迁移/吊销/风控/IP 历史） | ✅ 管理 API + 审计日志 |
| 版本发布 / 用量统计（§8.1 职责 5 可选） | ✅ |
| Docker Compose 本地部署 + Cloudflare Tunnel 公网暴露（D24/S3） | ✅ Dockerfile + compose ×2 + 示例 |
| 支付平台选定（S2） | ⏳ 试用后定（PayJS/虎皮椒/蓝兔 适配器已就位） |

### W3 剩余（桌面/内核侧，待开工）

- [ ] 订阅页 UI（价格展示 + 扫码支付 + 试用倒计时 + 优惠倒计时，阶段2文档 §4.2）
- [ ] 主进程 auth.ts / payment.ts（在线校验调用、本地缓存、7 天试用、订单轮询）
- [ ] 工程编辑器（改码重编译闭环，§4.2.1 W3 增强版，依赖内核 workspace_file POST）
- [ ] 多轮对话链（§4.2.2 W3 增强版，会话链 workspaces.history 扩展）

---

## W3 对话式 Agent（✅ 已实现并实测，2026-08-30）

> 用户核心诉求：不要"固定流水线"，要**自由对话 + 按命令执行**（类 DeepSeek Harness）。

### 形态

- **自由对话**：直接聊天（无需任务语义），会话上下文持久化（`chat_sessions`/`chat_messages` 表），多轮记忆。
- **工具调用**：LLM function calling 循环，自动规划并逐步执行：
  `shell`（任意命令）/ `git_clone`（拉工程）/ `list_dir` / `read_file` / `write_file` /
  `build`（idf.py build）/ `flash`（idf.py -p COMx flash 烧录）。
- 工具执行过程实时事件流（复用 events 表，task_id = session_id），桌面端聊天框直接可见。

### 内核新增

```
POST /api/chat           发送消息/命令（session_id 空=新建会话；会话内串行）
GET  /api/chat_sessions  会话列表（标题/状态/消息数）
GET  /api/chat_session   会话详情（消息历史 + 事件）
```

- `agent/chat_agent.py`：对话循环（system 提示词 + 工具调用 + 取消/上限保护 + 事件）
- `tools/chat_tools.py`：7 个工具（路径越界防护、输出截断、超时）
- `config/llm_config.py`：新增 `chat_with_tools()`（OpenAI 兼容 tool calling）
- `tools/compile_tool.py`：抽出通用 `run_idf()`（build/flash 共用）

### 实测结果（真实开发板）

- 对话："列出工作目录内容" → Agent 自主 list_dir → 读 main.c/CMakeLists.txt → build 编译成功 →
  shell `mode` 探测到 COM3 → **flash 烧录成功**（ESP32-S3 rev v0.1，MAC f4:12:fa:d4:92:28）→ 中文总结。
- 自由闲聊正常回复；工具失败（如 GitHub 网络不通）会明确报错。
- ⚠️ GitHub 直连超时（GFW/未配代理）时 `git_clone` 会失败：请先配置 git 代理
  （`git config --global http.proxy http://127.0.0.1:端口`）或改用镜像仓库。

### 目录规则变更（配合问题 2 修复）

- `code_generate.py`：工程**直接生成在 outputs 根下**（不再套 `{task_id}/` 子目录）。
  模板复制以 `CMakeLists.txt` 是否存在判断；多任务共用同一目录（会互相覆盖，注意并发）。
