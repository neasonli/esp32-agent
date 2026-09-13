# planner bundle (构建产物，勿手工改)

本目录由 `tools/planner-bundle/build-bundle.mjs` 生成、`tools/build-planner-bundle.ps1` 调用：

    powershell -ExecutionPolicy Bypass -File tools\build-planner-bundle.ps1

内容：DSH 已构建产物（`apps/cli`）+ 裁剪后的运行期依赖闭包（`node_modules`）
+ 预编译的 `@lcode/planner` + `home/`（DSH_HOME 骨架）+ `manifest.json`。

运行时桌面端会把它整份拷到 `%APPDATA%\LCode\planner-runtime`，再用
**Electron 自带 Node**（`ELECTRON_RUN_AS_NODE=1`）拉起 `apps/cli/lib/bin.js --profile lcode-planner`。
因此要求 Electron `>=36.9.0`（自带 Node `>=22.19`，DSH 的 engines 约束）。

公开仓**不含**本目录内容（`.gitignore` 与 `tools/make-public-export.ps1` 都排除），
用户按上面的命令自行生成即可；构建需要一份 DSH 源码 checkout（`LCORE_DSH_REPO`）。
