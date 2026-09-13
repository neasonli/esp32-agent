# resources/kernel

Nuitka 编译后的内核可执行文件放在本目录（W4 打包阶段产出）：

```
resources/kernel/lcode-kernel.exe     (Windows)
resources/kernel/lcode-kernel         (macOS / Linux)
```

KernelManager 优先使用 `resources/kernel/lcode-kernel.exe`；
不存在时回退到开发模式（直接以 Python 运行 `../../kernel/run_kernel.py`），
方便 W1~W2 开发调试。构建脚本见 `kernel/scripts/build_kernel.ps1`。
