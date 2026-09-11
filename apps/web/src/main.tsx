import { App as AntdApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { ThemeProvider, useTheme } from './theme'

/** 按当前模式产出 antd 主题配置。两套 token 都是「纸质手帐」风：纸底、墨字、圆润但不高光 */
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
          // 表面色刻意不用纯白/纯黑，改成「纸色」。
          // 这一处改动会让所有 Card、输入框、下拉面板自动获得纸质感，
          // 不必逐页去写背景色——这是整套纸质主题能低成本铺开的关键。
          colorBgContainer: isNight ? '#242a33' : '#fbf7ec',
          colorBgElevated: isNight ? '#2b323c' : '#fffdf6',
          // 文字用「墨色」：白天是暖褐墨，黑夜是月光石灰。
          // 纯黑纯灰在纸面上会显得生硬，偏暖/偏蓝才有手写墨迹的感觉
          colorText: isNight ? '#d2d9e2' : '#3d3527',
          colorTextSecondary: isNight ? '#9aa6b6' : '#6d6350',
          colorTextTertiary: isNight ? '#7c8798' : '#928873',
          // 描边改成偏纸纤维的暖色，避免灰色描边把纸感拉回「网页」
          colorBorder: isNight ? '#3d4551' : '#ded2b8',
          colorBorderSecondary: isNight ? '#333b46' : '#eae0ca',
          // 圆角放大一点，整体更松弛
          borderRadius: 12,
          fontSize: 14,
          // 纸页的投影要「贴地」而不是「浮空」：一层极近的接触阴影 + 一层柔和扩散
          boxShadowTertiary: isNight
            ? '0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.34)'
            : '0 1px 2px rgba(120, 100, 60, 0.10), 0 8px 24px rgba(120, 100, 60, 0.08)',
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
          Input: {
            // 输入框不要纯白底，跟着纸面走，只留一圈细描边
            activeBg: isNight ? '#2b323c' : '#fffdf6',
          },
          Select: {
            optionSelectedBg: isNight ? 'rgba(125, 155, 232, 0.16)' : 'rgba(58, 157, 124, 0.10)',
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
