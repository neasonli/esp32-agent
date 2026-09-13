# 内核打包（Windows 便捷入口，实际逻辑在跨平台的 build_kernel.py）
#
# 为什么不是 Nuitka 了：Nuitka 需要 MSVC Build Tools，且原脚本把解释器写成了
# `..\..\embedded_agent_stage1\.venv\...`（该目录已迁出仓库，脚本早已失效）。
# 现统一走 PyInstaller（pip 装即可，无需编译器），三平台共用 build_kernel.py。
#
# 用法（在 lcode\kernel 目录下）：
#   powershell -ExecutionPolicy Bypass -File scripts\build_kernel.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build_kernel.ps1 -NoKb        # 只打通用模式内核
#   powershell -ExecutionPolicy Bypass -File scripts\build_kernel.ps1 -Python "D:\py\python.exe"
#
# 产物：lcode\desktop\resources\kernel\lcode-kernel.exe（+ 同级 _internal\）
# 注意：PyInstaller 不能交叉编译，macOS/Linux 的内核要在对应系统上跑 build_kernel.py。

param(
    [string]$Python = "",
    [switch]$NoKb,
    [switch]$OneFile,
    [switch]$NoCopy
)

$ErrorActionPreference = "Stop"
$KernelDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ($Python -eq "") {
    # 默认用内核自带虚拟环境（桌面端生产模式用的就是它）
    $candidate = Join-Path $KernelDir ".venv\Scripts\python.exe"
    if (Test-Path $candidate) { $Python = $candidate }
    else { $Python = "python" }
}

Write-Host "内核目录: $KernelDir"
Write-Host "解释器  : $Python"

$pyArgs = @((Join-Path $KernelDir "scripts\build_kernel.py"))
if ($NoKb) { $pyArgs += "--no-kb" }
if ($OneFile) { $pyArgs += "--onefile" }
if ($NoCopy) { $pyArgs += "--no-copy" }

& $Python @pyArgs
exit $LASTEXITCODE
