/**
 * 主进程日志（W1）
 *
 * 所有日志写入 %APPDATA%\LCode\logs\main.log（生产与开发一致，方便排查）。
 * 注：显示名从 "L-CODE" 改为 "LCode" 后 userData 目录也跟着变；旧目录里的设置由
 * main/index.ts 的 migrateLegacyUserData() 一次性搬过来。
 * 未捕获异常/拒绝也落盘——弹窗可能看不到完整信息，日志一定能看到。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let logDir: string | null = null

function getLogDir(): string {
  if (logDir) return logDir
  try {
    logDir = path.join(app.getPath('userData'), 'logs')
  } catch {
    logDir = path.join(process.cwd(), 'logs')
  }
  fs.mkdirSync(logDir, { recursive: true })
  return logDir
}

export function logToFile(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  try {
    fs.appendFileSync(path.join(getLogDir(), 'main.log'), line + '\n')
  } catch {
    /* 日志写失败不阻断主流程 */
  }
  console.log(line)
}
