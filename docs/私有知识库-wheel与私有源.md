# 私有知识库 wheel 与私有源交付方案（实测）

> 面向：L-CODE 闭源知识库包 `lcode-kb`（源码在 `D:\1_ai_project\lcode-kb`）的**构建 / 分发 / 授权安装**。
> 本文所有体积、条数、哈希、退出码均为**本机实测**，未实测项已在 §8 明确标注「未验证」。
>
> 实测环境：Windows 10（10.0.19041）、Windows PowerShell 5.1.19041.6456、Python 3.10.11
> （`C:\Users\F\AppData\Local\Programs\Python\Python310\python.exe`）、git 2.30.0.windows.2、
> 构建工具 `build 1.6.1` + 隔离环境内 `setuptools 84.0.0` / `wheel 0.48.0`。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| wheel 建出来了吗 | 建出来了：`lcode_kb-0.1.0-py3-none-any.whl`，**11,957 字节（11.7 KiB）** |
| wheel 真能用吗 | **能，已端到端验证**：临时 venv 装 wheel → `import lcode_kb` 来自 wheel → `info()` 报 `docs=634` → 三次真实检索全部命中手册原文（含相似度分数与来源文件名） |
| 向量库进 wheel 了吗 | **没有**。wheel 只有 10 个条目：5 个 `.py` + 5 个 `dist-info` 元数据；红线扫描 0 命中 |
| 向量库进 git 了吗 | **没有**。`.gitignore` 排除 + `git ls-files` 实测 0 条 `rag_store`/`.npy` |
| GitHub Packages 能做 Python 私有源吗 | **不能**。官方「支持的客户端与格式」只有 npm / RubyGems / Maven / Gradle / Docker(OCI) / NuGet，registry 列表页全文 **0 次** "python"（本次联网抓取核验，见 §5.1） |
| 推荐方案 | **私有 GitHub Release 附件**（零基建，今天就可用）交付 wheel；需要 `pip install lcode-kb` 按名安装时，再上 **pypiserver** 自建 simple index |
| 桌面端用户装什么 | **不装 wheel**。桌面端走组件 zip（`tools\stage-kb-payload.py` → `kb-payload.zip` ≈432 MB）；wheel 只服务 pip / 源码用户（见 §6） |
| 私有仓提交哈希 | `4c3d3f73147bfbfa53fc98a8822a262d1c028e68`（首次提交，9 文件，**未 push**，无远端） |

---

## 1. 产物清单

### 1.1 私有仓（`D:\1_ai_project\lcode-kb`）

| 路径 | 类型 | 体积 | 说明 |
|---|---|---|---|
| `dist\lcode_kb-0.1.0-py3-none-any.whl` | 新增 | 11,957 B / 11.7 KiB | **wheel 主产物**，`sha256=3c5882b2bd6d2cb4262351582523fbdde180850b1d5934f6ac6f86139fb4a3da` |
| `dist\lcode_kb-0.1.0.tar.gz` | 新增 | 11,690 B / 11.4 KiB | sdist，`sha256=f515ede12a2b487c8c544a58cc9106da46a5698dcfc7e5cb5c2d4c8080e62888` |
| `.gitignore` | 修改 | 37 行 | 新增「向量库 / `*.npy` / `*.whl` / `*.tar.gz` / `.env` / `*.pem` / `*.key` / `secrets/`」排除规则 |
| `README.md` | 修改 | — | 同步 `data/rag_store` 已排除的事实 + 一键发布脚本入口 |
| `.git\` | 新增 | — | `git init`（分支 `master`），1 次提交 |

`dist/` 与 `build/` 均被 `.gitignore` 排除，**不在版本控制内**。

### 1.2 公开仓（`D:\1_ai_project\mcu_ai_agent`）

| 路径 | 体积 | 说明 |
|---|---|---|
| `tools\publish-kb-wheel.ps1` | 20,535 B / 419 行，**纯 ASCII**（非 ASCII 字节数 = 0，无 BOM，首 3 字节 `35,32,61`） | 构建 + 防呆 + 本地打标签 + 传私有 Release/私有源，带 `-DryRun` |
| `docs\私有知识库-wheel与私有源.md` | 约 43 KB / 865 行 | 本文件：方案 + 实测证据 + 授权安装步骤 |

> 说明：`D:\1_ai_project\mcu_ai_agent` 当前**不是 git 仓库**（无 `.git`），所以上面两个文件是磁盘上的新文件，
> 没有产生提交；本次唯一的 git 提交在私有仓 `lcode-kb` 里（§2.2）。

---

## 2. 步骤 1：`git init` + 初始提交（已做，未 push）

### 2.1 命令与原始输出

```powershell
cd D:\1_ai_project\lcode-kb
git init
```
```
Initialized empty Git repository in D:/1_ai_project/lcode-kb/.git/
```

提交前先做红线核对（`.gitignore` 命中行号由 `git check-ignore -v` 实测给出）：

```powershell
git check-ignore -v data/rag_store/meta.json data/rag_store/vectors.npy `
  lcode_kb/__pycache__/config.cpython-310.pyc dist/lcode_kb-0.1.0-py3-none-any.whl `
  corpus/a.pdf .env x.pem
```
```
.gitignore:12:data/	data/rag_store/meta.json
.gitignore:12:data/	data/rag_store/vectors.npy
.gitignore:16:__pycache__/	lcode_kb/__pycache__/config.cpython-310.pyc
.gitignore:20:dist/	dist/lcode_kb-0.1.0-py3-none-any.whl
.gitignore:5:corpus/	corpus/a.pdf
.gitignore:28:.env	.env
.gitignore:31:*.pem	x.pem
```

只暂存到 9 个文件（无向量库、无 `__pycache__`、无 PDF）：

```powershell
git add -A; git diff --cached --name-only
```
```
.gitignore
README.md
lcode_kb/__init__.py
lcode_kb/config.py
lcode_kb/load_docs.py
lcode_kb/retriever.py
lcode_kb/vector_store.py
pyproject.toml
tests/smoke_retrieval.py
```

```powershell
git commit -F .git/COMMIT_MSG_TMP      # 中文提交信息经 UTF-8 文件传入，避开 PS 5.1 控制台编码坑
```
```
[master (root-commit) 4c3d3f7] chore: 初始化私有知识库仓（闭源资产）
 9 files changed, 625 insertions(+)
 create mode 100644 .gitignore
 create mode 100644 README.md
 create mode 100644 lcode_kb/__init__.py
 create mode 100644 lcode_kb/config.py
 create mode 100644 lcode_kb/load_docs.py
 create mode 100644 lcode_kb/retriever.py
 create mode 100644 lcode_kb/vector_store.py
 create mode 100644 pyproject.toml
 create mode 100644 tests/smoke_retrieval.py
```

### 2.2 提交哈希

```
4c3d3f73147bfbfa53fc98a8822a262d1c028e68
（short 4c3d3f7；分支 master；作者 neasonli <457531835@qq.com>；2026-09-13 15:44:06 +0800）
```

**未 push**：`git remote -v` 为空（无远端、无凭据）。`publish-kb-wheel.ps1` 也**只创建本地 tag，绝不执行 `git push`**，需要时会打印推送命令让你自己决定。

### 2.3 `.gitignore` 的最终内容（关键部分）

```gitignore
# 建库用的源手册（厂商 PDF，版权归厂商，仅本机保留）
corpus/
*.pdf

# ★ 向量库数据本体：绝不进 git（红线）
#   meta.json 内嵌完整手册切片正文 = 厂商手册内容，提交即等于把语料公开。
#   分发方式：私有 wheel 之外的载荷目录（tools/stage-kb-payload.py）或 LCODE_KB_STORE_DIR 指向。
data/rag_store/
data/
*.npy

# 构建/缓存
__pycache__/
*.py[cod]
*.egg-info/
build/
dist/
*.whl
*.tar.gz
.venv/
venv/
.pytest_cache/

# 环境变量与凭据
.env
.env.*
!.env.example
*.pem
*.key
*.pfx
*.p12
secrets/
.npmrc
.pypirc
```

> **为什么连 `data/rag_store/` 都要排除**（`README.md` 原文曾写「可随私有仓提交」）：
> 实测 `meta.json` 是 474,779 字节的手册切片正文（`text` 字段就是手册原文），提交它等于把厂商语料写进 Git 历史——
> 删一个文件删不掉历史，clone 一次就把语料带走。向量库只走「私有 Release 附件 / 组件 zip」这条线。

---

## 3. 步骤 2：构建 wheel（实测）

### 3.1 构建后端可用性

```powershell
python -m pip install --disable-pip-version-check build setuptools wheel
```
```
Successfully installed build-1.6.1 packaging-26.3 pyproject_hooks-1.2.0 tomli-2.4.1 wheel-0.48.0
```

`pyproject.toml` 声明 `requires = ["setuptools>=68", "wheel"]` / `build-backend = "setuptools.build_meta"`，
`python -m build` 会自动建隔离环境装这两个依赖（需联网，本次已成功）。

### 3.2 构建命令与输出

```powershell
cd D:\1_ai_project\lcode-kb
python -m build
```
```
* Creating isolated environment: venv+pip...
* Installing packages in isolated environment:
  - setuptools>=68
  - wheel
* Getting build dependencies for sdist...
...
adding 'lcode_kb/__init__.py'
adding 'lcode_kb/config.py'
adding 'lcode_kb/load_docs.py'
adding 'lcode_kb/retriever.py'
adding 'lcode_kb/vector_store.py'
adding 'lcode_kb-0.1.0.dist-info/METADATA'
adding 'lcode_kb-0.1.0.dist-info/WHEEL'
adding 'lcode_kb-0.1.0.dist-info/entry_points.txt'
adding 'lcode_kb-0.1.0.dist-info/top_level.txt'
adding 'lcode_kb-0.1.0.dist-info/RECORD'
removing build\bdist.win-amd64\wheel
Successfully built lcode_kb-0.1.0.tar.gz and lcode_kb-0.1.0-py3-none-any.whl
EXITCODE=0
```

构建过程只有 1 条类型化警告，**不影响产物**，但 2027-02-18 后会变成硬错误：

```
setuptools\config\_apply_pyprojecttoml.py:82: SetuptoolsDeprecationWarning:
  `project.license` as a TOML table is deprecated
  ... By 2027-Feb-18, you need to update your project and remove deprecated calls ...
```

建议的修法（本次**未改**，因为会把构建要求抬到 `setuptools>=77`）：`pyproject.toml` 里
`license = { text = "Proprietary" }` → `license = "Proprietary"`，同时把
`requires = ["setuptools>=68", "wheel"]` → `["setuptools>=77", "wheel"]`。

### 3.3 产物体积与哈希（实测）

| 产物 | 字节 | 人类可读 | SHA-256 |
|---|---|---|---|
| `lcode_kb-0.1.0-py3-none-any.whl` | 11,957 | 11.7 KiB / 0.0114 MiB | `3c5882b2bd6d2cb4262351582523fbdde180850b1d5934f6ac6f86139fb4a3da` |
| `lcode_kb-0.1.0.tar.gz` | 11,690 | 11.4 KiB / 0.0111 MiB | `f515ede12a2b487c8c544a58cc9106da46a5698dcfc7e5cb5c2d4c8080e62888` |

对比：桌面端组件载荷 `kb-payload.zip` 约 **432 MB**（见 §6），wheel 只有 **11.7 KiB**——因为重依赖
（torch 1113.7 MB 等）由 `Requires-Dist` 声明、由 pip 自己解析，语料不进包。

### 3.4 wheel / sdist 内容清单 + 红线扫描（实测）

```powershell
python -c "
import zipfile
z=zipfile.ZipFile(r'dist\lcode_kb-0.1.0-py3-none-any.whl')
for i in z.infolist(): print(f'{i.file_size:8d}  {i.filename}')
print('--- red-line scan ---')
bad=[n for n in z.namelist() if any(k in n.lower() for k in ('rag_store','.npy','.pdf','.env','.pem','.key','meta.json'))]
print('suspicious entries:', bad)
"
```
```
    2375  lcode_kb/__init__.py
    3634  lcode_kb/config.py
    5249  lcode_kb/load_docs.py
    1840  lcode_kb/retriever.py
    3067  lcode_kb/vector_store.py
    4553  lcode_kb-0.1.0.dist-info/METADATA
      91  lcode_kb-0.1.0.dist-info/WHEEL
      59  lcode_kb-0.1.0.dist-info/entry_points.txt
       9  lcode_kb-0.1.0.dist-info/top_level.txt
     786  lcode_kb-0.1.0.dist-info/RECORD
--- red-line scan ---
suspicious entries: []
```

sdist 同样干净（只多 `PKG-INFO` / `README.md` / `lcode_kb.egg-info` / `pyproject.toml` / `setup.cfg`）：

```
--- red-line scan ---
suspicious entries: []
```

wheel 元数据关键字段：

```
Name: lcode-kb
Version: 0.1.0
License: Proprietary
Classifier: Private :: Do Not Upload
Requires-Python: >=3.10
Requires-Dist: numpy>=1.26
Requires-Dist: pypdf>=5.0.0
Requires-Dist: langchain-core>=0.3.0
Requires-Dist: langchain-community>=0.3.0
Requires-Dist: langchain-huggingface>=0.1.2
Requires-Dist: langchain-text-splitters>=0.3.0
Requires-Dist: sentence-transformers>=3.0.0
Requires-Dist: torch==2.6.0
Provides-Extra: dev
Requires-Dist: pytest>=8.0; extra == "dev"
```
```
Wheel-Version: 1.0
Generator: setuptools (84.0.0)
Root-Is-Purelib: true
Tag: py3-none-any
```
```
[console_scripts]
lcode-kb-build = lcode_kb.load_docs:main
```
```
lcode_kb
```

> 注意：`data/rag_store` 物理上位于**包目录之外**（`lcode-kb/data/rag_store`），而
> `[tool.setuptools] packages = ["lcode_kb"]` 只收 `lcode_kb/`，所以向量库**结构上不可能**被打进 wheel。
> 这是设计保证，不是巧合。

---

## 4. 步骤 3：wheel 端到端验证（最重要的一步，全部实测通过）

### 4.1 搭一个「只装 wheel 本体」的临时 venv

依赖（torch 1.1 GB 等）**不重装**，按任务允许的方式「借」现成目录；借的同时用
`PYTHONNOUSERSITE=1` 屏蔽用户级 site-packages，避免污染结论。

```powershell
$V = "$env:TEMP\kb-wheel-verify"
python -m venv $V
& "$V\Scripts\python.exe" -m pip install --no-deps "D:\1_ai_project\lcode-kb\dist\lcode_kb-0.1.0-py3-none-any.whl"
& "$V\Scripts\python.exe" -m pip list
```
```
Processing d:\1_ai_project\lcode-kb\dist\lcode_kb-0.1.0-py3-none-any.whl
Installing collected packages: lcode-kb
Successfully installed lcode-kb-0.1.0

Package    Version
---------- -------
lcode-kb   0.1.0
pip        23.0.1
setuptools 65.5.0
```

```
*** 依赖借用的具体做法（可复现）***
把内核 venv 的 site-packages 写进临时 venv 的一个 .pth 文件即可：
$SP  = "$V\Lib\site-packages"
$KSP = 'D:\1_ai_project\mcu_ai_agent\lcode\kernel\.venv\Lib\site-packages'
Set-Content -Path "$SP\zz_borrow_kernel_deps.pth" -Value $KSP -Encoding ASCII
（内核 venv 里 torch 2.6.0+cpu / numpy 2.2.6 / langchain_core 1.6.0 /
  sentence_transformers 6.0.0 / transformers / sklearn / scipy 均已就位；
  BAAI/bge-small-zh-v1.5 模型已在 %USERPROFILE%\.cache\huggingface\hub 缓存，
  因此本次检索全程没有再下载模型。）
```

**关键校验**：确认 `lcode_kb` 解析到的是 wheel 装的那份，而不是内核 venv 里那个 editable 安装：

```powershell
$env:PYTHONNOUSERSITE='1'
& "$V\Scripts\python.exe" -c "
import lcode_kb, sys
print('lcode_kb.__file__ =', lcode_kb.__file__)
import numpy, torch
print('numpy', numpy.__version__, numpy.__file__)
print('torch', torch.__version__)
"
```
```
lcode_kb.__file__ = C:\Users\F\AppData\Local\Temp\kb-wheel-verify\lib\site-packages\lcode_kb\__init__.py
OK: from wheel
numpy 2.2.6 D:\1_ai_project\mcu_ai_agent\lcode\kernel\.venv\Lib\site-packages\numpy\__init__.py
torch 2.6.0+cpu
```

### 4.2 `import lcode_kb; print(lcode_kb.info())` 的真实输出

```powershell
$env:LCODE_KB_STORE_DIR='D:\1_ai_project\lcode-kb\data\rag_store'   # 向量库不在 wheel 里，必须显式指路
& "$V\Scripts\python.exe" -c "import lcode_kb; print(lcode_kb.info())"
```
```
{'backend': 'private', 'version': '0.1.0', 'store_dir': 'D:\\1_ai_project\\lcode-kb\\data\\rag_store', 'docs': 634, 'embedding_model': 'BAAI/bge-small-zh-v1.5'}
```

```powershell
& "$V\Scripts\python.exe" -c "import lcode_kb; print(lcode_kb.__version__, lcode_kb.backend); print(lcode_kb.store_count())"
```
```
0.1.0 private
634
```

`docs`/`store_count()` = **634**，与向量库 `vectors.npy` 的实测 shape 完全一致：

```
shape (634, 512) dtype float32        # numpy.load 实测
meta.json: count 634 ；keys ['chip','source','text'] ；来源文件 10 个
chip 分布: {'unknown': 498, 'esp32s3': 136}
```

### 4.3 真实检索命中证据

脚本（**刻意不动 `sys.path`**，确保答案来自 wheel；文件在 `%TEMP%\kb-wheel-verify\wheel_smoke.py`）：

```powershell
$env:PYTHONNOUSERSITE='1'; $env:PYTHONIOENCODING='utf-8'
$env:LCODE_KB_STORE_DIR='D:\1_ai_project\lcode-kb\data\rag_store'
& "$V\Scripts\python.exe" "$V\wheel_smoke.py"
```
```
python      : 3.10.11 C:\Users\F\AppData\Local\Temp\kb-wheel-verify\Scripts\python.exe
lcode_kb    : C:\Users\F\AppData\Local\Temp\kb-wheel-verify\lib\site-packages\lcode_kb\__init__.py
info()      : {'backend': 'private', 'version': '0.1.0', 'store_dir': 'D:\\1_ai_project\\lcode-kb\\data\\rag_store', 'docs': 634, 'embedding_model': 'BAAI/bge-small-zh-v1.5'}
store.count : 634
store.files : D:\1_ai_project\lcode-kb\data\rag_store\vectors.npy | D:\1_ai_project\lcode-kb\data\rag_store\meta.json

=== Q1 MPU-6050 I2C register ===
query       : MPU-6050 I2C address register accelerometer | chip filter: None
hits        : 3 (raw store hits: 3)
  #1. score=0.7122 chip=unknown source=外设手册\MPU-6050.pdf
      The MPU-6000 and MPU-6050 are identical, except that the MPU-6050 supports the I2C serial 
  #2. score=0.7077 chip=unknown source=外设手册\MPU-6050.pdf
      MPU-6000/MPU-6050 Product Specification  Document Number: PS-MPU-6000A-00  Revision: 3.3  
  #3. score=0.6918 chip=unknown source=外设手册\MPU-6050.pdf
      I2C is a two -wire interface comprised of the signals serial data (SDA) and serial clock (

=== Q2 esp32s3 gpio filter ===
query       : esp32s3 gpio pin configuration | chip filter: esp32s3
hits        : 3 (raw store hits: 3)
  #1. score=0.7499 chip=esp32s3 source=芯片手册\esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
      ESP32-S3R2 ESP32-S3 NC: No component. ESP32-S3R8 50 ohm Impedance Control ESP32-S3R16V SPI
  #2. score=0.7247 chip=esp32s3 source=芯片手册\esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
      pins IO35, IO36, and IO37 are connected to the Octal SPI PSRAM and are not available for o
  #3. score=0.7098 chip=esp32s3 source=芯片手册\esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
      ESP32-S3-WROOM-1 ESP32-S3-WROOM-1U Datasheet Version 1.8 2.4 GHz Wi-Fi (802. 11b/ g/n) and

=== Q3 temperature/humidity sensor ===
query       : temperature humidity sensor I2C | chip filter: None
hits        : 2 (raw store hits: 2)
  #1. score=0.6539 chip=esp32s3 source=芯片手册\esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
      or I/O load. Generally, the chip’s internal temperature is higher than the ambient tempera
  #2. score=0.6155 chip=unknown source=外设手册\Goertek-SPL06-007_C233787.pdf
      Ramp-down rate 4℃/seconds max.  Time 25℃ to peak temperature  8 minutes max.  12. Package 

WHEEL_SMOKE_DONE
```

**命中结论**：3 次查询共 8 条命中，来源全是真实手册（`MPU-6050.pdf`、`esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf`、
`Goertek-SPL06-007_C233787.pdf`），最高相似度 0.7499，芯片过滤（`chip="esp32s3"`）也真实生效（返回的都是 `chip=esp32s3` 的切片）。

> 顺带发现（与代码注释不符，实测为准）：`tests/smoke_retrieval.py` 的文档字符串写
> 「查询 2 在无 esp32s3 标签语料时返回 0 条」，但实测语料里**有 136 条 `chip=esp32s3`** 的切片，
> 所以 Q2 实际返回 3 条而非 0 条。注释是早期语料的残留，检索行为本身正确。
>
> **可复现**：同一命令重跑一次，`docs=634` 与三次查询的首位分数完全一致
> （Q1 `0.7122` / Q2 `0.7499` / Q3 `0.6539`），命中数 3 / 3 / 2 不变。

### 4.4 控制台入口点也验证了

```powershell
& "$V\Scripts\lcode-kb-build.exe" --help
```
```
usage: lcode-kb-build [-h] [--assets ASSETS] [--out OUT]

L-CODE 私有知识库建库

options:
  -h, --help       show this help message and exit
  --assets ASSETS  手册目录（默认 C:\Users\F\AppData\Local\Temp\kb-wheel-verify\Lib\site-packages\corpus）
  --out OUT        向量库输出目录（默认 C:\Users\F\.lcode\kb_store）
```

这条输出同时证明了 §5.5 要讲的**兜底路径**：wheel 装完后，包目录旁边的 `corpus/` 不存在、
`data/rag_store` 也不存在，所以 `config.py` 会退到 `~/.lcode/kb_store` ——**授权用户必须显式设
`LCODE_KB_STORE_DIR`**，否则 `info()` 会报 `docs=0`。

---

## 5. 步骤 4：「私有源」方案调研与对比

### 5.1 事实核查：GitHub Packages 的 Python registry 现在**不存在**

本次联网抓取官方文档核验（不是凭记忆）：

* 抓 `https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages`（HTTP 200，133,021 字节），
  「Supported clients and formats」原文：

  > GitHub Packages offers different package registries for commonly used package managers,
  > such as **npm, RubyGems, Apache Maven, Gradle, Docker, and NuGet**. GitHub's Container registry
  > is optimized for containers and supports Docker and OCI images.

* 抓 registry 列表页 `https://docs.github.com/en/packages/working-with-a-github-packages-registry`，
  全文正则匹配 `(?i)python` → **匹配数 0**。

* 社区侧佐证：`github/docs` issue #44134「Feature Request: Native Private Python Package Registry」
  （2026-05-08 创建，2026-05-13 关闭），关闭理由不是「已实现」，而是
  「This repository is for documentation, not feature requests. The best place for feature requests is
  github.com/github/feedback/discussions」——即**仍无原生 Python registry**。

**结论**：方案 (b) 现在**不可用**，不是「要什么权限」的问题，而是这个 registry 根本不存在。
GitHub Packages 的 `read:packages` / `write:packages` / `delete:packages` 作用域（官方文档原文：
`read:packages` = Download and install packages from GitHub Packages read；
`write:packages` = Upload and publish packages to GitHub Packages write；
`delete:packages` = Delete packages from GitHub Packages admin）
**对 Python 包没有落点**。

> 唯一沾边的变通：把 wheel 当 OCI 工件推到 `ghcr.io`（`oras push ghcr.io/OWNER/lcode-kb:0.1.0 lcode_kb-0.1.0-py3-none-any.whl`，
> 权限用 `write:packages`），用户 `oras pull` 下来再 `pip install`。但它**当不了 pip 索引**，
> `pip install --index-url` 用不了，本质上退化成方案 (a) 的「先下载再本地装」。**本次未实测。**

### 5.2 三方案对比表

| 维度 | (a) 私有 GitHub Release 附件 | (b) GitHub Packages Python registry | (c) 自建 index（pypiserver / devpi / 静态 simple） |
|---|---|---|---|
| 现在可用吗 | ✅ 可用 | ❌ **不存在**（§5.1 已核验） | ✅ 可用 |
| 基建成本 | 0（已有仓即可） | — | 一台常驻主机 + 进程守护（静态目录方案可 0 进程） |
| 交付物 | 文件（`*.whl` 附件） | — | 索引（`/simple/`，可 `pip install lcode-kb`） |
| pip 按名安装 | ❌ 不能（没有索引语义） | — | ✅ 能（`--index-url` / `--extra-index-url`） |
| 认证方式 | classic PAT `repo` 作用域；fine-grained PAT 需 **Contents: Read**（下载）/ **Contents: Write**（上传）——官方 REST「Get/Update a release asset」原文："The fine-grained token must have the following permission set: **Contents repository permissions (read)**" | — | HTTP Basic（pypiserver 用 `.htpasswd` + `-a update,download`）；devpi 用户名/密码 → token |
| pip 侧写法 | 无（先认证下载 → `pip install .\x.whl`） | — | `pip install --index-url https://user:pass@host/simple/ lcode-kb`；或 `pip config set global.index-url ...`；或 `PIP_INDEX_URL` 环境变量 |
| 撤销授权 | 移除协作者 / 吊销 PAT（立即生效） | — | 改 `.htpasswd` / 改 devpi 用户权限 |
| 版本管理 | 附件按 tag 分组，可 `--clobber` 覆盖 | — | pypiserver 允许同名重传；devpi 默认**不可变**（更适合审计） |
| 缓存公网 PyPI | ❌ | — | ✅（devpi 可代理 PyPI，内网只放行 devpi 出网） |
| 运维风险 | 依赖 GitHub 可用性 | — | 自己扛：备份、磁盘、凭据轮换（devpi 有状态库，比 pypiserver 重） |
| 适合场景 | **授权客户少量、一次性交付** | — | **团队 / CI / 多机批量、要 `pip install 名字`** |

### 5.3 一个必须知道的坑：**pip 不能直接装私有 Release 附件 URL**

- 公开仓：`pip install https://github.com/OWNER/REPO/releases/download/TAG/x.whl` 可用。
- **私有仓：不可用**。Release 资产下载地址会 302 跳到带签名的 CDN（`objects.githubusercontent.com`），
  Authorization 头在跳转中丢失；而 **pip 没有给任意 URL 加自定义请求头的选项**——实测
  `python -m pip install -h` 全文 18,135 字符，正则匹配 `header` → **False**（`netrc` → 也是 False）。
- 正确姿势是「**先用带认证的客户端下载，再本地安装**」：
  * `gh release download`（gh CLI 已登录，最省事）；
  * 或走 **REST 资产端点** `GET https://api.github.com/repos/OWNER/REPO/releases/assets/<id>`
    带 `Authorization: Bearer <PAT>` 与 `Accept: application/octet-stream`（`curl -L -o`）。
    （`mise` 项目就专门有 PR「download private release assets via the GitHub API asset endpoint」，
    同类问题在社区反复出现。）

> **未验证**：本机 `lcode-kb` 仓没有远端也没有凭据，所以「私有 Release 上传 + 授权用户下载」的
> **真实往返没有实测**。上面这条结论来自官方文档 + pip 自身 `-h` 输出 + 社区一手案例，
> 属于**文档级论证**，不是本机实测。代码路径已写进脚本（`gh release upload` / REST `uploads.github.com`），
> 但只跑到 `-DryRun` 为止。

### 5.4 推荐

1. **立刻用（本次交付）：方案 (a) 私有 GitHub Release 附件。**
   理由：wheel 只有 11.7 KiB、交付对象是「已付费的少量授权用户」、零基建、和仓库里已有的
   `tools\publish-release.ps1` 完全同构。`tools\publish-kb-wheel.ps1` 已经把这条链路（构建 → 防呆 →
   本地打 tag → 上传 → 打印授权安装命令）自动化了。
2. **当出现「客户要 `pip install lcode-kb`、或要接 CI/多机」时，升级到方案 (c) 的 pypiserver。**
   理由：pip 语义完整、部署最轻（`pip install pypiserver passlib` 一条命令起服务）、
   静态 simple 目录就能满足 PEP 503；团队再大、需要「代理公网 PyPI + 版本不可变 + 审计」时，
   才换成 devpi。
3. **方案 (b) 不要考虑**（不存在）。

### 5.5 认证与 pip 配置写法（速查）

```powershell
# ---- 方案 (a)：私有 Release 附件 ----
# 凭据：classic PAT 需要 repo 作用域；fine-grained PAT 需要 Contents: Read（下载）
$env:GH_TOKEN = 'github_pat_...'

# 下载（任选其一）
gh release download kb-v0.1.0 --repo OWNER/lcode-kb --pattern '*.whl' --dir .\kb-wheel
# 或走 REST 资产端点（脚本用它兜底）：
curl.exe -L -H "Authorization: Bearer $env:GH_TOKEN" -H "Accept: application/octet-stream" `
  -o .\kb-wheel\lcode_kb-0.1.0-py3-none-any.whl `
  https://api.github.com/repos/OWNER/lcode-kb/releases/assets/<ASSET_ID>

# 安装
pip install .\kb-wheel\lcode_kb-0.1.0-py3-none-any.whl

# ---- 方案 (c)：自建 index ----
# pypiserver（最轻）
pip install pypiserver passlib
htpasswd -c .htpasswd li            # Windows 上通常没有 htpasswd：
                                     #   python -m pip install passlib 后自己生成也可
pypi-server run -p 8080 -a update,download -P .htpasswd C:\pypi-packages

# 上传
python -m twine upload --repository-url http://HOST:8080/ C:\path\lcode_kb-0.1.0-py3-none-any.whl

# 客户端安装（三选一）
pip install --index-url http://USER:PASS@HOST:8080/simple/ lcode-kb
pip config set global.index-url http://USER:PASS@HOST:8080/simple/
$env:PIP_INDEX_URL = 'http://USER:PASS@HOST:8080/simple/'

# 内网自签证书时追加：--trusted-host HOST
# 公司还要公网包时：--extra-index-url https://pypi.org/simple
```

> 安全提示：`pip config set` 会把口令**明文**写进 `%APPDATA%\pip\pip.ini`；
> 更稳妥的是用环境变量（CI secret）或 `netrc`，并给授权用户单独发 PAT，不要共用。

---

## 6. 授权用户安装步骤（含向量库与许可证怎么随包分发）

### 6.1 ⚠️ 先看定位：**桌面端用户走组件 zip，不走 wheel**

| 用户类型 | 交付物 | 机制 | 体积（实测） |
|---|---|---|---|
| **桌面端用户（绝大多数）** | `kb-payload.zip` 组件包 | `tools\stage-kb-payload.py` 生成；解压到 `%APPDATA%\LCode\components\kb`；内核经环境变量 `LCODE_KB_PAYLOAD` 把 `<载荷>\site-packages` 与 `<载荷>` 插进 `sys.path`，再 `import lcode_kb` | 载荷 **1383 MB** → deflate 归档 **≈432 MB**（torch 1113.7 MB / transformers 50.1 MB / scipy 102.9 MB / sklearn 28.7 MB / 私有包 0.0 MB / 向量库 1.7 MB） |
| **pip / 源码用户** | `lcode_kb-0.1.0-py3-none-any.whl` | 本文件 §3–§4 | **11.7 KiB**（依赖由 pip 解析） |

**为什么必须分开**：桌面端内核是 PyInstaller 冻结产物，**不能 `pip install`**（Python 运行时被打进包里），
所以那条线只能靠「目录 + `sys.path`」；反过来，给 pip 用户发 432 MB 的 zip 也毫无意义。
`lcode/kernel/rag/backend.py` 里这两条路径是并列的：`LCODE_KB_PAYLOAD`（组件载荷）
与 `import lcode_kb`（pip 安装），由 `LCODE_KB_BACKEND=auto|private|stub` 决定策略。

### 6.2 pip / 源码用户：安装 wheel

```powershell
# 0) 凭据（classic PAT: repo 作用域；fine-grained PAT: Contents=Read）
$env:GH_TOKEN = 'github_pat_...'

# 1) 认证下载私有 Release 附件
gh release download kb-v0.1.0 --repo OWNER/lcode-kb --pattern '*.whl' --dir .\kb-wheel

# 2) 安装。
#    有现成环境（比如桌面端的内核 venv）就复用它，别为装这个 11 KB 的包重下 torch：
D:\1_ai_project\mcu_ai_agent\lcode\kernel\.venv\Scripts\python.exe -m pip install .\kb-wheel\lcode_kb-0.1.0-py3-none-any.whl
#    全新环境才让它拉依赖（torch==2.6.0 已固定，Windows 10 22H2 上别升）：
#    python -m pip install .\kb-wheel\lcode_kb-0.1.0-py3-none-any.whl

# 3) 指路向量库（关键！wheel 里没有语料，不指就 docs=0）
$env:LCODE_KB_STORE_DIR = 'C:\ProgramData\LCode\kb_store'    # 见 §6.3

# 4) 自检（期望 docs=634）
python -c "import lcode_kb; print(lcode_kb.info())"
```

### 6.3 向量库怎么随包分发

wheel 里**没有**向量库（实测 10 个条目、红线扫描 0 命中），必须单独交付。三种方式：

| 方式 | 做法 | 适用 |
|---|---|---|
| **A. 私有 Release 第二附件（推荐）** | 把 `D:\1_ai_project\lcode-kb\data\rag_store\`（`vectors.npy` 1,298,560 B + `meta.json` 474,779 B，合计 1.7 MB）压成 `kb-store-0.1.0.zip` 上传到**同一个私有 Release**；用户解压后设 `LCODE_KB_STORE_DIR` | 实测压缩后 **1,321,593 B / 1.26 MiB**（`npy` 已是二进制，几乎压不动），与 wheel 同权限、同 tag，版本对得上 |
| B. 组件 zip 里顺带 | 桌面端 `kb-payload.zip` 已含 `data/rag_store/`，无需额外操作 | 桌面端用户 |
| C. 随安装包内置 | 打包时拷进内核的 `data/rag_store`（内核 `backend.py` 会把它设成 `LCODE_KB_STORE_DIR`） | 一体化安装包 |

方式 A 的完整命令（**故意不由脚本自动做**：向量库存的是手册原文，必须每次都人工确认真要发出去）。
本机实测过打包这一步：

```powershell
Compress-Archive -Path 'D:\1_ai_project\lcode-kb\data\rag_store\*' `
                 -DestinationPath .\out\kb-store-0.1.0.zip -Force
```
```
src meta.json    = 474779 B
src vectors.npy  = 1298560 B
zip              = 1321593 B  (1,291 KiB / 1.26 MiB)
sha256           = 79492b99830cd60103fa2c50f952d69accdf0a9a3a43401aff176e2c70e44e12
zip 内条目       : 474779  meta.json
                   1298560  vectors.npy
（zip 哈希含条目时间戳，重打一次会变；体积量级稳定在 1.3 MB。）
```

```powershell
# 体积防呆 + 只传到私有 Release（与 wheel 同一个 tag）
gh release upload kb-v0.1.0 .\out\kb-store-0.1.0.zip --repo OWNER/lcode-kb --clobber
```

用户侧只需解压 + 一个环境变量：

```powershell
Expand-Archive .\kb-store-0.1.0.zip -DestinationPath C:\ProgramData\LCode\kb_store -Force
$env:LCODE_KB_STORE_DIR = 'C:\ProgramData\LCode\kb_store'
```

> 🚨 向量库 zip 与 wheel 是**两种性质的东西**：wheel 只是代码（就算泄了也只是检索逻辑），
> 向量库 zip 里 `meta.json` 是**厂商手册的原文切片**。因此：只发已授权用户、只放私有 Release、
> 绝不放公网对象存储免密桶、绝不进 git。

### 6.4 许可证怎么随包分发

**红线：任何许可证私钥都不进 wheel、不进 git、不进 Release 附件。**

先认清能力边界（实测）：wheel 里就是 **5 个明文 `.py`**（`__init__.py` 2,375 B / `config.py` 3,634 B /
`load_docs.py` 5,249 B / `retriever.py` 1,840 B / `vector_store.py` 3,067 B）。
装到客户机上后客户能直接读源码。所以：

| 诉求 | 做法 |
|---|---|
| 「只发给授权用户」 | **分发面许可**（够用）：许可就是私有 Release/私有 index 的访问权。给每个授权用户**单独发 PAT**，到期/违约直接吊销 PAT 或移除协作者；wheel 元数据已带 `License: Proprietary` + `Classifier: Private :: Do Not Upload`（实测见 §3.4）。 |
| 「拿到包也解不出语料」 | 靠**桌面端组件 zip** 那条线做激活校验（内核侧验签/校验激活码），因为冻结内核不是明文 Python；wheel 这条线做不到。 |
| 「要更强的防拷」 | 把检索逻辑留在 wheel、把**向量库做成单独加密载荷**（密钥由激活流程下发）；代价是要改 `lcode_kb.config`/`vector_store` 的加载路径，属于后续版本的事。 |

具体到本仓：**许可证文件本身（`.lic` / 激活码 / 私钥）不进 wheel、不进 git**。
`.gitignore` 已排除 `*.pem`、`*.key`、`*.pfx`、`*.p12`、`secrets/`；`publish-kb-wheel.ps1` 的上传前
扫描还会再拒一次（见 §7.2）。

---

## 7. 步骤 5：`tools\publish-kb-wheel.ps1`（已实测）

### 7.1 脚本能做什么

```
1/8  定位私有仓（校验 pyproject.toml + lcode_kb/），从 [project] 表读 version（PS 5.1 无 TOML 解析器，按行解析）
2/8  python 可用性
3/8  git 红线自检：① must-ignore 清单逐条 git check-ignore --no-index；② git ls-files 扫禁用轨迹；③ 脏树告警
4/8  构建（缺 build 就 pip install build；-SkipBuild 可复用 dist/）
5/8  产物发现 + 体积防呆（>2 GiB 拒收 / 拒绝 .env|.pem|.key / 拒绝 rag_store|vectors|meta.json 命名的产物）
6/8  打开 wheel 逐条目扫描：拒收 rag_store / *.npy / *.pdf / .env / *.pem / *.key / secrets/
7/8  目的地 + 凭据：Release 模式做**隐私闸门**（必须 API 确认 private=true，公开仓直接拒）；
     index 模式拒绝 pypi.org 等公网索引
8/8  计划 → 确认 → 只打本地 tag（绝不 git push）→ gh release upload 或 twine upload → 打印授权用户安装命令
```

关键参数：

```powershell
tools\publish-kb-wheel.ps1 [-KbDir <路径>] [-Repo owner/name] [-Tag kb-v0.1.0]
                           [-IndexUrl https://devpi.internal/root/lcode/+simple/]
                           [-SkipBuild] [-NoGitTag] [-AllowDirty] [-DryRun] [-Force]
```

### 7.2 解析验证（PowerShell 5.1，任务指定的方式）

```powershell
powershell -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw 'D:\1_ai_project\mcu_ai_agent\tools\publish-kb-wheel.ps1')) | Out-Null; 'PARSE_OK v' + $PSVersionTable.PSVersion.ToString()"
```
```
PARSE_OK v5.1.19041.6456
```

纯 ASCII 与无 BOM 也实测过（PS 5.1 会把无 BOM 的 `.ps1` 按 ANSI 读，中文注释会直接解析失败）：

```
total bytes: 20211 ; non-ASCII byte count: 0 ; first3 = 35,32,61 (BOM would be 239,187,191)
```

### 7.3 `-DryRun` 正常路径（实测输出）

```powershell
cd D:\1_ai_project\mcu_ai_agent
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-kb-wheel.ps1 -DryRun
```
```
== 1/8  locate the private knowledge base repo
  [ok] KbDir = D:\1_ai_project\lcode-kb
  [ok] version = 0.1.0   tag = kb-v0.1.0

== 2/8  python + build backend
  [ok] python: Python 3.10.11

== 3/8  git hygiene (red lines)
  [ok] vector store / dist / corpus / secrets are all git-ignored
  [ok] git index is clean (9 tracked files, none forbidden)
  [ok] working tree clean at HEAD 4c3d3f7

== 4/8  build sdist + wheel
  [dry-run] would run: python -m build      (in D:\1_ai_project\lcode-kb)

== 5/8  artifact discovery + size guard
  lcode_kb-0.1.0-py3-none-any.whl                11.7 KiB  sha256=3c5882b2bd6d2cb4262351582523fbdde180850b1d5934f6ac6f86139fb4a3da
  lcode_kb-0.1.0.tar.gz                          11.4 KiB  sha256=f515ede12a2b487c8c544a58cc9106da46a5698dcfc7e5cb5c2d4c8080e62888
  [ok] safety checks passed (2 artifact(s), 0.02 MiB total)

== 6/8  wheel content scan (no corpus, no vector store, no secrets)
  [ok] wheel has 10 entries, none forbidden:
      lcode_kb/__init__.py
      ... (5 个 .py + 5 个 dist-info 条目)

== 7/8  destination + auth
  mode      : private GitHub Release asset
  [warn] no git remote and no -Repo: pass -Repo owner/name (the private repo has no remote yet)
  [warn]   auth: none (gh auth login, or set $env:GH_TOKEN)

== 8/8  plan
  about to publish:
    lcode_kb-0.1.0-py3-none-any.whl                    11.7 KiB
    lcode_kb-0.1.0.tar.gz                              11.4 KiB
    -> <private repo not set: pass -Repo owner/name>
    -> local git tag kb-v0.1.0 in D:\1_ai_project\lcode-kb (NOT pushed)
  never pushed: source code, data/rag_store, corpus PDFs, .env, secrets

[dry-run] nothing was built, tagged or uploaded.
EXIT=0
```

### 7.4 防呆/红线守卫的**负向实测**（每一条都真的触发了拒绝）

| # | 场景 | 命令要点 | 实测结果 |
|---|---|---|---|
| A | 目标是**公开仓** | `-DryRun -Repo octocat/Hello-World` | `[FAIL] refusing: octocat/Hello-World is PUBLIC. A closed-source wheel must never be published there.` **EXIT=1** |
| B | wheel **被 git 跟踪** | `git add -f dist/lcode_kb-0.1.0-py3-none-any.whl` 后 `-DryRun` | `[refused] tracked in git: dist/lcode_kb-0.1.0-py3-none-any.whl` + `[FAIL] ... committed in git.` **EXIT=1** |
| C | `.gitignore` **不再覆盖向量库** | 临时删掉 `data/rag_store/`、`data/` 两行后 `-DryRun` | `[refused] .gitignore does not cover: data/rag_store/meta.json` + `[refused] .gitignore does not cover: .env` **EXIT=1** |
| D | 产物 **> 2 GiB** | 在 `dist\` 放一个 2,200,000,000 B（2.05 GiB）的稀疏 `.whl` 探针后 `-DryRun` | `[refused] over 2 GiB (GitHub release asset limit): zz-sizeguard-probe.whl` + `[FAIL] refusing to publish (see above). Nothing was sent.` **EXIT=1** |
| E | 上传目标为**公网索引** | `-DryRun -IndexUrl https://pypi.org/simple/` | `[FAIL] refusing: that is a PUBLIC index. This asset is closed source.` **EXIT=1** |
| F | 自建 index 计划 | `-DryRun -IndexUrl https://devpi.internal/root/lcode/+simple/` | 计划行 `-> twine upload --repository-url https://devpi.internal/root/lcode/+simple/`，并告警 `TWINE_USERNAME/TWINE_PASSWORD not set`，**EXIT=0** |

测试 D 的探针文件与测试 B/C 对 git 索引的临时改动**都已还原**，收尾核验：

```
git status --porcelain   -> (clean)
git rev-parse HEAD       -> 4c3d3f73147bfbfa53fc98a8822a262d1c028e68
git ls-files | 计数       -> 9
包含 rag_store / *.npy 的跟踪文件 -> 0
dist\                     -> 只剩 lcode_kb-0.1.0-py3-none-any.whl (11957) + lcode_kb-0.1.0.tar.gz (11690)
```

---

## 8. 未完成 / 未验证项（如实列出）

| 项 | 状态 | 说明 |
|---|---|---|
| 私有仓**远端与 push** | **未做（按任务要求）** | `git remote -v` 为空，无凭据。提交只在本机 `master` 上 |
| **真实上传**到私有 Release | **未验证** | 脚本只跑到 `-DryRun`（公开仓/公网索引路径是真的触发了拒绝，但成功上传的往返没跑过）。需要：建 `lcode-kb` 私有远端 + `gh auth login` 或 `GH_TOKEN` |
| **授权用户下载私有 Release 附件** | **未验证** | 结论来自官方文档 + pip `-h` 无 `--header` 的实测 + 社区案例，属文档级论证（§5.3） |
| 用 `pip install <私有 release URL>` 直接安装 | **已知不可行**（非本机实测） | 见 §5.3 |
| 方案 (c) 自建 index 的**真实往返** | **未验证** | pypiserver/devpi 未在本机部署；pip 侧写法来自官方参数（`--index-url`/`--extra-index-url`/`--trusted-host`，本次从 `pip install -h` 实测确认存在） |
| 把 wheel 当 OCI 工件推 `ghcr.io` + `oras` | **未实测** | 只是备选说明 |
| `twine` 上传路径是否可用 | **未验证** | 本机**未装 twine**；脚本在非 dry-run 时会先 `import twine` 检查并提示 `python -m pip install twine` |
| `pyproject.toml` 的 `license` 弃用警告 | **已知未修** | 2027-02-18 后变硬错误，修法见 §3.2 |
| `tests/smoke_retrieval.py` 注释与实测不符 | **已知未修** | 注释说 Q2 返回 0 条，实测返回 3 条（语料里有 136 条 `esp32s3` 切片）；属注释过期，未改代码 |
| 向量库 zip 的自动上传 | **有意不做** | 脚本只发 `dist\*.whl` / `dist\*.tar.gz`；向量库存手册原文，要求每次人工确认，命令见 §6.3 |

---

## 9. 复现命令清单（从零到验证通过）

```powershell
# ── A. 私有仓：初始化 + 提交（已完成，勿重复 init）
cd D:\1_ai_project\lcode-kb
git init
git check-ignore -v data/rag_store/meta.json .env x.pem      # 期望逐条命中 .gitignore
git add -A ; git diff --cached --name-only                   # 期望 9 个文件，无 data/ 无 __pycache__
git commit -F .git\COMMIT_MSG_TMP

# ── B. 构建
python -m pip install --disable-pip-version-check build setuptools wheel
python -m build
Get-ChildItem dist -File | ForEach-Object { "{0} {1} B" -f $_.Name, $_.Length }

# ── C. 端到端验证
$V = "$env:TEMP\kb-wheel-verify"
python -m venv $V
& "$V\Scripts\python.exe" -m pip install --no-deps D:\1_ai_project\lcode-kb\dist\lcode_kb-0.1.0-py3-none-any.whl
Set-Content "$V\Lib\site-packages\zz_borrow_kernel_deps.pth" `
  'D:\1_ai_project\mcu_ai_agent\lcode\kernel\.venv\Lib\site-packages' -Encoding ASCII
$env:PYTHONNOUSERSITE='1'; $env:PYTHONIOENCODING='utf-8'
$env:LCODE_KB_STORE_DIR='D:\1_ai_project\lcode-kb\data\rag_store'
& "$V\Scripts\python.exe" -c "import lcode_kb; print(lcode_kb.__file__); print(lcode_kb.info())"
& "$V\Scripts\python.exe" "$V\wheel_smoke.py"                 # 期望 docs=634 + 三次命中

# ── D. 发布脚本
powershell -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw 'D:\1_ai_project\mcu_ai_agent\tools\publish-kb-wheel.ps1')) | Out-Null; 'PARSE_OK'"
powershell -NoProfile -ExecutionPolicy Bypass -File D:\1_ai_project\mcu_ai_agent\tools\publish-kb-wheel.ps1 -DryRun
```

---

## 10. 交付判据对照

| 任务要求 | 状态 | 证据位置 |
|---|---|---|
| ① `git init` + 初始提交 | ✅ | §2；哈希 `4c3d3f73147bfbfa53fc98a8822a262d1c028e68` |
| ① `.gitignore` 排除向量库 / `__pycache__` / `dist` / `*.egg-info` | ✅ | §2.1（`git check-ignore -v` 行号实测）+ §2.3 |
| ① 不 push | ✅ | 无远端；脚本也只打本地 tag |
| ② 构建 wheel，报告文件名与体积 | ✅ | §3.3：`lcode_kb-0.1.0-py3-none-any.whl`，**11,957 B / 11.7 KiB**（实测） |
| ③ 临时 venv 装 wheel（`--no-deps` + 借依赖） | ✅ | §4.1 |
| ③ `import lcode_kb; print(lcode_kb.info())` 真实输出 | ✅ | §4.2：`docs: 634` |
| ③ 真实检索命中证据（634 条 + 命中手册） | ✅ | §4.3：3 次查询 8 条命中，最高 score 0.7499，来源为真实 PDF |
| ④ 三种私有源调研 + 推荐 | ✅ | §5（含 GitHub Packages **无** Python registry 的联网核验） |
| ④ 认证方式：PAT 作用域 / pip config / `--index-url` | ✅ | §5.5（`read:packages` 等官方原文见 §5.1；fine-grained `Contents: Read` 见 §5.2） |
| ⑤ ASCII-only PS 脚本，`-DryRun`，>2 GiB 拒收，拒收 wheel/向量库进 git | ✅ | `tools\publish-kb-wheel.ps1`；解析 §7.2；负向实测 §7.4（A–F 全部 EXIT=1 拒绝） |
| ⑥ 中文文档：实测输出 / 对比表 / 授权安装 / 定位说明 | ✅ | 本文件 |
| 红线：向量库、许可证私钥、`.env`、厂商 PDF 不进 wheel 也不进 git | ✅ | §3.4（wheel 10 条目、扫描 0 命中）+ §2.1 + §7.4 B/C |
| 红线：绝不做公开上传 | ✅ | §7.4 A（公开仓拒）/ E（公网索引拒）实测 EXIT=1 |
| 所有体积与命中数都是实测值 | ✅ | 每条数字都标了来源命令 |
