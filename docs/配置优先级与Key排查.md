# 配置优先级与「设置页填了 Key 却不生效」排查

> 2026-09-13 实测事故记录：用户在 DeepSeek 控制台**重置了 API Key**，然后在 LCode 设置页
> 填了新 Key、点了保存，界面上一切正常，但对话仍然鉴权失败。本文记录**为什么**、**怎么查**、
> **已经怎么修**。

## 1. 一句话结论

**对话不是内核发的，是规划器（DSH 子进程）发的。** 规划器的环境变量在它被 spawn 的那一刻
就定型了 —— 之后在设置页改 Key，只改了内核和磁盘配置，**改不动一个已经在跑的进程的环境**。
重置 Key 之后，那个进程手里还是旧 Key，于是"设置看着生效、对话就是不通"。

## 2. 三个进程，三份配置来源

```
Electron 主进程
  ├─ userData/kernel-env.json      ← 设置页保存的权威配置（%APPDATA%\LCode\kernel-env.json）
  ├─ spawn 内核（Python）          ← 继承主进程环境；dev 模式下还会读 lcode/kernel/.env
  └─ spawn 规划器（Node + DSH）     ← 继承主进程环境；DSH 自己还会看 ~/.dsh/.credentials.yaml
```

| 谁 | 读什么 | 谁优先 |
|---|---|---|
| 内核（Python / FastAPI） | 进程环境 → `.env`（dev）→ 默认值 | 见 §3（已修） |
| 规划器（Node / DSH） | `DEEPSEEK_API_KEY`（进程环境）> `$DSH_HOME/.credentials.yaml` > 调用目录 `.env` > `$DSH_HOME/.env` | 继承环境最高（DSH 的 `credentials-local` 明确如此设计） |
| 设置页读到的值 | 内核 `/api/config` + 本地 `kernel-env.json` | —— 注意：**它不代表规划器拿到了什么** |

## 3. 三个真实 Bug（已修）

### Bug 1 · 规划器拿到的是"第一次设过的 Key"，永远不会变

`lcode/desktop/src/main/index.ts` 的 `applyKernelEnvToProcess()` 旧写法：

```ts
if (!process.env.DEEPSEEK_API_KEY && cfg.llm_api_key) process.env.DEEPSEEK_API_KEY = cfg.llm_api_key
//  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 一旦设过，之后在设置页改 Key 就再也进不来
```

主进程启动时已经从 `kernel-env.json` 填过一次 → 之后每次保存都被这个判断挡掉 → 规划器
重启也只能拿到旧 Key。**已改为"设置页有值就覆盖、清空就删除"。**

### Bug 2 · 改了配置不重启规划器

保存只做了两件事：落盘 + 热更新内核（`POST /api/config`），**没有人去重启规划器**。
`{status:'saved'}` 让界面显示"已保存"，用户自然以为生效了。

**已改为**：LLM 相关字段（`llm_api_key` / `llm_base_url` / `llm_model` / `llm_temperature`）
一旦变化，主进程立刻 `planner.restart(...)` 重建进程环境，并把 `planner_restarting` 回给界面，
设置页显示"规划器正在重启以应用新配置（约 2~5 秒）"。

### Bug 3 · dev 模式下 `.env` 会盖掉设置页的值

`lcode/kernel/config/settings.py` 里 `load_dotenv(BASE_DIR/'.env', override=True)` —— 这句话
把 `.env` 的 `LLM_API_KEY` 写进 `os.environ`，压过桌面注入的值（pydantic 是"环境变量 > .env"，
但此时环境变量已经被 `.env` 覆盖了）。于是**每次内核重启，`.env` 里那把过期 Key 就复活一次**。

**已改为**：主进程注入时声明 `LCODE_CONFIG_AUTHORITY=desktop`，内核先把进程里已有的
`LLM_*` / `IDF_*` 快照下来，加载 `.env` 之后再盖回去 —— 桌面注入的值优先，`.env` 只作缺省。
从终端直接 `python run_kernel.py` 开发时该标记不存在，行为与过去完全一致（`.env` 仍可覆盖
shell 里残留的陈旧变量）。

### 附带发现 · 设置页选的模型会被静默改写

`lcode/planner/src/config.ts`：规划器侧模型目录只认 v4 型号，`deepseek-chat` 会被改写成
`deepseek-v4-flash`（**服务端两者本来就解析到同一档位**，`deepseek-chat` → `deepseek-flash`）。
过去这行改写没有任何提示，于是"设置页明明选了 deepseek-chat"。现在：启动日志明确打印，
`/api/planner/health` 同时回 `model` 与 `requested_model`，设置页并排显示两者。

## 4. 现在怎么查（30 秒定位）

### 4.1 界面

设置页 →「LLM 配置」卡片底部新增一行 **「对话实际生效（规划器进程）」**：

```
对话实际生效（规划器进程）
模型：deepseek-v4-flash（你填的是：deepseek-chat） · Key：****0b2b
```

- 若这行显示 `Key：未注入（走 DSH 凭据文件）`，说明规划器没拿到设置页的 Key，会回退到
  `~/.dsh/.credentials.yaml` —— 那里可能是**另一个完全不同的 Key**。
- 末 4 位与你在设置页填的对不上 → 规划器还没重启，保存一次即可。

### 4.2 日志（`%APPDATA%\LCode\logs\main.log`）

规划器每次启动都会留一行指纹（只有末 4 位，整串绝不落盘）：

```
[planner-manager] LLM: key = ****0b2b | 来源 = 桌面设置页（kernel-env.json） | base = https://api.deepseek.com/v1 | 请求模型 = deepseek-chat
[planner-manager] 规划器生效配置: 模型 = deepseek-v4-flash | 设置页请求 = deepseek-chat | key = ****0b2b | base = https://api.deepseek.com/v1
[planner-manager] 注意: 设置页选的模型 deepseek-chat 在规划器侧被改写为 deepseek-v4-flash（…）
[env] 已保存 LLM 配置: llm_api_key,llm_model | key = ****0b2b | model = deepseek-chat | base = … | 有变化 = true
```

保存动作现在**一定留痕**（`[env] 已保存 LLM 配置`）—— 此前这条路径一行日志都不写，
"我明明保存了"根本无从对证。

### 4.3 直接验证 Key 本身还有没有效

```powershell
# 逐个来源打一次真实调用，只看 HTTP 状态（不要打印完整 Key）
python - <<'PY'
import json, os, pathlib, re, urllib.request, urllib.error
keys = {}
for line in pathlib.Path(r"lcode\kernel\.env").read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\s*LLM_API_KEY\s*=\s*(.+)$", line)
    if m: keys["kernel/.env"] = m.group(1).strip()
keys["设置页(kernel-env.json)"] = json.loads(
    pathlib.Path(os.path.expandvars(r"%APPDATA%\LCode\kernel-env.json")).read_text(encoding="utf-8"))["llm_api_key"]
keys["~/.dsh/.credentials.yaml"] = re.search(r"DEEPSEEK_API_KEY:\s*(\S+)",
    pathlib.Path(os.path.expanduser("~/.dsh/.credentials.yaml")).read_text(encoding="utf-8")).group(1)
for name, k in keys.items():
    req = urllib.request.Request("https://api.deepseek.com/v1/chat/completions",
        data=json.dumps({"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"max_tokens":1}).encode(),
        headers={"Content-Type":"application/json","Authorization":"Bearer "+k})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: print(f"{name:28s} {k[:7]}****  HTTP {r.status} OK")
    except urllib.error.HTTPError as e: print(f"{name:28s} {k[:7]}****  HTTP {e.code}  {e.read()[:120].decode('utf-8','replace')}")
PY
```

本次实测结果（3 把 Key 同时存在，只有 2 把有效）：

| 来源 | 结果 |
|---|---|
| `lcode/kernel/.env` | **HTTP 401** `Your api key: ****bed9 is invalid`（重置前那把，已失效） |
| 设置页 `kernel-env.json` | HTTP 200 ✓ |
| `~/.dsh/.credentials.yaml`（DSH GUI 用的） | HTTP 200 ✓（**另一把 Key**，与 LCode 无关） |

## 5. 重置 Key 之后的正确操作顺序

1. 控制台重置 Key（旧 Key 立刻失效）；
2. LCode 设置页 → 填新 Key → 保存（现在会重启规划器，等 2~5 秒）；
3. 点「测试连接」确认 `连接正常 · 实际服务模型：deepseek-flash`；
4. 看设置页底部那行，确认末 4 位是新 Key；
5. 跑一次编译/对话验证。

`.env` 只是**兜底**：桌面启动的内核/规划器以设置页为准，所以 `.env` 里留着旧 Key 不再有害
（但为了让"从终端直跑内核"也能用，本次已把 `.env` 的 `LLM_API_KEY` 同步为设置页那把有效 Key）。

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `lcode/desktop/src/main/index.ts` | `applyKernelEnvToProcess()` / `restartPlannerForConfig()` / `pushEnvConfigToKernel()` / `kernel:updateLlmConfig` |
| `lcode/desktop/src/main/planner-manager.ts` | 规划器 spawn 的 LLM 环境选择 + 指纹日志 + `llmInfo()` |
| `lcode/kernel/config/settings.py` | `LCODE_CONFIG_AUTHORITY` 优先级的实现 |
| `lcode/planner/src/config.ts` | v4 模型改写（现在会打日志并回传 `requested_model`） |
| `lcode/planner/src/plugins/server.ts` | `/api/planner/health` 回传 LLM 身份 |
