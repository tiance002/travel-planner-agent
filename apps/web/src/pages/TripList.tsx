// 我的行程页。
//
// 视觉上把每条行程做成「横躺的牛皮纸书签」：
//   - 白天是棕色牛皮纸，黑夜是灰色——靠 index.css 里的一套 CSS 变量切换，
//     组件这里不需要写任何 if (isNight)；
//   - 右端切一个 V 形口（书签最容易被认出的特征），左端一个穿线孔；
//   - 细长：一条只占 60 出头的高度，比原来的大卡片能多看好几条。
//
// 信息仍然全部保留，只是改成书签上的小字标，颜色用半透明白，
// 压在任何纸色上都读得清。

import { App, Button, Empty, Popconfirm, Skeleton, Space, theme, Typography } from 'antd'
import { CompassOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, extractError } from '../api/client'
import { PaperSheet } from '../components/paper'

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

/**
 * 行程状态的圆点颜色。书签是深色牛皮纸，antd 的 Tag 浅底彩字压上去会脏，
 * 所以状态改成一个色点 + 一行浅字，安静且一定可读。
 */
const STATUS_DOT: Record<string, { label: string; dot: string }> = {
  draft: { label: '草稿', dot: '#c9bda6' },
  generating: { label: '生成中', dot: '#79b8e8' },
  ready: { label: '已完成', dot: '#7fd6a8' },
  failed: { label: '生成失败', dot: '#f0928c' },
}

/** 取城市名的前两个字。中文取两字刚好，英文则截前两位 */
function cityInitial(cityName: string): string {
  const trimmed = cityName.trim()
  if (!trimmed) return '旅'
  if (/^[A-Za-z]/.test(trimmed)) return trimmed.slice(0, 2).toUpperCase()
  return trimmed.slice(0, 2)
}

export default function TripList() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [loading, setLoading] = useState(true)

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
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Space
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 14 }}
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
        <PaperSheet style={{ padding: '44px 24px' }}>
          <Empty description="还没有行程">
            <Button type="primary" onClick={() => navigate('/trips/new')}>
              创建第一个行程
            </Button>
          </Empty>
        </PaperSheet>
      ) : (
        /* 书签是「夹在本子里」的，所以底下垫一整页纸，而不是让它们飘在背景上 */
        <PaperSheet
          style={{
            padding: '20px 18px 24px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {trips.map((trip) => {
            const status = STATUS_DOT[trip.status] ?? STATUS_DOT.draft
            return (
              <div
                key={trip.id}
                className="bookmark"
                data-testid="trip-card"
                onClick={() => navigate(`/trips/${trip.id}`)}
              >
                {/* 城市缩写：书签上的「分类印记」 */}
                <span
                  data-testid="trip-city-initial"
                  style={{
                    flex: '0 0 auto',
                    minWidth: 40,
                    textAlign: 'center',
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: 1.5,
                    color: 'var(--mark-ink)',
                    borderRight: '1px dashed rgba(255, 255, 255, 0.3)',
                    paddingRight: 12,
                  }}
                >
                  {cityInitial(trip.cityName)}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* 第一行：标题 + 状态 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <Typography.Text
                      strong
                      style={{
                        fontSize: 14.5,
                        color: 'var(--mark-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {trip.title}
                    </Typography.Text>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11.5,
                        color: 'var(--mark-ink-dim)',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: status.dot,
                          flexShrink: 0,
                        }}
                      />
                      {status.label}
                    </span>
                  </div>

                  {/* 第二行：信息小字标 */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 5,
                      marginTop: 4,
                    }}
                  >
                    <span className="bookmark-tag" data-testid="trip-pill">
                      {trip.cityName}
                    </span>
                    <span className="bookmark-tag" data-testid="trip-pill">
                      {trip.startDate.slice(0, 10)} 出发
                    </span>
                    <span className="bookmark-tag" data-testid="trip-pill">
                      {trip.days} 天
                    </span>
                    <span className="bookmark-tag" data-testid="trip-pill">
                      {trip.travelers} 人
                    </span>
                    <span className="bookmark-tag" data-testid="trip-pill">
                      {trip.stayResolved ? (trip.stayName ?? '已选定住宿') : '住宿待定'}
                    </span>
                  </div>
                </div>

                {/* stopPropagation：删除是危险动作，不能被书签整体点击带着跳详情页 */}
                <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                  <Popconfirm
                    title="确定删除这个行程吗？"
                    description="删除后无法恢复，行程中的打卡记录也会一并清除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void handleDelete(trip.id)}
                  >
                    <Button
                      size="small"
                      type="text"
                      style={{ color: 'var(--mark-ink-dim)', fontSize: 12 }}
                    >
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            )
          })}
        </PaperSheet>
      )}
    </div>
  )
}
