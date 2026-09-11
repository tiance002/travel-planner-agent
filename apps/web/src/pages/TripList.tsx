// 我的行程页。
//
// 视觉上刻意不用「纯白大卡片 + 灰字」那种最省事的写法：
// 白底卡片在黑夜模式下会变成一块刺眼的亮斑，在白天模式下又和背景糊成一片。
// 这里改成——外层是一层极淡的主色底（跟随主题），左侧一个城市缩写色块当视觉锚点，
// 所有信息改写成胶囊标签，一眼能扫到「去哪、几天、几个人、住哪」。
// 全部颜色取自 antd token，所以白天/黑夜自动跟着换，不需要写两套。

import { App, Button, Empty, Popconfirm, Skeleton, Space, Tag, theme, Typography } from 'antd'
import { CompassOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, extractError } from '../api/client'

interface TripSummary {
  id: string
  title: string
  cityName: string
  startDate: string
  days: number
  travelers: number
  status: string
  stayResolved: boolean
  stayName: string | null
}

// 行程状态对应的说明与色板。色值不写死，交给 antd 的 Tag 语义色处理
const STATUS_TEXT: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  generating: { label: '生成中', color: 'processing' },
  ready: { label: '已完成', color: 'success' },
  failed: { label: '生成失败', color: 'error' },
}

/** 取城市名的前两个字当色块文字。中文城市名取两字刚好，英文则截前两位 */
function cityInitial(cityName: string): string {
  const trimmed = cityName.trim()
  if (!trimmed) return '旅'
  // 拉丁字母城市名（例如 "Paris"）取前两位并大写
  if (/^[A-Za-z]/.test(trimmed)) return trimmed.slice(0, 2).toUpperCase()
  return trimmed.slice(0, 2)
}

/**
 * 一枚信息胶囊。行程卡片里的所有信息都用它承载。
 *
 * 为什么手写而不用 antd 的 Tag：Tag 自带的状态色语义不适合「出发日期」
 * 这种中性信息，硬套会得到一堆颜色打架的标签。这里用主题的填充色，
 * 视觉上比 Tag 更安静，也天然适配双主题。
 */
function Pill({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  const { token } = theme.useToken()
  return (
    <span
      data-testid="trip-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: 1.6,
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        color: token.colorTextSecondary,
        whiteSpace: 'nowrap',
      }}
    >
      {icon ? <span style={{ fontSize: 12, color: token.colorTextTertiary }}>{icon}</span> : null}
      {children}
    </span>
  )
}

export default function TripList() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .get<{ trips: TripSummary[] }>('/trips')
      .then(({ data }) => {
        if (!cancelled) setTrips(data.trips)
      })
      .catch((error) => {
        if (!cancelled) message.error(extractError(error, '行程列表加载失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // 组件卸载后不再更新状态，避免内存泄漏警告
    return () => {
      cancelled = true
    }
  }, [])

  // 删除行程。删除后直接从本地列表里移除，不必重新拉一遍全量数据
  async function handleDelete(id: string) {
    try {
      await api.delete(`/trips/${id}`)
      setTrips((prev) => prev.filter((item) => item.id !== id))
      message.success('行程已删除')
    } catch (error) {
      message.error(extractError(error, '删除失败'))
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Space
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}
        align="center"
      >
        <Space size={8}>
          <CompassOutlined style={{ color: token.colorPrimary }} />
          <Typography.Title level={4} style={{ margin: 0 }}>
            我的行程
          </Typography.Title>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/trips/new')}>
          新建行程
        </Button>
      </Space>

      {loading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : trips.length === 0 ? (
        <div
          style={{
            padding: '48px 24px',
            borderRadius: token.borderRadiusLG,
            background: token.colorFillQuaternary,
            border: `1px dashed ${token.colorBorderSecondary}`,
          }}
        >
          <Empty description="还没有行程">
            <Button type="primary" onClick={() => navigate('/trips/new')}>
              创建第一个行程
            </Button>
          </Empty>
        </div>
      ) : (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          {trips.map((trip) => {
            const status = STATUS_TEXT[trip.status] ?? STATUS_TEXT.draft
            const hovered = hoveredId === trip.id
            return (
              <div
                key={trip.id}
                data-testid="trip-card"
                onClick={() => navigate(`/trips/${trip.id}`)}
                onMouseEnter={() => setHoveredId(trip.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: 16,
                  borderRadius: token.borderRadiusLG,
                  // 底色用极淡的主色填充而不是白色：白天模式偏暖、黑夜模式偏深，
                  // 两种主题下都不会出现刺眼的亮块
                  background: token.colorFillQuaternary,
                  border: `1px solid ${hovered ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                  cursor: 'pointer',
                  transition: 'border-color .2s, box-shadow .2s, transform .2s',
                  transform: hovered ? 'translateY(-1px)' : 'none',
                  boxShadow: hovered ? token.boxShadowTertiary : 'none',
                }}
              >
                {/* 城市缩写色块：卡片左侧的视觉锚点，比一行灰字更容易扫到 */}
                <div
                  style={{
                    flex: '0 0 52px',
                    height: 52,
                    borderRadius: token.borderRadius,
                    background: token.colorPrimaryBg,
                    border: `1px solid ${token.colorPrimaryBorder}`,
                    color: token.colorPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    fontWeight: 500,
                    letterSpacing: 1,
                  }}
                  data-testid="trip-city-initial"
                >
                  {cityInitial(trip.cityName)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <Typography.Text
                      strong
                      style={{
                        fontSize: 15,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {trip.title}
                    </Typography.Text>
                    <Tag color={status.color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                      {status.label}
                    </Tag>
                  </div>

                  {/* 信息全部改成胶囊标签，横向铺开，一眼扫完 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <Pill icon={<span style={{ fontSize: 11 }}>◎</span>}>{trip.cityName}</Pill>
                    <Pill>{trip.startDate.slice(0, 10)} 出发</Pill>
                    <Pill>{trip.days} 天</Pill>
                    <Pill>{trip.travelers} 人</Pill>
                    <Pill icon={<span style={{ fontSize: 11 }}>⌂</span>}>
                      {trip.stayResolved ? (trip.stayName ?? '已选定住宿') : '住宿待定'}
                    </Pill>
                  </div>
                </div>

                {/* stopPropagation：删除是危险动作，不能被卡片整体点击带着跳详情页 */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <Popconfirm
                    title="确定删除这个行程吗？"
                    description="删除后无法恢复，行程中的打卡记录也会一并清除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void handleDelete(trip.id)}
                  >
                    <Button danger size="small" type="text">
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            )
          })}
        </Space>
      )}
    </div>
  )
}
