// 纸质手帐的共享零件。
//
// 为什么要把这些抽出来而不是各页各写一套：便利贴的倾斜、胶带的角度、
// 线圈的间距这类数值只要有一处不一致，整页的「手作感」立刻就散了。
// 集中在这里，改一个数就是全局一致的。
//
// 配色走两条路：
//   - 结构性的颜色（纸色、格线、胶带、书签）写在 index.css 的 CSS 变量里，
//     因为 ::before/::after 伪元素取不到 React 的 token；
//   - 需要按索引轮换的颜色（便利贴的淡彩）在 JS 里给，因为要用到序号。

import { theme } from 'antd'
import type { ReactNode } from 'react'
import { useTheme } from '../theme'

/** 便利贴的淡彩色。白天用高亮度的淡彩，黑夜换成同色系的暗调 */
const STICKY_DAY = ['#fdf3c6', '#e3f0d5', '#fbe3dd', '#dce9f4', '#efe6f7', '#f6ecd6']
const STICKY_NIGHT = ['#4b4734', '#36452e', '#4a3838', '#33414f', '#43394f', '#473f30']

/**
 * 便利贴底色，按索引轮换。
 *
 * 轮换而不是随机：随机每次渲染都可能变，用户滚动时颜色乱跳，像出了 bug。
 * 按索引取则同一张便利贴颜色永远稳定，整页又有变化。
 */
export function stickyColor(index: number): string {
  const palette = document.documentElement.dataset.theme === 'night' ? STICKY_NIGHT : STICKY_DAY
  return palette[index % palette.length]
}

/** 便利贴上的墨色。白天深褐，黑夜浅灰，保证压在对应底色上都读得清 */
export function useStickyInk() {
  const { mode } = useTheme()
  const isNight = mode === 'night'
  return {
    isNight,
    ink: isNight ? '#dde4ec' : '#3a3226',
    inkSoft: isNight ? 'rgba(221, 228, 236, 0.66)' : 'rgba(58, 50, 38, 0.62)',
    /** 便利贴上的分隔线，用当前墨色派生，深浅自然跟着走 */
    rule: isNight ? 'rgba(221, 228, 236, 0.16)' : 'rgba(58, 50, 38, 0.13)',
  }
}

/**
 * 一张便利贴。
 *
 * 倾斜角由 index 推导，让相邻两张往相反方向倒，看起来是「随手贴上去的」。
 * 角度刻意很小（±0.7°）：再大就会影响阅读，读者的眼睛会一直想去把它扶正。
 */
export function StickyNote({
  index,
  color,
  children,
  style,
  ...rest
}: {
  index: number
  color?: string
  children: ReactNode
  style?: React.CSSProperties
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style'>) {
  // 交替正负，并且每 4 张回到同一方向，避免出现规律性的「锯齿」
  const tilt = [0.7, -0.55, 0.4, -0.75][index % 4]

  return (
    <div
      className="sticky-note"
      style={{
        ['--tilt' as string]: `${tilt}deg`,
        background: color ?? stickyColor(index),
        ...style,
      }}
      {...rest}
    >
      {/* 顶端两角的胶带。用两个独立元素而不是伪元素，
          因为伪元素已经被 hover / 提角这类效果占用了 */}
      <span className="sticky-tape sticky-tape-left" />
      <span className="sticky-tape sticky-tape-right" />
      {children}
    </div>
  )
}

/**
 * 线圈本左侧的那排金属环。
 *
 * 环的数量按容器高度估：每 26px 一个环。太少会显得空、太多会挤成一条实线。
 */
export function NotebookRings({ count }: { count: number }) {
  return (
    <div className="notebook-rings" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="notebook-ring" />
      ))}
    </div>
  )
}

/**
 * 纸页。给 antd Card 之外的容器用，视觉与卡片一致（同一个纸纹与投影）。
 */
export function PaperSheet({
  children,
  style,
  className,
  ...rest
}: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const { token } = theme.useToken()
  return (
    <div
      className={`paper-sheet ${className ?? ''}`}
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * 表单里的分区签。
 *
 * 用途是解决「一整页表单平铺下来、看不出哪儿到哪儿」的问题：
 * 一枚牛皮纸小签把分区名压在上面，再拉一条细线到右边，
 * 视线扫过时自然分层。签条直接复用书签那套纸色变量，
 * 所以整站的纸质语言是一致的，不是新发明一种样式。
 */
export function FormSection({ children, hint }: { children: ReactNode; hint?: string }) {
  const { token } = theme.useToken()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 16px' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '3px 12px',
          borderRadius: 3,
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: 0.6,
          color: 'var(--mark-ink)',
          background: 'linear-gradient(115deg, var(--mark-top), var(--mark-bottom))',
          boxShadow: '0 1px 2px rgba(60, 44, 24, 0.18)',
          flexShrink: 0,
        }}
      >
        {children}
      </span>
      {hint && (
        <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>{hint}</span>
      )}
      <span
        style={{ flex: 1, height: 1, background: token.colorBorderSecondary, minWidth: 24 }}
        aria-hidden="true"
      />
    </div>
  )
}
