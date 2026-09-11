// 主题系统：白天 / 黑夜两套外观。
//
// 白天追求「明亮、轻盈、悠闲、自由」——暖米色底、青草绿主色、圆润边框；
// 黑夜追求「宁静、星夜与月光下」——深夜蓝底、月光蓝主色、再加一点星光点缀。
//
// 实现分两层：
//   1. antd 的 ConfigProvider 换 algorithm（darkAlgorithm）与 design token，
//      让所有组件统一换肤；
//   2. 页面背景这类组件管不到的地方，用 documentElement 上的 data-theme
//      属性驱动 index.css 里的渐变与星光。
//
// 用户的选择存 localStorage，下次打开记住。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'day' | 'night'

const STORAGE_KEY = 'travel_planner_theme'

/** 读初始主题：先看 localStorage，没有就跟随系统偏好 */
function initialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'day' || saved === 'night') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'day'
}

interface ThemeContextValue {
  mode: ThemeMode
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'day', toggle: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode)

  // 同步到 <html data-theme="...">，index.css 据此切换页面背景
  useEffect(() => {
    document.documentElement.dataset.theme = mode
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  const toggle = useCallback(() => {
    setMode((prev) => (prev === 'day' ? 'night' : 'day'))
  }, [])

  const value = useMemo(() => ({ mode, toggle }), [mode, toggle])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
