/**
 * 中间内容窗：所有"点击打开"的内容都在这里显示（文件 / 产物）
 * 产物为二进制时给出提示与路径。
 */
import { useMemo } from 'react'
import type { FileContent } from '../../../shared/types'
import { useT } from '../i18n'
import { detectLang, highlightToHtml } from './codeHighlight'

export interface OpenItem {
  kind: 'file' | 'artifact'
  path: string
  name: string
  size_kb?: number
}

interface Props {
  item: OpenItem | null
  file: FileContent | null
  error: string
  onClose: () => void
}

const BINARY_EXT = ['.bin', '.elf', '.hex', '.a', '.o', '.png', '.jpg', '.pdf', '.zip']

export function ContentView({ item, file, error, onClose }: Props): JSX.Element {
  const tr = useT()

  const codeHtml = useMemo(
    () => (file ? highlightToHtml(file.content, detectLang(file.name)) : ''),
    [file]
  )

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {tr('contentEmpty')}
      </div>
    )
  }

  const isBinary =
    item.kind === 'artifact' || BINARY_EXT.some((e) => item.name.toLowerCase().endsWith(e))

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">
          {item.kind === 'artifact' ? '📦 ' : '📄 '}
          {item.path}
        </span>
        <button className="shrink-0 rounded px-1.5 hover:bg-accent" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-red-600">{error}</div>
        ) : isBinary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            <div className="text-4xl">📦</div>
            <div>{tr('contentBinary')}</div>
            <div className="max-w-full truncate font-mono text-xs">{item.path}</div>
            {item.size_kb !== undefined ? (
              <div className="text-xs">
                {tr('contentSize')}：{item.size_kb} KB
              </div>
            ) : null}
          </div>
        ) : file ? (
          <pre
            className="p-3 font-mono text-xs leading-5"
            dangerouslySetInnerHTML={{ __html: codeHtml }}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">{tr('contentLoading')}</div>
        )}
      </div>
    </div>
  )
}
