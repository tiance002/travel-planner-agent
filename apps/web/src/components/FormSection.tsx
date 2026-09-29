import { theme } from 'antd'
import type { ReactNode } from 'react'

export default function FormSection({ children, hint }: { children: ReactNode; hint?: string }) {
  const { token } = theme.useToken()
  return (
    <div style={{ margin: '28px 0 18px', paddingBottom: 10, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: token.colorText }}>{children}</div>
      {hint && <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 4 }}>{hint}</div>}
    </div>
  )
}
