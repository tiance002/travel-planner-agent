import { App, Button, Card, Empty, Popconfirm, Skeleton, Space, Typography } from 'antd'
import { PlusOutlined, RightOutlined, CompassOutlined, DeleteOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, extractError } from '../api/client'
import GenerationStatusTag from '../components/GenerationStatusTag'
import type { GenerationRunPhase } from '../api/trips'

interface TripSummary {
  id: string
  title: string
  cityName: string
  startDate: string
  days: number
  travelers: number
  status: string
  genRunPhase: GenerationRunPhase
  stayResolved: boolean
  stayName: string | null
}

export default function TripList() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadTrips() {
    setLoading(true); setError('')
    try { setTrips((await api.get<{ trips: TripSummary[] }>('/trips')).data.trips) }
    catch (err) { setError(extractError(err, '行程列表加载失败')) }
    finally { setLoading(false) }
  }
  useEffect(() => { void loadTrips() }, [])

  async function handleDelete(id: string) {
    try { await api.delete(`/trips/${id}`); setTrips(items => items.filter(item => item.id !== id)); message.success('行程已删除') }
    catch (err) { message.error(extractError(err, '删除失败')) }
  }

  return (
    <div className="page-shell">
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }} align="center">
        <Space size={10}><CompassOutlined style={{ color: 'var(--travel-forest)', fontSize: 20 }} /><Typography.Title level={2} style={{ margin: 0 }}>我的行程</Typography.Title></Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/trips/new')}>新建行程</Button>
      </Space>
      {loading ? <Skeleton active paragraph={{ rows: 8 }} /> : error ? (
        <Card><Typography.Paragraph type="danger">{error}</Typography.Paragraph><Button onClick={() => void loadTrips()}>重新加载</Button></Card>
      ) : trips.length === 0 ? (
        <Card><Empty description="还没有行程"><Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/trips/new')}>创建第一个行程</Button></Empty></Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {trips.map(trip => {
            return <Card key={trip.id} className="trip-card" data-testid="trip-card">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                  <div style={{ minWidth: 0 }}><Typography.Title level={4} style={{ margin: 0, overflowWrap: 'anywhere' }}>{trip.title}</Typography.Title><Typography.Text type="secondary">{trip.cityName}</Typography.Text></div>
                  <GenerationStatusTag status={trip.status} phase={trip.genRunPhase} />
                </Space>
                <Space wrap split={<Typography.Text type="secondary">·</Typography.Text>}><Typography.Text>{trip.startDate.slice(0, 10)} 出发</Typography.Text><Typography.Text>{trip.days} 天</Typography.Text><Typography.Text>{trip.travelers} 人</Typography.Text></Space>
                <Typography.Text type="secondary">住宿：{trip.stayResolved ? (trip.stayName ?? '已选定住宿') : '待确定'}</Typography.Text>
                <div className="trip-card-actions">
                  <Button type="primary" icon={<RightOutlined />} onClick={() => navigate(`/trips/${trip.id}`)}>查看行程</Button>
                  <Popconfirm title="确定删除这个行程吗？" description="删除后无法恢复，打卡记录也会一并删除。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void handleDelete(trip.id)}>
                    <Button icon={<DeleteOutlined />} danger>删除</Button>
                  </Popconfirm>
                </div>
              </Space>
            </Card>
          })}
        </Space>
      )}
    </div>
  )
}
