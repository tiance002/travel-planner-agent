// 登录后的整体框架：左侧导航、顶部用户信息、右侧内容区。
// 具体页面通过 react-router 的 Outlet 渲染进内容区。
//
// 悠闲风的界面约定：左侧栏带图标、底部有「外观」切换（白天/黑夜），
// 顶栏显示用户头像。改名/换头像后通过 me-updated 事件立刻刷新显示。

import {
  CarryOutOutlined,
  CompassOutlined,
  MoonOutlined,
  PlusCircleOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons'
import { Button, Divider, Layout, Menu, Segmented, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { clearToken, getToken } from '../auth'
import { fetchMe, ME_UPDATED_EVENT, type MeInfo } from '../api/account'
import UserAvatar from './UserAvatar'
import { useTheme } from '../theme'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, toggle } = useTheme()

  // 顶栏展示的用户信息。改名与换头像在设置页完成后会广播事件，这里监听刷新
  const [me, setMe] = useState<MeInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    // 没有 token 时不必请求（正常流程 RequireAuth 已拦，这里做防御）
    if (!getToken()) return
    fetchMe()
      .then((info) => {
        if (!cancelled) setMe(info)
      })
      .catch(() => undefined)
    const refresh = () => {
      fetchMe()
        .then((info) => {
          if (!cancelled) setMe(info)
        })
        .catch(() => undefined)
    }
    window.addEventListener(ME_UPDATED_EVENT, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(ME_UPDATED_EVENT, refresh)
    }
  }, [])

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
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      <Sider theme="light" width={200} style={{ borderRadius: '0 16px 16px 0', overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
          <div style={{ padding: '20px 16px 12px', fontSize: 16, fontWeight: 600 }}>
            🌿 旅游规划助手
          </div>

          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ borderInlineEnd: 'none', flex: 1 }}
            items={[
              { key: 'trips', icon: <CarryOutOutlined />, label: <Link to="/trips">我的行程</Link> },
              { key: 'new', icon: <PlusCircleOutlined />, label: <Link to="/trips/new">新建行程</Link> },
              { key: 'settings', icon: <SettingOutlined />, label: <Link to="/settings">个人设置</Link> },
            ]}
          />

          {/* 外观切换：白天 = 明亮悠闲，黑夜 = 星夜月光。选择会被记住 */}
          <div style={{ padding: '12px 16px 16px' }}>
            <Divider style={{ margin: '0 0 12px' }} plain>
              外观
            </Divider>
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
      </Sider>

      <Layout style={{ background: 'transparent' }}>
        <Header
          style={{
            paddingInline: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <Space size={12}>
            <UserAvatar avatar={me?.avatar} username={me?.username} size={32} />
            <Typography.Text type="secondary">{me?.username ?? '未登录'}</Typography.Text>
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
