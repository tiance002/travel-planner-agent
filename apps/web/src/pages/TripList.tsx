// 我的行程页。
// P1 阶段只做列表展示，用来验证「登录后能拿到属于自己」的数据。

import { App, Button, Card, Empty, Skeleton, Space, Tag, Typography } from 'antd'
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {trips.map((trip) => {
            const status = STATUS_TEXT[trip.status] ?? STATUS_TEXT.draft
            return (
              <Card key={trip.id} hoverable>
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
                </Space>
              </Card>
            )
          })}
        </Space>
      )}
    </div>
  )
}
