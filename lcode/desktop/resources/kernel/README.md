# resources/kernel —— 打包进安装包的内核可执行文件

electron-builder 会把本目录整体复制到安装包的 `resources/kernel/`，
`KernelManager` 在**打包模式**下就从这个位置启动内核：

```
resources/kernel/lcode-kernel.exe      (Windows)
resources/kernel/lcode-kernel          (macOS / Linux，无 .exe 后缀)
resources/kernel/_internal/**          (PyInstaller 6 的依赖目录，必须与可执行文件同级)
```

## 怎么产出

```powershell
cd lcode\kernel
.\.venv\Scripts\python.exe -m pip install pyinstaller     # 首次
.\.venv\Scripts\python.exe scripts\build_kernel.py        # 带私有知识库（正式版）
.\.venv\Scripts\python.exe scripts\build_kernel.py --no-kb # 不带（公开仓/CI 版，体积小）
```

脚本会把 `kernel/dist/lcode-kernel/` 的内容拷到本目录（本 README 会被保留）。

⚠️ **PyInstaller 不能交叉编译**：macOS/Linux 的内核必须在对应系统（或 CI 对应 runner）上跑同一脚本。
本目录内容**不进 git**（`.gitignore` 里忽略 `lcode/desktop/resources/kernel/` 的产物，只留 README）。

细节与体积预算见 `docs/打包发布指南.md`。
