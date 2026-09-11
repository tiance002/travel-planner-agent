// 我的行程页。
// P1 阶段只做列表展示，用来验证「登录后能拿到属于自己」的数据。

import { App, Button, Card, Empty, Popconfirm, Skeleton, Space, Tag, Typography } from 'antd'
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

// 行程状态对应的中文说明与颜色
const STATUS_TEXT: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  generating: { label: '生成中', color: 'processing' },
  ready: { label: '已完成', color: 'success' },
  failed: { label: '生成失败', color: 'error' },
}

export default function TripList() {
  const { message } = App.useApp()
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
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Space
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}
        align="center"
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          我的行程
        </Typography.Title>
        <Button type="primary" onClick={() => navigate('/trips/new')}>
          新建行程
        </Button>
      </Space>

      {loading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : trips.length === 0 ? (
        <Card>
          <Empty description="还没有行程">
            <Button type="primary" onClick={() => navigate('/trips/new')}>
              创建第一个行程
            </Button>
          </Empty>
        </Card>
      ) : (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          {trips.map((trip) => {
            const status = STATUS_TEXT[trip.status] ?? STATUS_TEXT.draft
            return (
              <Card
                key={trip.id}
                hoverable
                data-testid="trip-card"
                onClick={() => navigate(`/trips/${trip.id}`)}
              >
                <Space
                  style={{ width: '100%', justifyContent: 'space-between' }}
                  align="start"
                >
                  <div>
                    <Space size={8} align="center">
                      <Typography.Text strong style={{ fontSize: 16 }}>
                        {trip.title}
                      </Typography.Text>
                      <Tag color={status.color}>{status.label}</Tag>
                    </Space>
                    <div style={{ marginTop: 8 }}>
                      <Typography.Text type="secondary">
                        {trip.cityName} · {trip.startDate.slice(0, 10)} 出发 · {trip.days} 天 ·{' '}
                        {trip.travelers} 人
                      </Typography.Text>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <Typography.Text type="secondary">
                        {trip.stayResolved
                          ? `住宿：${trip.stayName ?? '已选定'}`
                          : '住宿：未确定'}
                      </Typography.Text>
                    </div>
                  </div>

                  {/* stopPropagation：删除是危险动作，不能被卡片整体点击带着跳详情页 */}
                  <Space onClick={(e) => e.stopPropagation()}>
                    <Button size="small" type="link" onClick={() => navigate(`/trips/${trip.id}`)}>
                      查看详情
                    </Button>
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
                  </Space>
                </Space>
              </Card>
            )
          })}
        </Space>
      )}
    </div>
  )
}
