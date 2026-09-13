# LCode 0.1.0（Windows x64）发布说明

> 本节是版本描述正文，直接整段粘到 GitHub Release 的描述框里即可。
> 所有体积/耗时/SHA256 均为本机实测（2026-09-13）。

---

## LCode 是什么

面向 ESP32 嵌入式固件开发的桌面 Agent：**Electron 界面 + Python 内核 + DSH 规划器**。
在对话里说需求（或直接说"给 esp32s3 写个 blink 并编译"），它自己选型 → 查手册 → 生成工程 → 编译 → 按报错迭代修复。

## 下哪个（4 个文件任选）

| 文件 | 体积 | 适用场景 |
|---|---|---|
| **`LCode-0.1.0-win-x64-setup-full.exe`** | **818.4 MB** | **推荐**。全新机器、什么都没装：内置裁剪后的 ESP-IDF 5.5.5（含自带 Python 与 xtensa 工具链），**装完即可编译固件** |
| `LCode-0.1.0-win-x64-portable-full.exe` | 818.2 MB | 同上，但是**免安装版**（双击即用，不写注册表） |
| `LCode-0.1.0-win-x64-setup.exe` | 141.0 MB | 机器上**已有 ESP-IDF**：装完在设置页填三个路径即可 |
| `LCode-0.1.0-win-x64-portable.exe` | 126.0 MB | 同上，免安装版 |

**系统要求：Windows 10/11 x64。** 不需要预装 Node.js、Python 或 ESP-IDF（`-full` 版连 IDF 都不用装）。

安装行为：**用户级安装，不需要管理员权限**，可自选安装目录，自动创建桌面快捷方式；卸载**不会**删除
`%APPDATA%\LCode`（会话与设置保留）。实测安装后占用：base **452 MB / 4585 文件**，full **1194 MB / 4586 文件**。

## 装完第一步：填 API Key

LCode 用你**自己的**大模型 API（默认 DeepSeek，任何 OpenAI 兼容端点都行）：

1. 打开 **设置 → LLM 配置**
2. 填 `API Key`、`Base URL`（默认 `https://api.deepseek.com/v1`）、模型名
3. 点 **保存** → 再点 **测试连接**。看到「连接正常 · 实际服务模型：deepseek-flash」即成功

该卡片底部有一行 **「对话实际生效（规划器进程）」**，显示**真正跑对话的进程**在用的模型与 Key 末 4 位。
若与上面填的不一致，以这一行为准（对话由规划器子进程发出，它的环境在启动时定格）。

## 首次启动会自动做什么（实测）

- **规划器运行时**（28 MB）解压到 `%APPDATA%\LCode\planner-runtime`：首次约 **7 秒**，之后直接复用。
  所以用户机器上**不需要装 Node.js**，规划器用 Electron 自带的 Node 22 跑。
- **`-full` 版**：后台把 ESP-IDF 归档（741.8 MB）解压到 `%APPDATA%\LCode\components\esp-idf`，
  实测 **99 秒**，解开 **57,580 个文件**，完成后设置页「扩展组件」显示已安装与版本（v5.5.5）。
  **解压期间界面可以正常使用**，不需要等。
- 数据（会话库、日志）都在 `%APPDATA%\LCode`，不在安装目录 —— 升级不丢会话。

## 能做什么

- **对话式开发**：自然语言改代码、加功能、修编译错误（Agent 会真的读写文件、跑 `idf.py`）
- **编译 / 烧录**：内置 ESP-IDF 工具链支持，默认目标 `esp32s3`；编译产物在界面右侧栏可查看
- **计划模式**：先出方案再动手（输入框 `/plan` 开启）
- **手册检索**：接入私有知识库时可按芯片型号检索数据手册；**本开源版不含语料**，未启用时会明确提示「未启用」而不是编造寄存器值
- **会话历史**：本地 SQLite，重开继续；支持从任意消息分支

## 已知限制（0.1.0）

- **仅 Windows x64**：macOS / Linux 需要各自平台构建（内核冻结件与工具链是平台相关的），**本次未提供**。
- **不内置大模型**：必须自己填 API Key，否则对话会失败（编译功能不受影响）。
- **本开源版不含知识库语料**：`lcode-kb` 是闭源可选组件，未安装时手册检索为通用模式（返回空并提示）。
- **未做代码签名**：Windows SmartScreen 可能提示「未知发布者」→ 点「更多信息 → 仍要运行」。
- **规划器降级路径**：若内置运行时缺失或损坏，对话会自动切到内核内置 Agent（界面顶部出现「精简模式」提示条），
  此时计划模式、推理等级、子代理、待发送队列不可用，但对话 / 改码 / 编译仍然正常。

## 校验下载完整性（可选）

```powershell
Get-FileHash .\LCode-0.1.0-win-x64-setup-full.exe    -Algorithm SHA256
Get-FileHash .\LCode-0.1.0-win-x64-portable-full.exe -Algorithm SHA256
Get-FileHash .\LCode-0.1.0-win-x64-setup.exe         -Algorithm SHA256
Get-FileHash .\LCode-0.1.0-win-x64-portable.exe      -Algorithm SHA256
```

| 文件 | SHA256 |
|---|---|
| `LCode-0.1.0-win-x64-setup-full.exe` | `1D2A10B19AE6386E0526BB321D6D6F6E0D5E05EADF75ACB974A6D1A50E2ED013` |
| `LCode-0.1.0-win-x64-portable-full.exe` | `CFE6509EF7FDD6C18B23EEEEEDB1807E893C6CD47A2FF17B1B21E29D83591623` |
| `LCode-0.1.0-win-x64-setup.exe` | `58023E53E694EF279872A629B583C0F6866E3412F633ED940358A7441B558712` |
| `LCode-0.1.0-win-x64-portable.exe` | `4473D4338D0AEF979824F9013C0F98E8A8AF2113F04F568A82E7D8DFBAA976A7` |

## 文档

仓库 `docs/` 目录下：

- `日常更新与推送.md` —— 改完代码怎么同步到 GitHub（一条命令）
- `一键打包.md` —— 自己出安装包（base / full）、组件载荷、发布流程
- `打包发布指南.md` —— 三平台打包原理、规划器随包机制、体积预算
- `配置优先级与Key排查.md` —— 设置页 Key 不生效怎么查

## 许可与第三方

- LCode 本体：**MIT**（见 `LICENSE`）
- 内置规划器运行时基于 DeepSeek Harness（MIT）；其依赖的第三方许可证原文随包放在安装目录
  `resources\planner\licenses\`（含 DSH 的 LICENSE 与 THIRD_PARTY_NOTICES，以及 27 个依赖各自的许可证）
- `-full` 版内含 ESP-IDF 5.5.5 与工具链：IDF 本体 Apache-2.0，各工具许可证见其目录内 LICENSE

> 安装包**不含**任何厂商手册 PDF（版权原因），手册需用户自行放入。
