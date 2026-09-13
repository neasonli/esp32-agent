# L-CODE 桌面端 UI 设计文档

> 版本：V1.0（2026-08-30）
> 范围：Electron 桌面端 **渲染层/主进程 UI 相关**的当前实现约定（W1/W2 已完成部分）。
> 目的：作为当前 UI 行为的**唯一事实来源**，防止后续改动破坏既有行为。改 UI 前先读本文档。
> 配套文档：`阶段2-产品化详细开发文档.md`（产品与架构决策 D1–D25、S1–S5 的总纲）。

---

## 1. 架构铁律（D19，不可违反）

1. **渲染进程零业务逻辑**：Agent 逻辑（LangGraph/检索/编译）只存在于后台内核进程（FastAPI）。渲染进程只负责展示与收集用户输入。
2. **渲染进程只能通过 preload 白名单访问能力**：`window.lcode`（contextBridge 暴露，见 §8）。禁止在渲染进程直接 `require('electron')` / `fetch` 内核地址 / 引入任何 Agent 逻辑。
3. **主进程是唯一"中间人"**：渲染 → IPC（`ipcRenderer.invoke`）→ 主进程 handler → 内核 HTTP → 回传。主进程负责内核生命周期（启动/健康/重启/退出）。
4. **safeIpc 契约**：主进程所有内核请求经 `safeIpc()` 包装，**失败时返回 `null` 并写日志 `[ipc] 调用失败: ...`，不抛异常**。因此**渲染层每个 IPC 返回值的解构前必须判空**（历史上 `r.path` 未判空导致崩溃，见 §7.1 回归清单）。

## 2. 窗口与外壳（main/index.ts）

| 项 | 当前实现 |
|---|---|
| 窗口尺寸 | 1100×760，`show:false` |
| 标题栏 | `titleBarStyle:'hidden'` + Windows `titleBarOverlay {height:40, color:'#ffffff'}`（最右侧恢复 −□✕ 按钮） |
| 安全默认 | `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、preload 白名单 |
| 原生菜单 | `Menu.setApplicationMenu` 中文模板（文件/编辑/视图），**隐藏标题栏下不显示**，仅提供快捷键（Ctrl+C/V/Z 等）；可见菜单由 React `MenuBar` 提供 |
| 窗口生命周期 | 全程 `[window]` 日志；`ready-to-show`→`show()`；`did-fail-load` 也强制显示；**3 秒兜底强制 show**（防"无窗口"假死） |
| 崩溃兜底 | `uncaughtException`/`unhandledRejection` 全部落盘 `%APPDATA%\L-CODE\logs\main.log` |
| 退出 | `window-all-closed → quit`；`before-quit` 先停内核再退出 |

> **防改坏提示**：不要移除 3 秒兜底 show 与 did-fail-load show；不要改回依赖原生菜单栏（Windows 隐藏标题栏下原生菜单不可见，可见菜单只能走 React MenuBar）。

## 3. 顶栏（App.tsx）

- 高度 `h-10`，`border-b`，背景 `bg-card`，整条 `-webkit-app-region:drag`（可拖拽窗口）。
- **左侧**：`MenuBar`（自定义菜单，`no-drag`）。
- **右侧**：导航三个按钮 `🏠 任务` `📁 工作区` `⚙️ 设置`（`no-drag`），激活项 `bg-primary`。
- **右留白 `pr-[150px]`**：给 Windows titleBarOverlay 窗口按钮让位（不要删）。
- 导航"任务"按钮逻辑（`goTasks`，保留现场）：
  - 在任务详情 → 回任务列表；
  - 在设置且存在 activeTaskId → 回任务详情；
  - 其他 → 任务列表。

## 4. 视图结构

Zustand `view: 'home' | 'task' | 'workspace' | 'settings'`（见 §7 状态存储）。

| 视图 | 组件 | 布局 |
|---|---|---|
| home | `HomeView` | 居中滚动页（需求输入 + 会话记录列表） |
| task | `TaskDetailView` | **全屏三栏**：文件树 | 内容窗 | Agent 聊天（布局可左右对调） |
| workspace | `WorkspaceView` | **全屏三栏**：同上，根=自定义工作区目录，聊天=无任务时先显示需求输入 |
| settings | `SettingsView` | 居中滚动页（LLM 配置/工作目录/语言/布局） |

### 4.1 初始界面（HomeView）示意

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 文件  编辑  视图                                     🏠 任务  📁 工作区  ⚙️ 设置      ─ □ ✕ │ ← 顶栏 h-10（隐藏标题栏）
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│               输入产品需求，自动完成选型 → 检索 → 生成固件 → 编译修复                        │
│                                                                                           │
│       ┌──────────────────────────────────────────────────────────┐   ┌──────────┐         │
│       │ 例如：实现 ESP32-S3 温湿度采集并通过串口上传               │   │ 提交任务  │         │ ← Enter 提交
│       └──────────────────────────────────────────────────────────┘   └──────────┘         │
│                                                                                           │
│       会话记录（3）                                                          （提示勾选多选删除） │
│       ┌────────────────────────────────────────────────────────────────────┐              │
│       │ ☐  实现 ESP32-S3 温湿度采集并通过串口上传                    [成功]  │              │
│       │    2026-08-30 10:00 ｜ 芯片：esp32s3 ｜ Token：1,234 ｜ 产物：2    │              │ ← 右键=删除菜单
│       └────────────────────────────────────────────────────────────────────┘              │
│       ┌────────────────────────────────────────────────────────────────────┐              │
│       │ ☐  实现 LED 呼吸灯效果                                        [失败] │              │
│       │    2026-08-29 09:30 ｜ 芯片：esp32s3 ｜ Token：890 ｜ 产物：0       │              │
│       └────────────────────────────────────────────────────────────────────┘              │
│                                                                                           │
│       （列表每 5s 轮询刷新；内核未 running 时跳过刷新，避免启动竞态刷错误）                 │
│                                                                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

要点：居中窄列（max-w-3xl）；勾选框 + 右键菜单删除 + 确认弹窗（§6.3）。

### 4.2 打开文件夹后的界面（WorkspaceView）示意

"文件 → 打开文件夹…"选择目录后进入；任务详情页（task 视图）布局完全相同，仅聊天栏自动加载该任务对话。

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 文件  编辑  视图                                     🏠 任务  📁 工作区  ⚙️ 设置      ─ □ ✕ │
├───────────────┬─────────────────────────────────────────────────────┬────────────────────┤
│ 文件树 w-64   │                 内容窗 flex-1                        │ Agent 聊天 w-80    │
│               │                                                     │                    │
│ 📁 esp32_rtos │                                                     │  （无任务时）      │
│   > 新建文件夹 │               （未选择内容时                        │  在此输入产品需求… │
│   📄 新建文本文档.txt │          居中显示"空白"提示）                │                    │
│               │                                                     │  ┌──────────────┐  │
│   [⟳]         │                                                     │  │ 实现温湿度采集…│  │
│               │                                                     │  └──────────────┘  │
│   （根永远在顶 │                                                     │  Ctrl+Enter 发送   │
│    > 原地展开/ │                                                     │  ┌──────┐         │
│    收起，§5）  │                                                     │  │ 发送  │         │
│               │                                                     │  └──────┘         │
│               │                                                     │  （提交后变气泡对话│
│               │                                                     │   + 事件流式展示） │
└───────────────┴─────────────────────────────────────────────────────┴────────────────────┘
```

要点：
- 三栏宽 `w-64 | flex-1 | w-80`（treeLeft）或对调（chatLeft，设置页切换）。
- 文件树根 = 当前工作目录（自定义工作区或内核默认 outputs），**子文件夹带 `>` / `⌄` 箭头原地展开/收起**，详见 §5。
- 聊天栏无任务时显示大输入框（Ctrl+Enter 提交，§6.2），提交后转为任务对话流。

### 4.3 三栏布局（task 与 workspace 共用）
- `layout==='treeLeft'`：`[w-64 文件树][flex-1 内容窗][w-80 聊天]`
- `layout==='chatLeft'`：`[w-80 聊天][flex-1 内容窗][w-64 文件树]`
- 布局在设置页切换，Zustand persist 持久化。

## 5. 文件树（FileTreePane）—— 本组件契约最严格，改动前必读

### 5.1 交互模型（2026-08-30 定稿，勿回退为"重新生根"）

1. **根永远显示在树顶**：根 = 当前工作区目录（自定义工作区或内核默认 outputs），标题栏显示其真实路径。
2. **子文件夹"原地展开/收起"**：每个目录节点前面有箭头 `>`（收起）/ `⌄`（展开）；点击箭头或目录名 = 切换展开状态。**点击文件夹绝不改变根、绝不顶替整棵树**。
3. **所有子文件夹同级规则**：任意嵌套，递归渲染。
4. **惰性加载**：目录展开时才请求 `/api/workspace_files?dir=<该目录>` 拉子项；子项**缓存**在 `children[path]`，收起再展开不重复请求（除非 ⟳ 刷新清缓存）。
5. **文件节点**：点击 → 中间内容窗打开（`onOpenFile`）。**目录节点除展开/收起外无其他交互**（点击目录名 = 展开/收起，不会打开文件、不会改变根）。
6. **没有"上级/回退"按钮**（用户明确要求移除）；因为树不会重新生根，也就不需要回退。

### 5.2 加载与容错

- **根加载**：`initialDir`（两个调用方均传 `''`）请求根；失败（safeIpc 返回 null）时**自动重试 12 次 × 1.5s ≈ 18s**，覆盖"打开文件夹 → 内核重启"的引导窗口；重试耗尽才显示"内核未就绪，目录读取失败，请稍后点 ⟳ 刷新"。
- **子目录加载失败**：内联显示"子目录加载失败（点箭头重试）"，收起再展开即重试。
- **⟳ 刷新**：清空展开集合 + children 缓存 + 错误，重新拉根。
- **头部按钮**：📂 在资源管理器中打开（复用 `app:openWorkspaceFolder`）；📦 导出 zip（`exportWorkspace('')` → 内核 zip → 保存对话框，成功后 8s 提示条）。
- 空目录显示 `treeEmpty` 文案。

### 5.3 状态结构

```ts
expanded: Set<string>                        // 已展开的目录 path
children: Record<string, FileEntry[] | undefined>  // 目录子项缓存；undefined=未加载
childErr: Record<string, string>             // 各目录加载错误
entries / rootPath / err                     // 根级
```

### 5.4 依赖的 API

- 依赖的 API：`GET /api/workspace_files`（单层）+ `GET /api/workspace_file`（文本）+ **`GET /api/workspace_export`**（zip：跳过 build/.git/__pycache__ 等，防目录穿越复用 `_safe_resolve`）。
- `GET /api/config` 查当前配置（含并发数）；`POST /api/config` 热更新 LLM + `kernel_concurrency`（1~4，线程池按需重建、旧池排空不取消）。

### 5.5 防改坏红线

- ❌ 禁止恢复"点击文件夹 → 顶替整棵树"（历史缺陷：进子文件夹后回不去）。
- ❌ 禁止加回"上级 / outputs 根"按钮。
- ❌ 禁止移除根加载判空/重试（内核重启窗口 fetch 必败，直接解引用会崩）。
- ❌ 禁止把文件树做成需要刷新整页才能看到新文件夹。

## 6. 其余 UI 组件

### 6.1 内容窗（ContentView）
- 无选中 → `contentEmpty` 占位；二进制/产物（`item.kind==='artifact'` 或扩展名命中 BINARY_EXT）→ 📦 提示 + 路径 + 大小；文本 → **语法高亮** `<pre>`（`codeHighlight.ts`：按扩展名选 C/CMake/INI/Python/JSON，token 先转义再包 `<span class="tok-*">`，`dangerouslySetInnerHTML` 仅用于已转义 HTML——**禁止直接渲染未转义内容**）。
- **null 契约**：`file==null` 显示"加载中"，不会崩；`readWorkspaceFile` 返回 null 时调用方（WorkspaceView/TaskDetailView）显示"文件读取失败（内核未就绪或文件已被删除）"。

### 6.2 Agent 聊天（ChatPane）
- 两种模式：任务模式（`initialTaskId`，进入即加载对话）/ 工作区模式（`workspaceMode`，无任务时先显示大输入框，Ctrl+Enter 提交；提交后创建任务进入对话）。
- 数据流：用户需求 → 右对齐气泡；Agent 事件 → 左对齐气泡（运行中每 **2.5s 轮询** `getConversation` + `onKernelEvent` 实时事件追加）；完成 → 状态徽章（Badge 颜色映射）、chip、token、📦 产物悬浮列表（点击在内容窗打开）、事件时间线 `<details>` 折叠。
- 失败/取消/中断 → 显示"续跑 / 从头重跑"按钮（`resumeTask(taskId[, fullRestart])`）。
- 底部输入：对同一工程追加需求（多轮迭代），Enter 发送。
- 工作区模式首次提交：`workspaceId=''`（工程落在工作目录下）；之后按当前任务迭代。

### 6.3 首页（HomeView）
- 需求输入（Enter 提交）→ 会话记录卡片列表。
- **多选**（复选框）+ **右键菜单删除**（若右键命中已选中项则作用于全部选中）+ **确认弹窗**（destructive，不可恢复提示，运行中/排队中任务跳过）。
- 卡片右上 **💬 继续优化** 按钮（有 `project_dir` 时显示）：`continueTask(task_id)` → 工作区视图 + 加载该任务会话（不改变工作区根、不重启内核）。
- 每 5s 轮询 `getConversations`；**内核状态非 running 时跳过刷新**（防启动竞态刷错误）。

### 6.4 设置页（SettingsView）
- LLM 配置（base_url/api_key/model/temperature，保存走 `updateLlmConfig`）。
- 工作目录：显示当前目录（持久化 `%APPDATA%\L-CODE\workspace.json`）、📁 选择、重置。
- 界面语言：中文/English 卡片切换（`lang`）。
- 面板布局：源码树在左 / 聊天在左 卡片切换（`layout`）。
- **任务并发**：1~4 选择器（S4，默认 2），`updateKernelConfig({kernel_concurrency})` 热更新，进入页面时 `getKernelConfig` 读当前值。⚠️ 修改后内核线程池重建：**已运行/已排队任务继续在旧池跑完，不取消**。

### 6.5 菜单栏（MenuBar，React 实现）
- **文件**：打开文件夹…（`pickDirectory` → `setWorkspaceDir` → `openWorkspace` 进工作区视图）、打开工作目录（`openWorkspaceFolder`，资源管理器打开）、分隔线、退出。
- **编辑**：撤销/重做/剪切/复制/粘贴/全选（`document.execCommand`，作用于当前焦点）。
- **视图**：刷新（`appReload`）、开发者工具（仅 dev 显示）。
- 点击外部关闭下拉；`no-drag` 区域。

## 7. 状态存储（stores/useAppStore.ts）

Zustand + `persist`（key `lcode-ui-settings`，partialize 只持久化 `layout`/`lang`/`workspaceRoot`）。

```ts
view: View            // 'home'|'task'|'settings'|'workspace'
activeTaskId: string | null
kernelStatus: KernelStatusInfo | null
conversations: ConversationItem[]
layout: 'treeLeft' | 'chatLeft'
lang: 'zh' | 'en'
workspaceRoot: string | null   // 工作区根目录
```

动作：`openTask(id)`（→task 视图）、`openWorkspace(dir)`（→workspace 视图、清 activeTaskId）、`continueTask(taskId)`（→workspace 视图并加载该任务会话，不改变 workspaceRoot）、`setKernelStatus`（主进程 `kernel:status` 推送 + App 启动时 `getKernelStatus` 拉取）。

## 8. preload 白名单（src/preload/index.ts，window.lcode）

| 分组 | 方法 |
|---|---|
| 内核 | `getKernelStatus` `restartKernel` `getConversations` `getConversation` `listWorkspaceFiles` `readWorkspaceFile` `updateLlmConfig` `getKernelConfig` `updateKernelConfig` `getWorkspaces` |
| 任务 | `submitTask` `cancelTask` `resumeTask` `deleteTasks` |
| 文件 | `exportWorkspace`（导出 zip → 保存对话框） |
| 事件 | `onKernelStatus(cb)→off` `onKernelEvent(cb)→off` |
| 应用 | `appQuit` `appReload` `toggleDevTools` `pickDirectory` `setWorkspaceDir` `getWorkspaceDir` `openWorkspaceFolder` |

**新增任何 IPC 前必须**：shared/types `LCodeApi` + preload 实现 + main `ipcMain.handle`（内核类用 safeIpc）三处同步；渲染层取返回值**先判空**。

## 9. i18n（src/renderer/src/i18n.ts）

- 双字典 `zh` / `en`（`export const`，`I18nKey = keyof typeof zh`），`useT()` hook 返回按 `lang` 取词的函数。
- ⚠️ `useT()` **每次渲染返回新函数**（非 memo）——**不要把它放进 useEffect 依赖**（会导致 effect 每渲染重跑）；需要翻译但不在 JSX 中时，用 `useAppStore.getState().lang` 直接取词（FileTreePane 内核未就绪提示即此模式）。
- 事件/日志为内核服务端中文，语言切换不影响日志内容。

## 10. 主进程关键行为（main/index.ts）

- **KernelManager**：spawn（dev=python venv / prod=exe，`--port --token --outputs`）、健康轮询 2s、崩溃自动重启、`restart()` **先等旧进程 exit（≤5s）再 start**（否则新进程被旧清理器误杀）。
- **工作目录**：`app:setWorkspaceDir` 写 `userData/workspace.json` → `kernel.setWorkspaceDir` → **`kernel.restart()`**（使 `--outputs` 生效）。**这是文件树在"打开文件夹"后短暂读不到目录的根因窗口**（见 §5.2 重试）。
- 启动顺序：`setWorkspaceDir(持久化值)` → `kernel.start()`（bootstrap 内）。
- 日志：`%APPDATA%\L-CODE\logs\main.log`（UTF-8；`[ipc] 调用失败` / `[kernel-manager]` / `[window]` / `[kernel]` 前缀）。**排查 UI 问题一律先看日志**。

## 11. 回归防护清单（改 UI 前逐条对照）

1. 渲染层任何 IPC 返回值解构前判空（safeIpc 失败 = `null`）。
2. 文件树：根永在顶、文件夹只展开不重生根、无"上级"按钮、展开惰性加载 + 缓存、⟳ 清缓存重拉。
3. 内核重启窗口（换工作目录后约 10–18s）：文件树/首页自动重试或跳过，不得崩、不得刷错误。
4. 顶栏 `pr-[150px]` 右留白与 `-webkit-app-region` 拖拽区不得动；窗口按钮依赖 titleBarOverlay。
5. 三栏布局两种模式（treeLeft/chatLeft）都要验证；设置页切换后即时生效且重启保持。
6. 新增/修改文案：zh/en 双字典同步（`en` 类型约束保证 key 不漏）。
7. 三视图（task/workspace）共用 FileTreePane/ContentView/ChatPane：改共用组件要双视图都回归。
8. 构建验证：`npm run typecheck && npm run build`（desktop 目录）；改完重启应用加载新 bundle（本 GUI 不自动热更渲染产物）。
9. 内核类 IPC 一律 safeIpc 包装；白名单三处同步（types/preload/main）。

## 12. 已知坑位备忘

- electron-vite dev server 端口冲突（5173 僵尸进程）曾导致首启无窗口：`strictPort:false` 自动递增 + 3s 兜底 show 已解决，勿改回 strictPort。
- 工作区根目录持久化在 `%APPDATA%\L-CODE\workspace.json`（不在项目内）；重装/换机需重新选择。
- 文件树根目录的 `pathLabel` 对 `\main` 前缀有特殊截断（历史 outputs 树遗留），改动时注意。
