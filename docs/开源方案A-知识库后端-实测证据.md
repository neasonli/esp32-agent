# 开源方案 A · 知识库接缝 —— 实测证据（2026-09-12）

> 本文记录「私有知识库包 `lcode-kb` + 公开仓接缝 + 通用降级 stub」这套方案落地时**实际跑出来**的
> 命令与输出。每条都给了「怎么跑 → 看到什么 → 因此判定什么」，方便日后回归或换机器复现。
>
> 相关文档：`docs/开源发布清单.md`（§0.5 决策 / §2.3 方案 / §0.8 解释器与阶段1 迁出）。
> 注意该清单是**内部**发布文档，不随公开导出发布（导出脚本按前缀排除）；本文档则随仓发布。

## 0. 路径与基线约定

| 记号 | 实际路径 |
|---|---|
| `$KERNEL` | `D:\1_ai_project\mcu_ai_agent\lcode\kernel`（公开仓里的内核） |
| `$PY` | `$KERNEL\.venv\Scripts\python.exe`（内核解释器；桌面端解析顺序命中它） |
| `$KB` | `D:\1_ai_project\lcode-kb`（**私有仓**，闭源，仓库外同级目录） |
| `$DESKTOP` | `D:\1_ai_project\mcu_ai_agent\lcode\desktop` |

基线数值（本机）：

- 向量库条数 **634**；`vectors.npy` ≈ 1.24 MB、`meta.json` ≈ 0.45 MB
- embedding：`BAAI/bge-small-zh-v1.5`（device=cpu）
- 内核 venv Python **3.10.11**；torch 固定 **2.6.0**（更高版本在 Win10 22H2 上 `c10.dll` 加载失败）

---

## 1. 私有包可用性：装上了、且不拖慢启动

**命令**

```powershell
$PY -c "import lcode_kb; print('version', lcode_kb.__version__); print(lcode_kb.info()); import sys; print('torch imported at import time?', 'torch' in sys.modules)"
```

**实测输出**

```
version 0.1.0
{'backend': 'private', 'version': '0.1.0', 'store_dir': 'D:\\1_ai_project\\lcode-kb\\data\\rag_store', 'docs': 634, 'embedding_model': 'BAAI/bge-small-zh-v1.5'}
torch imported at import time? False
```

**判定**

- 包已装（editable）且能自述状态；`store_dir` 指向**私有仓**的数据目录，不是公开仓。
- `import lcode_kb` **不触发 torch** → 契约函数内部惰性导入生效，内核启动不被几秒的模型加载拖慢。
- `docs: 634` 说明向量库本体确实被私有包读到（公开仓已无 `data/rag_store`）。

---

## 2. 私有仓真检索：能命中手册

**命令**

```powershell
cd $KB
$PY tests\smoke_retrieval.py
```

**实测输出**（节选）

```
后端自述: {'backend': 'private', 'version': '0.1.0', 'store_dir': 'D:\\1_ai_project\\lcode-kb\\data\\rag_store', 'docs': 634, 'embedding_model': 'BAAI/bge-small-zh-v1.5'}
向量库条数: 634

=== 查询1: MPU-6050 I2C 寄存器（无芯片过滤）===
  [unknown] 外设手册\MPU-6050.pdf: The MPU-6000 and MPU-6050 are identical, except that the MPU-6050 supp...
  [unknown] 外设手册\MPU-6050.pdf: MPU-6000/MPU-6050 Product Specification 
  [unknown] 外设手册\MPU-6050.pdf: I2C is a two -wire interface comprised of the signals serial data (SDA...

=== 查询2: esp32s3 GPIO 引脚（严格芯片过滤）===
  结果数: 3 （语料里没有 esp32s3 标签的文档时应为 0）

=== 查询3: 温湿度传感器（无过滤）===
  [esp32s3] 芯片手册\esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf: or I/O load. Generally, the chip internal temperature is higher than...
  [unknown] 外设手册\Goertek-SPL06-007_C233787.pdf: Ramp-down rate 4°C/seconds max. ...

RETRIEVAL_TEST_DONE
exit=0
```

**判定**：闭源实现搬运后功能等价（同一批语料、同一 embedding、同一 numpy 余弦检索）；
`chip` 过滤仍按 metadata 生效（查询2 有 3 条 esp32s3 标签命中，查询3 无过滤时同时命中芯片手册与外设手册）。

---

## 3. 公开仓接缝：5 个用例全过

**命令**

```powershell
cd $KERNEL
$PY tests\smoke_kb_backend.py
```

**实测输出**

```
=== 1) 缺省 auto（本机当前环境）===
  backend=private available=True docs=634
  已导入的重依赖: 无（private 模式下 torch 由私有包惰性加载）

=== 2) auto + 私有包不可用 → 必须降级 stub、零重依赖 ===
  backend=stub available=False docs=0
  note=私有知识库包未安装（ModuleNotFoundError: import of lcode_kb halted; None in sys.modules）
  已导入的重依赖: 无

=== 3) 强制 stub ===
  backend=stub heavy=无

=== 4) 强制 private + 私有包不可用 → 必须明确报错 ===
  exit=1（期望非 0）| 报错含关键词: True

=== 5) 强制 private + 私有包可用 → 命中 private 且读出条数 ===
  backend=private docs=634 store=D:\1_ai_project\lcode-kb\data\rag_store

KB_BACKEND_TEST_PASSED
exit=0
```

**判定**

| 用例 | 证明了什么 |
|---|---|
| ① auto + 有包 | 默认路径就是 private，且**不预加载任何重依赖** |
| ② auto + 无包 | 缺私有包时**静默降级** stub，不抛错 → 公开仓 clone 下来就能跑 |
| ③ 强制 stub | `LCODE_KB_BACKEND=stub` 生效；`torch / sentence_transformers / langchain_huggingface / langchain_community / langchain_text_splitters / chromadb / pypdf` **一个都没进 `sys.modules`** → 「轻量 `requirements.txt` 就够跑」成立 |
| ④ 强制 private + 无包 | **故意报错**且带可诊断关键词，不静默降级（生产/授权环境要早暴露） |
| ⑤ 强制 private + 有包 | 契约调用链通，条数读得到 |

> 「私有包不可用」的模拟方式：`sys.modules['lcode_kb'] = None` 注入（import 即抛 ImportError）。
> **不要**用 PYTHONPATH 挡板文件——editable 安装装的是 MetaPathFinder（`__editable___lcode_kb_0_1_0_finder.py`），
> 优先级高于 `sys.path`，挡不住（本机已实测踩坑）。

---

## 4. 内核 `/api/health`：两种后端各自的状态

**命令（两种模式各起一次内核）**

```powershell
$env:LCODE_KB_BACKEND='stub'      # 或清掉该变量 = auto
$PY -u run_kernel.py --port 18233 --token kb-stub-test
# 另一个窗口：用 Node fetch（避免 PowerShell 解码干扰，见附录 B）
node -e "fetch('http://127.0.0.1:18233/api/health',{headers:{'X-Kernel-Token':'kb-stub-test'}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

**实测输出（stub）**

```json
{
  "status": "ok", "app": "L-CODE Kernel", "version": "0.2.0-kernel",
  "kernel_mode": true, "concurrency": 2,
  "llm_configured": true, "llm_model": "deepseek-chat",
  "embedding_model": "BAAI/bge-small-zh-v1.5",
  "idf_py": "D:\\esp\\frameworks\\esp-idf-v5.5.5\\tools\\idf.py", "idf_target": "esp32s3",
  "kb_backend": "stub", "kb_available": false, "kb_docs": 0,
  "kb_note": "LCODE_KB_BACKEND 指定使用通用模式（rag/stub.py）", "kb_version": "-"
}
```

**实测输出（auto → private）**

```json
{
  "kb_backend": "private", "kb_available": true, "kb_docs": 634, "kb_note": "",
  "kb_store_dir": "D:\\1_ai_project\\lcode-kb\\data\\rag_store", "kb_version": "0.1.0"
}
```

内核启动日志（同样两条）：

```
[rag] 知识库后端: stub（LCODE_KB_BACKEND=stub）
[rag] 提示: 私有知识库包未安装（ModuleNotFoundError: ...）
[rag] 知识库后端: private（LCODE_KB_BACKEND=auto）
```

**判定**：`kb_*` 字段是桌面端「手册检索」亮/灰的唯一数据源；stub 下内核其余能力照常
（`llm_configured: true`、`idf_py` 有效），即"降级的只有手册检索"。

---

## 5. 降级话术：不让模型编造寄存器

**命令**（模拟公开仓环境跑 `rag_search` 节点）

```powershell
# _kb_node_probe.py
import json, sys, io
sys.modules['lcode_kb'] = None            # 模拟无私有包
from agent.state import AgentState
from agent.nodes.rag_search import node_rag_search
st = AgentState(task_id='t', user_requirement='实现 ESP32-S3 温湿度采集', chip_model='esp32s3')
out = node_rag_search(st)
io.open('outputs/_kb_node_probe.json','w',encoding='utf-8').write(json.dumps({'info': out['chip_datasheet_info']}, ensure_ascii=False, indent=2))
```

**实测输出**

```json
{
  "info": "（未启用领域知识库：本次不提供手册资料，请只依据通用芯片知识作答，涉及具体寄存器/引脚时明确标注需人工核对）"
}
```

**判定**：stub 不是"给个空字符串了事"——注入的是**明确的免责与行为约束**；
private 模式下真命中不到时才是另一句话（"知识库无匹配资料：请先建库…"）。

---

## 6. 真实应用链路（最强证据：渲染 → preload → 主进程 → 内核）

以 `$DESKTOP\npm run dev` 启动真实窗体，读 `%APPDATA%\L-CODE\logs\main.log`。

**private（正常，`LCODE_KB_BACKEND` 未设）**

```
[2026-09-12T16:57:02.323Z]   python 候选 [内核自带 lcode/kernel/.venv] = D:\...\lcode\kernel\.venv\Scripts\python.exe (exists: true )
[2026-09-12T16:57:02.323Z]   python 候选 [阶段1 .venv（历史兼容）] = D:\...\embedded_agent_stage1\.venv\Scripts\python.exe (exists: false )
[2026-09-12T16:57:08.656Z] [kernel-manager] 健康检查通过，内核就绪 pid= 12416
[2026-09-12T16:57:15.264Z] [kb] 后端 = private | 可用 = true | 向量数 = 634 
[2026-09-12T16:57:21.190Z] [planner-manager] 健康检查通过，规划器就绪 pid= 19044
```

**stub（`$env:LCODE_KB_BACKEND='stub'` 后启动同一窗体）**

```
[2026-09-12T16:58:11.807Z] [kernel-manager] 健康检查通过，内核就绪 pid= 17712
[2026-09-12T16:58:13.568Z] [kb] 后端 = stub | 可用 = false | 向量数 = 0 | LCODE_KB_BACKEND 指定使用通用模式（rag/stub.py）
[2026-09-12T16:58:24.014Z] [planner-manager] 健康检查通过，规划器就绪 pid= 16484
```

**判定**

- renderer 挂载 Home/设置页时会调 `kernel:kbStatus`（日志 3 行 = 多次挂载调用），
  主进程转发内核 `/api/health` 并落盘 → 整条 IPC 链路可用；
- private 下 Home「🔍 手册检索」为**绿色**，stub 下为**置灰 + tooltip**（同一布尔值驱动）；
- 内核/规划器在两种模式下都正常就绪 → 后端切换不影响其它能力。

---

## 7. 编译与导出安全

```powershell
cd $DESKTOP
npm run typecheck            # exit 0
npx electron-vite build      # exit 0（out/renderer 411.12 kB、out/preload 4.64 kB）

cd D:\1_ai_project\mcu_ai_agent
powershell -ExecutionPolicy Bypass -File tools\make-public-export.ps1
```

**导出结果**

```
files: 127   size: 1.23 MB
  .gitattributes 1 / .gitignore 1 / docs 8 / lcode 111 / LICENSE 1 / NOTICE 1 / README.md 1 / third_party 1 / tools 1 / 启动-LCODE-桌面开发.bat 1
OK: no .env, private keys, vendor PDFs, third-party app dumps or hardcoded API keys.
```

导出目录内自查：

```
lcode\kernel\rag\      → backend.py / stub.py / __init__.py   （无 retriever/vector_store/load_docs）
lcode\kernel\tests\    → smoke_compile / smoke_core / smoke_kb_backend / smoke_phase3 / smoke_sandbox
lcode\kernel\data\     → 不存在
lcode\kernel\assets\   → PDF 数 = 0
requirements.txt 依赖行 → langgraph / langgraph-checkpoint-sqlite / langchain / openai / fastapi /
                          uvicorn / python-multipart / pydantic / pydantic-settings / python-dotenv
                          （torch、sentence-transformers、langchain-community、langchain-huggingface、
                            chromadb、pypdf、numpy 全部为 False）
```

**判定**：闭源件（实现 + 向量库 + 语料）确实不在导出物里；公开仓 `requirements.txt`
不含任何重依赖；`smoke_kb_backend.py` 随公开仓发布（零重依赖，适合做 CI）。

> 补记：本文档入库后重跑导出 → `128 files / 1.24 MB`、`docs 9`（其余统计不变），安全扫描仍 `OK`。
> 内部文档 `docs/开源发布清单.md` 始终被排除（导出脚本按文件名前缀跳过，见 §8 第 2 条）。

---

## 8. 过程中发现并修掉的问题

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| 1 | 走私有后端时 `.env` 完全没生效（HF 镜像、EMBEDDING_MODEL 等读不到） | 旧接缝把 `from config.settings import settings` 放在**降级分支**里，private 路径从不导入它 | `rag/backend.py` 改为模块**顶层**先加载 settings，两种后端共用 |
| 2 | 内部文档没能被导出脚本排除（docs 仍是 9 个文件） | 脚本要求纯 ASCII，而无 BOM 的 `.ps1` 被 Windows PowerShell 5.1 按 ANSI 读 → 中文字面量解错、匹配不上 | 文件名改用**码点构造**（`0x5F00,0x6E90,…`）并改为前缀匹配；脚本仍是纯 ASCII（最大字节 125） |
| 3 | 以为 `/api/health` 的中文 `kb_note` 编码坏了 | PowerShell 5.1 把 UTF-8 响应按 Latin-1 解 → 控制台乱码；**服务端没问题** | 复核方式改为 Node `fetch` 落盘 + 读文件（见附录 B） |
| 4 | `PYTHONPATH` 挡板模拟"私有包未安装"无效 | editable 安装是 MetaPathFinder，优先于 `sys.path` | 改用 `sys.modules['lcode_kb'] = None` 注入 |
| 5 | 用 `$env:X ?? 'x'` 的脚本整段解析失败、内核根本没起 | 该 shell 是 PowerShell 5.1，不支持 `??`（空合并） | 一律用 `if (-not $x) {…}`；脚本失败要**先看是不是脚本自己**，别急着怀疑被测系统 |

---

## 9. 一键复跑（回归用）

```powershell
# ① 私有包可导入 + 不加载 torch
$PY -c "import lcode_kb; print(lcode_kb.info()); import sys; print('torch' in sys.modules)"

# ② 公开仓接缝 5 用例（期望 KB_BACKEND_TEST_PASSED）
cd $KERNEL; $PY tests\smoke_kb_backend.py

# ③ 私有仓真检索（期望 634 条 + 命中手册）
cd $KB; $PY tests\smoke_retrieval.py

# ④ 内核两种后端状态
$PY -u run_kernel.py --port 18233 --token t     # 另一窗口用 Node fetch /api/health

# ⑤ 桌面端链路（期望 main.log 出现 [kb] 行）
cd $DESKTOP; npm run dev

# ⑥ 类型检查/构建/导出
cd $DESKTOP; npm run typecheck; npx electron-vite build
cd D:\1_ai_project\mcu_ai_agent; powershell -ExecutionPolicy Bypass -File tools\make-public-export.ps1
```

---

## 附录 A · 相关但别处记录的验证（同一轮闭源工作）

| 项 | 证据 | 结论 |
|---|---|---|
| 内核解释器三级回退 | `main.log`：`python 候选 [内核自带 lcode/kernel/.venv] = … (exists: true)`、`[阶段1 .venv] … (exists: false)` | 命中第 2 级；阶段1 目录迁出后内核照常启动 |
| 阶段1 目录迁出 | `embedded_agent_stage1` → `D:\1_ai_project\_lcode-archive\embedded-agent-stage1-2026-09-12`（43,227 files / 2,247.9 MB）；随后内核 `/api/health` = `status: ok` | 唯一依赖是解释器（已复制到 `lcode/kernel/.venv`），迁出不影响运行 |
| 公开仓闭源件清点 | 导出 127 files / 1.23 MB + 安全扫描 OK；`lcode/server` 与 `embedded_agent_stage1` 均不在仓库内 | 授权服务端、阶段1 原型、知识库实现与语料都不进公开仓 |

## 附录 B · 读中文输出的正确姿势（本机反复踩过）

| 场景 | 别用 | 改用 |
|---|---|---|
| 看内核 HTTP 响应里的中文 | `Invoke-RestMethod`（PS 5.1 按 Latin-1 解 → `æå®…`） | Node `fetch(...).then(r=>r.json())`，或用 Python 以 `encoding='utf-8'` 写文件后读文件 |
| 看 Python 进程的中文 stdout | `Select-String` / `Out-File`（按 ANSI 解） | 让脚本自己 `io.open(path,'w',encoding='utf-8')` 落盘 |
| 判定"是不是真的编码坏了" | 看控制台乱码下结论 | **落盘 + 读文件**：同一字符串正确显示 → 只是控制台解码问题 |

> 结论：本题中 `kb_note`、`[rag] 提示`、`rag_search` 注入文本**全部编码正确**，
> 只有 PowerShell 控制台显示乱码。别据此改代码。
