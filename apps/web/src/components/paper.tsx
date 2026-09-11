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
//
// **颜色一律从 React 的主题状态派生，不要去读 documentElement.dataset.theme。**
// 那个属性是在 useEffect 里才更新的，与渲染存在一帧的时间差，
// 会造成「一半颜色是新主题、一半还是旧主题」的错配（见 usePaperTheme 的说明）。

import { theme } from 'antd'
import type { ReactNode } from 'react'
import { useTheme } from '../theme'

/**
 * 便利贴的底色：**白天黑夜都用浅色调**。
 *
 * 为什么黑夜也坚持用浅色：真实的手帐里，便利贴是实打实的浅色纸，
 * 贴在深色封面上反而最醒目。更重要的是，浅底 + 深墨能保证对比度——
 * 之前黑夜用暗调便利贴、配浅色字，两边都灰蒙蒙的，字很难看清。
 */
const STICKY_LIGHT = ['#fdf3c6', '#e3f0d5', '#fbe3dd', '#dce9f4', '#efe6f7', '#f6ecd6']

/**
 * 便利贴上的墨色。底色恒为浅色，所以墨色也恒定用深褐，对比度天然拉满。
 * 这里刻意不跟随主题——跟随的话黑夜会翻成浅字，压在浅底上直接看不见。
 */
export const NOTE_INK = '#3a3226'
/** 次级文字的墨色。alpha 别压太低——便利贴上信息密度大，太淡就看不清了 */
const NOTE_INK_SOFT = 'rgba(58, 50, 38, 0.8)'
/** 便利贴上的描边/分隔线，由墨色派生，深浅自然跟着走 */
const NOTE_RULE = 'rgba(58, 50, 38, 0.16)'

/**
 * 纸质主题的取色入口。**所有颜色都从 React 的主题状态派生**。
 *
 * 早先这里犯过一个隐蔽的错：便利贴底色读的是 `document.documentElement.dataset.theme`
 * （DOM 属性），而墨色读的是 React 的 `mode`。切换主题时，DOM 属性是在 useEffect 里
 * 才更新的，于是存在一帧「底色已经是新主题、墨色还是旧主题」的空档——
 * 表现成**浅底配浅字，整张便利贴上的字全糊了**。现在两者同源，不可能再错开。
 */
export function usePaperTheme() {
  const { mode } = useTheme()
  const isNight = mode === 'night'
  return {
    isNight,
    /** 便利贴：恒为浅底 + 深墨 */
    note: {
      palette: STICKY_LIGHT,
      colorAt: (index: number) => STICKY_LIGHT[index % STICKY_LIGHT.length],
      ink: NOTE_INK,
      inkSoft: NOTE_INK_SOFT,
      rule: NOTE_RULE,
    },
    /** 纸页上的文字（线圈本的说明文字等）：这部分要跟着主题走 */
    page: {
      ink: isNight ? '#d2d9e2' : '#3d3527',
      inkSoft: isNight ? 'rgba(210, 217, 226, 0.66)' : 'rgba(61, 53, 39, 0.62)',
    },
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
  const { note } = usePaperTheme()
  // 交替正负，并且每 4 张回到同一方向，避免出现规律性的「锯齿」
  const tilt = [0.7, -0.55, 0.4, -0.75][index % 4]

  return (
    <div
      className="sticky-note"
      style={{
        ['--tilt' as string]: `${tilt}deg`,
        background: color ?? note.colorAt(index),
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
