/**
 * 知识库后端状态（方案 A 接缝的渲染侧投影）。
 *
 * 内核 `/api/health` 返回 `kb_backend`：
 * - `private`：私有知识库包已安装 → 手册检索可用；
 * - `stub`   ：公开版通用模式 → 检索返回空，界面应提示/置灰该能力。
 *
 * 内核启动需要时间，因此失败时做有限重试；内核重启（status 变化）后自动重拉。
 */
import { useEffect, useState } from 'react'
import { useAppStore } from './stores/useAppStore'
import type { KbStatusInfo } from '../../shared/types'

export function useKbStatus(): KbStatusInfo | null {
  const kernelStatus = useAppStore((s) => s.kernelStatus)
  const [kb, setKb] = useState<KbStatusInfo | null>(null)

  useEffect(() => {
    let alive = true
    let tries = 0
    const load = async (): Promise<void> => {
      const r = await window.lcode.getKbStatus()
      if (!alive) return
      if (!r) {
        // 内核未就绪（safeIpc 失败返回 null）：最多重试 8 次 × 1.5s
        if (tries++ < 8) setTimeout(() => void load(), 1500)
        return
      }
      setKb(r)
    }
    void load()
    return () => {
      alive = false
    }
  }, [kernelStatus?.status])

  return kb
}

/** 是否具备领域知识库检索能力（未就绪时按「无」处理，界面走置灰态） */
export function useKbAvailable(): boolean {
  return useKbStatus()?.kb_available === true
}
