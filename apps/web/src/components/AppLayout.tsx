import {
  CarryOutOutlined,
  CompassOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  PlusCircleOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons'
import { Button, Drawer, Dropdown, Layout, Menu, Segmented, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { clearToken, getToken } from '../auth'
import { fetchMe, ME_UPDATED_EVENT, type MeInfo } from '../api/account'
import { useTheme } from '../theme'
import UserAvatar from './UserAvatar'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, toggle } = useTheme()
  const [me, setMe] = useState<MeInfo | null>(null)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!getToken()) return
    const refresh = () => {
      void fetchMe().then(info => { if (!cancelled) setMe(info) }).catch(() => undefined)
    }
    refresh()
    window.addEventListener(ME_UPDATED_EVENT, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(ME_UPDATED_EVENT, refresh)
    }
  }, [])

  useEffect(() => { setNavOpen(false) }, [location.pathname])

  const selectedKey = location.pathname.startsWith('/settings')
    ? 'settings'
    : location.pathname.startsWith('/trips/new') ? 'new' : 'trips'

  function logout() {
    clearToken()
    navigate('/login', { replace: true })
  }

  const menuItems = [
    { key: 'trips', icon: <CarryOutOutlined />, label: '我的行程', path: '/trips' },
    { key: 'new', icon: <PlusCircleOutlined />, label: '新建行程', path: '/trips/new' },
    { key: 'settings', icon: <SettingOutlined />, label: '个人设置', path: '/settings' },
  ]

  const navigation = (
    <div className="app-nav-content">
      <Menu
        mode="inline"
        selectedKeys={[selectedKey]}
        items={menuItems.map(({ key, icon, label }) => ({ key, icon, label }))}
        onClick={({ key }) => {
          const target = menuItems.find(item => item.key === key)
          if (target) navigate(target.path)
          setNavOpen(false)
        }}
        style={{ borderInlineEnd: 'none' }}
      />
      <div className="app-theme-switch">
        <Typography.Text type="secondary">外观</Typography.Text>
        <Segmented
          block
          value={mode}
          onChange={toggle}
          data-testid="theme-toggle"
          options={[
            { value: 'day', icon: <SunOutlined />, label: '白天' },
            { value: 'night', icon: <MoonOutlined />, label: '黑夜' },
          ]}
        />
      </div>
    </div>
  )

  return (
    <Layout className="app-shell">
      <Sider width={232} className="app-sider" theme={mode === 'night' ? 'dark' : 'light'}>
        <div className="app-brand"><CompassOutlined className="app-brand-mark" />旅游规划助手</div>
        {navigation}
      </Sider>
      <Layout className="app-main">
        <Header className="app-header">
          <div className="app-header-start">
            <Button
              className="app-menu-button"
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开导航"
              title="打开导航"
              onClick={() => setNavOpen(true)}
            />
            <span className="app-header-brand">旅游规划助手</span>
          </div>
          <Dropdown
            trigger={['click']}
            menu={{ items: [
              { key: 'settings', icon: <SettingOutlined />, label: '个人设置', onClick: () => navigate('/settings') },
              { type: 'divider' },
              { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout },
            ] }}
          >
            <Button type="text" className="app-account-button" aria-label="账户菜单">
              <Space size={8}>
                <UserAvatar avatar={me?.avatar} username={me?.username} size={32} />
                <span className="app-account-name">{me?.username ?? '账户'}</span>
              </Space>
            </Button>
          </Dropdown>
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
      <Drawer
        title="旅游规划助手"
        placement="left"
        size={288}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        {navigation}
      </Drawer>
    </Layout>
  )
}
