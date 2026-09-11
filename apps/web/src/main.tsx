import { App as AntdApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { ThemeProvider, useTheme } from './theme'

/** 按当前模式产出 antd 主题配置。两套 token 都是「悠闲风」：圆润、柔和、低密度压迫感 */
function ThemedConfigProvider({ children }: { children: React.ReactNode }) {
  const { mode } = useTheme()
  const isNight = mode === 'night'

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        // algorithm 是 antd 的换肤算法：defaultAlgorithm 白天、darkAlgorithm 黑夜
        algorithm: isNight ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          // 主色：白天青草绿（度假感），黑夜月光蓝（宁静星夜）
          colorPrimary: isNight ? '#7d9be8' : '#3a9d7c',
          // 页面底色：白天暖米白，黑夜深夜蓝
          colorBgLayout: isNight ? '#0e1522' : '#f6f4ec',
          // 圆角放大一点，整体更松弛
          borderRadius: 12,
          fontSize: 14,
          // 卡片阴影柔化，避免「沉重」的界面感
          boxShadowTertiary: isNight
            ? '0 6px 24px rgba(0, 0, 0, 0.35)'
            : '0 6px 24px rgba(120, 144, 120, 0.10)',
        },
        components: {
          Layout: {
            // 侧栏与顶栏的背景交给 index.css 的毛玻璃类控制，这里保持透明
            siderBg: 'transparent',
            headerBg: 'transparent',
          },
          Menu: {
            // 菜单选中项也用主色系，视觉统一
            itemSelectedBg: isNight ? 'rgba(125, 155, 232, 0.18)' : 'rgba(58, 157, 124, 0.12)',
          },
        },
      }}
    >
      {children}
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* ThemeProvider 管白天/黑夜状态；ThemedConfigProvider 把状态翻译成 antd 主题 */}
    <ThemeProvider>
      <ThemedConfigProvider>
        <AntdApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntdApp>
      </ThemedConfigProvider>
    </ThemeProvider>
  </StrictMode>,
)
