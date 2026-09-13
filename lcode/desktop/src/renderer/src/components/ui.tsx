/**
 * 极简 shadcn 风格组件（Tailwind 实现，W2 基础版）
 * 完整 Radix 无障碍原语在 W3 打磨时引入
 */
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

// ---------- Button ----------
export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive' | 'info'
  size?: 'sm' | 'md' | 'icon'
}) {
  const base =
    'inline-flex items-center justify-center gap-1 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none'
  const variants = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    // 主操作蓝（DSH InputBar .primary 同款语义：info-fill，非品牌墨色）
    info: 'bg-info text-info-foreground hover:bg-info-hover'
  }
  // 圆角随尺寸走（基类不带圆角，避免与 className 追加的 rounded-* 相互覆盖）
  const sizes = {
    sm: 'rounded-md px-2 py-1 text-xs',
    md: 'rounded-md px-3 py-1.5 text-sm',
    icon: 'rounded-full h-9 w-9 p-0 text-sm'
  }
  return <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props} />
}

// ---------- Input ----------
export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${className}`}
      {...props}
    />
  )
}

// ---------- Card ----------
export function Card({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="border-b px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
    </div>
  )
}

// ---------- Badge ----------
export function Badge({
  children,
  color = 'muted'
}: {
  children: ReactNode
  color?: 'muted' | 'green' | 'red' | 'yellow' | 'blue'
}) {
  const colors = {
    muted: 'bg-muted text-muted-foreground',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    blue: 'bg-blue-100 text-blue-700'
  }
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  )
}

export function statusBadgeColor(status: string): 'muted' | 'green' | 'red' | 'yellow' | 'blue' {
  switch (status) {
    case 'SUCCESS':
      return 'green'
    case 'FAILED':
    case 'CANCELED':
      return 'red'
    case 'RUNNING':
      return 'blue'
    case 'PENDING':
      return 'yellow'
    default:
      return 'muted'
  }
}

export const STATUS_TEXT: Record<string, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  SUCCESS: '成功',
  FAILED: '失败',
  CANCELED: '已取消',
  INTERRUPTED: '已中断'
}

// ---------- 分隔与空态 ----------
export function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{text}</div>
}
