import { App as AntdApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { ThemeProvider, useTheme } from './theme'

/** Ant Design 是页面组件的统一视觉基础，CSS 只负责布局与响应式补充。 */
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
          colorPrimary: isNight ? '#8ed0ad' : '#2f7058',
          colorBgLayout: isNight ? '#141b18' : '#f8f7f3',
          colorBgContainer: isNight ? '#1d2622' : '#ffffff',
          colorBgElevated: isNight ? '#24312b' : '#ffffff',
          colorText: isNight ? '#edf4ef' : '#263a32',
          colorTextSecondary: isNight ? '#b8c8bf' : '#53665d',
          colorTextTertiary: isNight ? '#9db0a6' : '#647970',
          colorBorder: isNight ? '#9dbbad' : '#718f82',
          colorBorderSecondary: isNight ? '#304039' : '#e8eeea',
          colorTextPlaceholder: isNight ? '#a7bcb0' : '#5f7067',
          borderRadius: 12,
          fontSize: 15,
          controlHeight: 40,
        },
        components: {
          Layout: {
            siderBg: isNight ? '#1d2622' : '#ffffff',
            headerBg: isNight ? '#1d2622' : '#ffffff',
          },
          Menu: {
            itemSelectedBg: isNight ? 'rgba(142,208,173,.18)' : 'rgba(47,112,88,.10)',
            itemSelectedColor: isNight ? '#b8e7cc' : '#2f7058',
          },
          Input: {
            activeBg: isNight ? '#24312b' : '#ffffff',
          },
          Button: {
            primaryColor: isNight ? '#102219' : '#ffffff',
          },
          Select: {
            optionSelectedBg: isNight ? 'rgba(142,208,173,.16)' : 'rgba(47,112,88,.10)',
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
