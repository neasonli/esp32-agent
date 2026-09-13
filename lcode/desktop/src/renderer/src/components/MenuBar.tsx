/**
 * 自定义菜单栏（隐藏标题栏后原生菜单不可见，用 UI 菜单替代）
 *
 * 文件 / 编辑 / 视图 / 帮助 中文菜单，点击弹出下拉；编辑类动作用 execCommand
 * 作用于当前焦点输入（复制/粘贴等快捷键仍由原生菜单加速器保证）。
 *
 * 帮助（2026-09 新增）：
 * - 「支持开发者」→ 弹窗展示本地「收款码」目录里的收款码图片（主进程读文件转 data URL，
 *   渲染层只负责展示，不直接读盘）；
 * - 「打开官网」→ 系统浏览器打开官网（URL 固定在主进程 OFFICIAL_SITE_URL）。
 */
import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useAppStore } from '../stores/useAppStore'
import { LCODE_MARK_PNG } from '../assets/lcodeMark'

interface MenuItem {
  label?: string
  action?: () => void
  separator?: boolean
}

/** 打开文件夹并作为工作目录：选择 → 通知内核 → 进入三栏工作区视图 */
async function openFolderAsWorkspace(): Promise<void> {
  const dir = await window.lcode.pickDirectory()
  if (!dir) return
  await window.lcode.setWorkspaceDir(dir)
  useAppStore.getState().openWorkspace(dir)
}

export function MenuBar(): JSX.Element {
  const tr = useT()
  const [open, setOpen] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 收款码弹窗（帮助 → 支持开发者）：null = 关闭；images 为空 = 未找到图片
  const [payQr, setPayQr] = useState<{ dir: string; images: { name: string; dataUrl: string }[] } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)

  const isDev = window.location.protocol === 'http:'

  /** 帮助 →「支持开发者」：拉取收款码图片并弹窗 */
  async function showPaymentQr(): Promise<void> {
    setQrLoading(true)
    try {
      const r = await window.lcode.getPaymentQr()
      setPayQr(r ?? { dir: '', images: [] })
    } catch {
      setPayQr({ dir: '', images: [] })
    } finally {
      setQrLoading(false)
    }
  }

  const menus: { key: string; label: string; items: MenuItem[] }[] = [
    {
      key: 'file',
      label: tr('menuFile'),
      items: [
        { label: tr('menuOpenFolderAsWorkspace'), action: () => void openFolderAsWorkspace() },
        { label: tr('menuOpenWorkspace'), action: () => void window.lcode.openWorkspaceFolder() },
        { separator: true },
        { label: tr('menuQuit'), action: () => void window.lcode.appQuit() }
      ]
    },
    {
      key: 'edit',
      label: tr('menuEdit'),
      items: [
        { label: tr('menuUndo'), action: () => document.execCommand('undo') },
        { label: tr('menuRedo'), action: () => document.execCommand('redo') },
        { separator: true },
        { label: tr('menuCut'), action: () => document.execCommand('cut') },
        { label: tr('menuCopy'), action: () => document.execCommand('copy') },
        { label: tr('menuPaste'), action: () => document.execCommand('paste') },
        { label: tr('menuSelectAll'), action: () => document.execCommand('selectAll') }
      ]
    },
    {
      key: 'view',
      label: tr('menuView'),
      items: [
        { label: tr('menuReload'), action: () => void window.lcode.appReload() },
        ...(isDev ? [{ label: tr('menuDevTools'), action: () => void window.lcode.toggleDevTools() }] : [])
      ]
    },
    {
      key: 'help',
      label: tr('menuHelp'),
      items: [
        { label: tr('menuSupportDev'), action: () => void showPaymentQr() },
        { label: tr('menuOfficialSite'), action: () => void window.lcode.openOfficialSite() }
      ]
    }
  ]

  // 点击外部关闭下拉
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function run(item: MenuItem): void {
    setOpen(null)
    item.action?.()
  }

  return (
    <div ref={barRef} className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      {/*
        品牌标记（像素风）。与 tools/make-app-icon.py 同源（该脚本生成这个 data URL 模块）。
        渲染尺寸必须是 16 的整数倍 + image-rendering: pixelated，否则像素风会被插值糊掉。
      */}
      <div className="mr-1 flex select-none items-center gap-1.5 pl-1.5 pr-1">
        <img
          src={LCODE_MARK_PNG}
          width={16}
          height={16}
          alt="LCode"
          draggable={false}
          className="shrink-0 select-none [image-rendering:pixelated]"
        />
        {/* 字标用品牌蓝 #0E4598（取自品牌字标 LCode.png；不要写成 L-CODE） */}
        <span className="text-sm font-semibold tracking-wide text-[#0E4598]">LCode</span>
      </div>
      {menus.map((m) => (
        <div key={m.key} className="relative">
          <button
            onClick={() => setOpen(open === m.key ? null : m.key)}
            className={`rounded px-2.5 py-1 text-sm transition-colors hover:bg-accent ${
              open === m.key ? 'bg-accent' : ''
            }`}
          >
            {m.label}
          </button>
          {open === m.key ? (
            <div className="absolute left-0 top-full z-30 mt-0.5 min-w-40 rounded-md border bg-background p-1 shadow-lg">
              {m.items.map((it, idx) =>
                it.separator ? (
                  <div key={idx} className="my-1 h-px bg-border" />
                ) : (
                  <button
                    key={idx}
                    className="w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => run(it)}
                  >
                    {it.label}
                  </button>
                )
              )}
            </div>
          ) : null}
        </div>
      ))}

      {/* 收款码弹窗（帮助 → 支持开发者）：固定定位覆盖窗口；点遮罩或「关闭」收起 */}
      {payQr !== null || qrLoading ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 [-webkit-app-region:no-drag]"
          onMouseDown={() => {
            if (!qrLoading) setPayQr(null)
          }}
        >
          <div
            className="w-80 rounded-2xl border border-input bg-card p-4 text-center shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground">☕ {tr('payQrTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{tr('payQrDesc')}</p>
            {qrLoading ? (
              <p className="mt-4 text-xs text-muted-foreground">{tr('payQrLoading')}</p>
            ) : payQr && payQr.images.length > 0 ? (
              <div className="mt-3 flex flex-wrap justify-center gap-3">
                {payQr.images.map((img) => (
                  <img
                    key={img.name}
                    src={img.dataUrl}
                    alt={tr('payQrTitle')}
                    className="h-auto w-56 max-w-full rounded-lg border border-input bg-white"
                  />
                ))}
              </div>
            ) : (
              <p className="mt-4 text-xs text-red-600">
                {tr('payQrEmpty')}
                {payQr?.dir ? (
                  <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{payQr.dir}</span>
                ) : null}
              </p>
            )}
            <div className="mt-4 flex justify-center">
              <button
                className="rounded-md border border-input bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                onClick={() => setPayQr(null)}
                disabled={qrLoading}
              >
                {tr('payQrClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
