// 登录后的整体框架：左侧导航、顶部用户信息、右侧内容区。
// 具体页面通过 react-router 的 Outlet 渲染进内容区。

import { Button, Layout, Menu, Space, Typography } from 'antd'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { clearToken, getUsernameFromToken } from '../auth'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  // 根据当前路径决定左侧菜单高亮哪一项
  const selectedKey = location.pathname.startsWith('/settings')
    ? 'settings'
    : location.pathname.startsWith('/trips/new')
      ? 'new'
      : 'trips'

  function handleLogout() {
    clearToken()
    navigate('/login', { replace: true })
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={200}>
        <div style={{ padding: '20px 16px 12px', fontSize: 16, fontWeight: 600 }}>
          旅游规划助手
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          style={{ borderInlineEnd: 'none' }}
          items={[
            { key: 'trips', label: <Link to="/trips">我的行程</Link> },
            { key: 'new', label: <Link to="/trips/new">新建行程</Link> },
            { key: 'settings', label: <Link to="/settings">个人设置</Link> },
          ]}
        />
      </Sider>

      <Layout>
        <Header
          style={{
            background: '#fff',
            paddingInline: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <Space size={12}>
            <Typography.Text type="secondary">
              {getUsernameFromToken() ?? '未登录'}
            </Typography.Text>
            <Button size="small" onClick={handleLogout}>
              退出登录
            </Button>
          </Space>
        </Header>

        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
