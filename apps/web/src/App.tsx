// 路由表。
// 除登录页外，所有页面都包在 RequireAuth 里：本地没有登录凭证时直接跳到登录页。
//
// 页面级代码分割（见审查报告性能一节）：
//   原先所有页面与 antd 全量组件被打进同一个 bundle，首屏必须整包下载。
//   改成 React.lazy 按路由懒加载后，首屏只需加载「登录页 + 共享运行时」，
//   其余页面（含其用到的 antd 组件）在真正跳转时才拉取，首屏体积与首屏时间都显著下降。
//   每个懒加载页面统一包在 lazyPage() 里，用骨架条兜底，避免切换瞬间空白闪烁。

import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './auth'
import AppLayout from './components/AppLayout'

// 登录页是未登录用户的唯一入口，保持同步加载，避免首屏多一次网络往返
import Login from './pages/Login'

const NewTrip = lazy(() => import('./pages/NewTrip'))
const Settings = lazy(() => import('./pages/Settings'))
const TripDetail = lazy(() => import('./pages/TripDetail'))
const TripList = lazy(() => import('./pages/TripList'))

/** 懒加载页面的统一兜底：纯 CSS 骨架条占位，切换瞬间不出现空白闪烁 */
function PageFallback() {
  return (
    <div style={{ padding: 24 }} aria-busy="true" aria-live="polite">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 16,
            marginBottom: 16,
            borderRadius: 8,
            background: 'linear-gradient(90deg, rgba(128,128,128,0.12), rgba(128,128,128,0.06), rgba(128,128,128,0.12))',
            backgroundSize: '200% 100%',
            animation: 'pageFallbackShimmer 1.4s ease-in-out infinite',
          }}
        />
      ))}
      <style>{'@keyframes pageFallbackShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'}</style>
    </div>
  )
}

/** 把懒加载页面包进 Suspense，集中处理加载态 */
function lazyPage(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>
}

function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/trips" replace />} />
        <Route path="trips" element={lazyPage(<TripList />)} />
        <Route path="trips/new" element={lazyPage(<NewTrip />)} />
        <Route path="trips/:id" element={lazyPage(<TripDetail />)} />
        <Route path="settings" element={lazyPage(<Settings />)} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
