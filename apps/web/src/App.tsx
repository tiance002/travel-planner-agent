// 路由表。
// 除登录页外，所有页面都包在 RequireAuth 里：本地没有登录凭证时直接跳到登录页。

import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './auth'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import NewTrip from './pages/NewTrip'
import Settings from './pages/Settings'
import TripDetail from './pages/TripDetail'
import TripList from './pages/TripList'

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
        <Route path="trips" element={<TripList />} />
        <Route path="trips/new" element={<NewTrip />} />
        <Route path="trips/:id" element={<TripDetail />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
