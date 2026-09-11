// 登录后的整体框架：左侧导航、顶部用户信息、右侧内容区。
// 具体页面通过 react-router 的 Outlet 渲染进内容区。
//
// 布局约定：
//   - 整个框架锁定在一屏高（100vh）里：左侧栏永远固定可见，只有右侧内容区滚动。
//     这样菜单与底部的「外观」切换始终同屏，不会跟着内容一起滚走。
//   - 左侧栏与顶栏用半透明毛玻璃：动漫风背景图从底下透出来，界面不显得死板。

import {
  CarryOutOutlined,
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

  /**
   * 当前是不是「行程详情」页（/trips/:id）。
   *
   * 用途：这一页要用「右侧锁定 + 左侧独立滚动」的布局，
   * 外层内容区必须让出滚动权，否则会出现双层滚动条、
   * 或者右侧地图被外层滚动带出视野。
   * 判定要排除 /trips（列表）与 /trips/new（新建向导），它们仍需整页滚动。
   */
  const isTripDetailPage = /^\/trips\/[^/]+$/.test(location.pathname) && location.pathname !== '/trips/new'

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
    // 锁定一屏高：内容区自己滚动，左侧栏（含外观切换）永远固定可见
    <Layout style={{ height: '100vh', overflow: 'hidden', background: 'transparent' }}>
      <Sider width={212} theme="light" className="app-sider">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* 顶部横幅：当前主题的风景插画 + 应用名 */}
          <div className="app-banner">
            <span className="app-banner-title">🌿 旅游规划助手</span>
          </div>

          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ borderInlineEnd: 'none', flex: 1, background: 'transparent' }}
            items={[
              { key: 'trips', icon: <CarryOutOutlined />, label: <Link to="/trips">我的行程</Link> },
              { key: 'new', icon: <PlusCircleOutlined />, label: <Link to="/trips/new">新建行程</Link> },
              { key: 'settings', icon: <SettingOutlined />, label: <Link to="/settings">个人设置</Link> },
            ]}
          />

          {/* 外观切换：白天 = 明亮悠闲，黑夜 = 星夜月光。与菜单同屏、固定不滚动 */}
          <div style={{ padding: '10px 14px 14px' }}>
            <Divider style={{ margin: '0 0 10px' }} plain>
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

      <Layout style={{ height: '100vh', background: 'transparent' }}>
        <Header className="app-header">
          <Space size={12}>
            <UserAvatar avatar={me?.avatar} username={me?.username} size={32} />
            <Typography.Text>{me?.username ?? '未登录'}</Typography.Text>
            <Button size="small" onClick={handleLogout}>
              退出登录
            </Button>
          </Space>
        </Header>

        {/* 只有这里滚动：左侧栏与顶栏固定。
            行程详情页例外：那一页要「右侧地图钉住不动、只滚左侧每日安排」，
            所以外层不滚，交给页面内部自己管。判断方式是最小改动且不依赖
            全局状态——路径形如 /trips/xxx 且不是 /trips 或 /trips/new。 */}
        <Content
          style={{
            overflowY: isTripDetailPage ? 'hidden' : 'auto',
            padding: isTripDetailPage ? '20px 24px 16px' : '20px 24px 32px',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
