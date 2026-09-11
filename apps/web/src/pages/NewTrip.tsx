// 新建行程页 —— 四步向导。
//
// 向导流程：
//   1. 基本信息：目的地（需解析成行政区划编码）、出发日期、天数、人数、偏好、预算、额外需求
//   2. 选定住宿：在页面内嵌的高德地图上搜索并点选酒店，作为每日行程的锚点；
//      也可以选「还没定」，此时交给 AI 推荐交通便利的中心区域
//   3. 生成行程：触发 AI 排布每日景点与餐厅，页面轮询显示进度
//   4. 查看结果：时间轴与地图联动、到点打卡（下一阶段开放）
//
// 为什么一定要先解析目的地：高德做 POI 检索和天气查询用的都是 6 位行政区划编码（adcode），
// 只拿一个城市名是查不准的。解析动作同时把城市中心坐标取回来，用于地图初始视野。

import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  POI_TYPE,
  geocode,
  getWeather,
  searchPoiText,
  type GeocodeResult,
  type Poi,
  type WeatherResult,
} from '../api/amap'
import { api, extractError } from '../api/client'
import AmapMap, { type MapMarker } from '../components/AmapMap'

/** 旅游偏好选项。定成枚举而不是自由文本，AI 的选点倾向才可控 */
const PREFERENCE_OPTIONS = ['美食', '自然风光', '历史人文', '亲子', '摄影', '户外徒步', '购物', '夜生活']

/** 额外需求选项 */
const EXTRA_NEED_OPTIONS = ['带老人', '带小孩', '无障碍', '素食', '宠物友好', '避开人流', '自驾']

/** antd 的下拉框要求选项是 { label, value } 结构，这里统一转换一次 */
const toSelectOptions = (values: string[]) => values.map((value) => ({ label: value, value }))

// 列表容器样式。用原生 div 而不是 antd 的 List 组件：
// antd 6.6 已把 List 标记为废弃（官方建议改用虚拟列表 Listy），
// 而我们这里的条目数很少，自己写结构更简单、也不承担组件废弃的风险。
const listBoxStyle: React.CSSProperties = {
  border: '1px solid #f0f0f0',
  borderRadius: 8,
  maxHeight: 396,
  overflowY: 'auto',
}

const listHintStyle: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  color: '#999',
}

const MAX_DAYS = 15

interface StepOneForm {
  title?: string
  cityName: string
  startDate: Dayjs
  days: number
  travelers: number
  preferences: string[]
  extraNeeds: string[]
  budgetAmount?: number | null
  budgetScope: 'per_person' | 'total'
}

/** 住宿选择方式：自己选，或交给 AI 推荐中心区域 */
type StayMode = 'manual' | 'undecided'

export default function NewTrip() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [form] = Form.useForm<StepOneForm>()

  const [current, setCurrent] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [resolvedCity, setResolvedCity] = useState<GeocodeResult | null>(null)
  const [stepOne, setStepOne] = useState<StepOneForm | null>(null)

  const [stayMode, setStayMode] = useState<StayMode>('manual')
  const [hotels, setHotels] = useState<Poi[]>([])
  const [hotelsLoading, setHotelsLoading] = useState(false)
  const [selectedHotel, setSelectedHotel] = useState<Poi | null>(null)

  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>()
  const [mapZoom, setMapZoom] = useState(12)

  const [saving, setSaving] = useState(false)
  const [savedTripId, setSavedTripId] = useState<string | null>(null)
  const [weather, setWeather] = useState<WeatherResult | null>(null)

  // 生成相关状态。真正的排程在服务端后台跑，这里只负责轮询与展示
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<'draft' | 'generating' | 'ready' | 'failed'>('draft')
  const [genProgress, setGenProgress] = useState('')
  const [genError, setGenError] = useState('')
  const pollTimer = useRef<number | null>(null)

  // 用户改了城市名，之前解析的结果就作废了，必须重新解析
  function handleValuesChange(changed: Partial<StepOneForm>) {
    if ('cityName' in changed) setResolvedCity(null)
  }

  // --- 第一步：解析目的地 ---------------------------------------------------

  async function resolveCity() {
    const raw = form.getFieldValue('cityName')?.trim()
    if (!raw) {
      message.warning('请先填写目的地城市')
      return
    }

    setResolving(true)
    try {
      const result = await geocode(raw, raw)
      setResolvedCity(result)
      message.success(`已定位到 ${result.formattedAddress}`)
    } catch (err) {
      message.error(extractError(err, '未能解析该城市，请换一个更具体的名称'))
    } finally {
      setResolving(false)
    }
  }

  // --- 第二步：搜索与选择住宿 -----------------------------------------------

  async function searchHotels(keyword?: string) {
    const city = stepOne?.cityName || resolvedCity?.city
    if (!city) return

    setHotelsLoading(true)
    try {
      const list = await searchPoiText({
        keywords: keyword?.trim() || '酒店',
        region: city,
        types: POI_TYPE.hotel,
        pageSize: 10,
      })
      setHotels(list)
      if (list.length === 0) message.info('没有搜到结果，换个关键词试试')
    } catch (err) {
      message.error(extractError(err, '酒店搜索失败'))
    } finally {
      setHotelsLoading(false)
    }
  }

  function pickHotel(poi: Poi) {
    setSelectedHotel(poi)
    // 选中后把地图聚焦到这家酒店，方便用户看清楚它在城市的哪个位置
    setMapCenter([poi.lng, poi.lat])
    setMapZoom(15)
  }

  // --- 步骤推进 -------------------------------------------------------------

  async function goToStayStep() {
    let values: StepOneForm
    try {
      values = await form.validateFields()
    } catch {
      // 表单会自己把错误显示在字段下方，这里不需要额外提示
      return
    }

    if (!resolvedCity) {
      message.warning('请先点击「解析」确认目的地位置')
      return
    }

    setStepOne(values)
    setMapCenter([resolvedCity.lng, resolvedCity.lat])
    setMapZoom(12)
    setCurrent(1)
    // 进入第二步就先把该城市的酒店拉出来，省掉用户一次点击
    void searchHotels('酒店')
  }

  // 保存草稿：先建行程，再写入住宿锚点。
  // 分两步是因为「还没定住宿」时住宿字段允许为空，没必要为了原子性引入事务复杂度。
  async function saveDraft() {
    if (!stepOne || !resolvedCity) return

    if (stayMode === 'manual' && !selectedHotel) {
      message.warning('请在地图上选择一家住宿，或切换到「还没定，让 AI 推荐」')
      return
    }

    setSaving(true)
    try {
      const { data } = await api.post<{ trip: { id: string } }>('/trips', {
        title: stepOne.title?.trim() || undefined,
        cityName: resolvedCity.city || stepOne.cityName,
        cityAdcode: resolvedCity.adcode,
        startDate: stepOne.startDate.toISOString(),
        days: stepOne.days,
        travelers: stepOne.travelers,
        preferences: stepOne.preferences ?? [],
        extraNeeds: stepOne.extraNeeds ?? [],
        budgetAmount: stepOne.budgetAmount ?? null,
        budgetScope: stepOne.budgetScope,
      })

      const tripId = data.trip.id

      await api.patch(`/trips/${tripId}/stay`, {
        stayResolved: stayMode === 'manual',
        stayPoiId: selectedHotel?.poiId ?? null,
        stayName: selectedHotel?.name ?? null,
        stayLng: selectedHotel?.lng ?? null,
        stayLat: selectedHotel?.lat ?? null,
      })

      setSavedTripId(tripId)
      setCurrent(2)

      // 天气不是主流程，取不到也不影响行程保存
      try {
        setWeather(await getWeather(resolvedCity.adcode))
      } catch {
        setWeather(null)
      }
    } catch (err) {
      message.error(extractError(err, '保存行程失败'))
    } finally {
      setSaving(false)
    }
  }

  // --- 第三步：触发 AI 生成并轮询进度 ---------------------------------------

  /**
   * 轮询生成状态。
   *
   * 为什么不用「一次请求等到生成完」：模型要跑十几轮工具调用，短则二十秒、
   * 长则一两分钟。让一个请求挂那么久，中间任何一环超时都会让用户白等。
   * 改成「服务端在后台跑 + 前端每隔几秒问一次」，体验和稳定性都更好。
   */
  async function pollGeneration(tripId: string) {
    try {
      const { data } = await api.get<{
        trip: { status: string; genProgress: string | null; genError: string | null }
      }>(`/trips/${tripId}`)

      const trip = data.trip
      setGenStatus(trip.status as 'draft' | 'generating' | 'ready' | 'failed')
      setGenProgress(trip.genProgress ?? '')
      setGenError(trip.genError ?? '')

      if (trip.status === 'generating') {
        pollTimer.current = window.setTimeout(() => void pollGeneration(tripId), 2500)
      } else {
        setGenerating(false)
      }
    } catch (err) {
      setGenError(extractError(err, '读取生成状态失败，请刷新页面查看'))
      setGenerating(false)
    }
  }

  async function startGenerate() {
    if (!savedTripId) return

    setGenerating(true)
    setGenError('')
    setGenProgress('正在准备')
    setGenStatus('generating')

    try {
      await api.post(`/trips/${savedTripId}/generate`)
      void pollGeneration(savedTripId)
    } catch (err) {
      setGenError(extractError(err, '触发失败，请稍后重试'))
      setGenerating(false)
      setGenStatus('failed')
    }
  }

  // 离开页面时清掉定时器，避免在后台空转
  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    }
  }, [])

  // --- 地图标记 -------------------------------------------------------------
  // 用 useMemo 固定引用：否则每次渲染都会生成新数组，导致地图反复重绘标记
  const stayMarkers = useMemo<MapMarker[]>(() => {
    if (stayMode === 'undecided') {
      // 还没定住宿时，只标出城市中心，让用户对位置有个概念
      return resolvedCity
        ? [{ id: '__city__', lng: resolvedCity.lng, lat: resolvedCity.lat, label: resolvedCity.city, active: true, shape: 'dot' }]
        : []
    }

    return hotels.map((hotel) => ({
      id: hotel.poiId,
      lng: hotel.lng,
      lat: hotel.lat,
      shape: 'pin',
      active: selectedHotel?.poiId === hotel.poiId,
    }))
  }, [stayMode, hotels, selectedHotel, resolvedCity])

  // 行程日期列表与对应的天气预报。高德只有约 4 天预报，超出的日期会显示「暂无预报」
  const tripDates = useMemo(() => {
    if (!stepOne) return []
    return Array.from({ length: stepOne.days }, (_, index) =>
      stepOne.startDate.add(index, 'day').format('YYYY-MM-DD'),
    )
  }, [stepOne])

  const weatherByDate = useMemo(
    () => new Map((weather?.casts ?? []).map((cast) => [cast.date, cast])),
    [weather],
  )

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        新建行程
      </Typography.Title>

      <Card style={{ marginBottom: 16 }}>
        <Steps
          current={current}
          items={[
            { title: '基本信息', content: '目的地、日期、偏好与预算' },
            { title: '选定住宿', content: '内嵌地图选点，或交给 AI 推荐中心区域' },
            { title: '生成行程', content: 'AI 依据高德真实数据排布每日景点与餐厅' },
            { title: '查看结果', content: '时间轴与地图联动、到点打卡（下一阶段开放）' },
          ]}
        />
      </Card>

      {/* ---------------- 第一步：基本信息 ---------------- */}
      {current === 0 && (
        <Card>
          <Form
            form={form}
            layout="vertical"
            onValuesChange={handleValuesChange}
            initialValues={{
              cityName: '',
              startDate: dayjs().add(7, 'day'),
              days: 3,
              travelers: 2,
              preferences: [],
              extraNeeds: [],
              budgetAmount: null,
              budgetScope: 'per_person',
            }}
          >
            <Form.Item name="title" label="行程名称（可选）">
              <Input placeholder="留空则自动生成，例如「杭州 3 日行程」" maxLength={60} />
            </Form.Item>

            <Form.Item
              name="cityName"
              label="目的地城市"
              rules={[{ required: true, message: '请填写目的地城市' }]}
              extra={
                resolvedCity ? (
                  <Typography.Text type="success">
                    已解析：{resolvedCity.formattedAddress}
                    {resolvedCity.adcode ? `（行政区划编码 ${resolvedCity.adcode}）` : ''}
                  </Typography.Text>
                ) : (
                  '第一版仅支持中国境内城市。填写后请点击「解析」，应用需要把城市名转成行政区划编码才能查地点和天气'
                )
              }
            >
              <Input.Search
                placeholder="如：杭州"
                enterButton="解析"
                loading={resolving}
                onSearch={() => void resolveCity()}
              />
            </Form.Item>

            <Row gutter={16}>
              <Col xs={24} sm={8}>
                <Form.Item
                  name="startDate"
                  label="出发日期"
                  rules={[{ required: true, message: '请选择出发日期' }]}
                >
                  <DatePicker
                    style={{ width: '100%' }}
                    disabledDate={(date) => date.isBefore(dayjs().startOf('day'))}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} sm={8}>
                <Form.Item
                  name="days"
                  label={`行程天数（天）`}
                  rules={[{ required: true, message: '请填写天数' }]}
                  extra={`1-${MAX_DAYS} 天`}
                >
                  <InputNumber min={1} max={MAX_DAYS} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={8}>
                <Form.Item
                  name="travelers"
                  label="团队人数（人）"
                  rules={[{ required: true, message: '请填写人数' }]}
                  extra="用于人均预算分摊与餐厅容量建议"
                >
                  <InputNumber min={1} max={50} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="preferences"
              label="旅游偏好"
              extra="可多选，直接决定 AI 选点的倾向"
            >
              <Select options={toSelectOptions(PREFERENCE_OPTIONS)} mode="multiple" placeholder="选择偏好，可不选" />
            </Form.Item>

            <Row gutter={16}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="budgetAmount"
                  label="预算范围（元，可选）"
                  extra="不填表示不限。口径不含往返大交通与住宿，用于推荐餐厅档次"
                >
                  <InputNumber min={0} style={{ width: '100%' }} placeholder="例如 3000" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="budgetScope" label="预算口径">
                  <Radio.Group>
                    <Radio.Button value="per_person">人均</Radio.Button>
                    <Radio.Button value="total">总预算</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="extraNeeds"
              label="额外需求（可选）"
              extra="会作为硬约束交给 AI，例如「带老人」会减少步行强度"
            >
              <Select options={toSelectOptions(EXTRA_NEED_OPTIONS)} mode="multiple" placeholder="选择额外需求，可不选" />
            </Form.Item>
          </Form>

          <Divider style={{ margin: '8px 0 16px' }} />

          <Space>
            <Button type="primary" onClick={() => void goToStayStep()}>
              下一步：选定住宿
            </Button>
            <Button onClick={() => navigate('/trips')}>取消</Button>
          </Space>
        </Card>
      )}

      {/* ---------------- 第二步：选定住宿 ---------------- */}
      {current === 1 && (
        <Card
          title={`在 ${resolvedCity?.city ?? ''} 选择住宿锚点`}
          extra={
            <Radio.Group value={stayMode} onChange={(e) => setStayMode(e.target.value as StayMode)}>
              <Radio.Button value="manual">我来选</Radio.Button>
              <Radio.Button value="undecided">还没定</Radio.Button>
            </Radio.Group>
          }
        >
          <Row gutter={16}>
            <Col xs={24} lg={10}>
              {stayMode === 'manual' ? (
                <>
                  <Input.Search
                    placeholder="搜索酒店或民宿名称"
                    enterButton="搜索"
                    loading={hotelsLoading}
                    onSearch={(value) => void searchHotels(value)}
                    style={{ marginBottom: 12 }}
                  />

                  {selectedHotel && (
                    <Alert
                      type="success"
                      showIcon
                      style={{ marginBottom: 12 }}
                      title={selectedHotel.name}
                      description={
                        <span>
                          {selectedHotel.address || '地址未知'}
                          {selectedHotel.rating !== null && ` · 评分 ${selectedHotel.rating}`}
                          {selectedHotel.cost !== null && ` · 人均 ¥${selectedHotel.cost}`}
                          <Button
                            type="link"
                            size="small"
                            style={{ paddingLeft: 0 }}
                            onClick={() => {
                              setSelectedHotel(null)
                              setMapZoom(12)
                            }}
                          >
                            重新选择
                          </Button>
                        </span>
                      }
                    />
                  )}

                  <div style={listBoxStyle}>
                    {hotelsLoading && (
                      <div style={listHintStyle}>
                        <Spin size="small" />
                        <span style={{ marginLeft: 8 }}>正在搜索…</span>
                      </div>
                    )}

                    {!hotelsLoading && hotels.length === 0 && (
                      <div style={listHintStyle}>
                        还没有搜索结果，试着搜索「酒店」或具体名称
                      </div>
                    )}

                    {!hotelsLoading &&
                      hotels.map((hotel) => {
                        const active = selectedHotel?.poiId === hotel.poiId
                        return (
                          <div
                            key={hotel.poiId}
                            data-testid="hotel-item"
                            onClick={() => pickHotel(hotel)}
                            style={{
                              padding: '10px 12px',
                              cursor: 'pointer',
                              borderBottom: '1px solid #f5f5f5',
                              background: active ? '#e6f4ff' : undefined,
                            }}
                          >
                            <Space size={6} wrap>
                              <Typography.Text strong>{hotel.name}</Typography.Text>
                              {hotel.rating !== null && <Tag color="blue">评分 {hotel.rating}</Tag>}
                            </Space>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {hotel.address || '地址未知'}
                                {hotel.cost !== null && ` · 人均 ¥${hotel.cost}`}
                              </Typography.Text>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                </>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="住宿留待后续决定"
                  description={
                    <span>
                      你还没有确定住哪里。生成行程时，AI 会先推荐 2–3 个交通便利的中心区域作为锚点，
                      待你订好酒店后可以重新生成，把动线收得更准。
                      <br />
                      <br />
                      建议：如果已经心有所属的区域，用「我来选」在地图上直接点选，行程会贴合得多。
                    </span>
                  }
                />
              )}
            </Col>

            <Col xs={24} lg={14}>
              <AmapMap
                center={mapCenter}
                zoom={mapZoom}
                markers={stayMarkers}
                onMarkerClick={(id) => {
                  const hotel = hotels.find((item) => item.poiId === id)
                  if (hotel) pickHotel(hotel)
                }}
                height={520}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                地图上标出的是高德返回的真实地点，坐标直接来自高德开放平台的数据。
              </Typography.Text>
            </Col>
          </Row>

          <Divider style={{ margin: '16px 0' }} />

          <Space>
            <Button onClick={() => setCurrent(0)}>上一步</Button>
            <Button type="primary" loading={saving} onClick={() => void saveDraft()}>
              保存并继续
            </Button>
          </Space>
        </Card>
      )}

      {/* ---------------- 第三步：生成行程（待开放） ---------------- */}
      {current === 2 && stepOne && (
        <Card
          title="生成行程"
          extra={
            <span data-testid="gen-status">
              {genStatus === 'ready' ? (
                <Tag color="green">已生成</Tag>
              ) : genStatus === 'generating' ? (
                <Tag color="processing">生成中</Tag>
              ) : genStatus === 'failed' ? (
                <Tag color="red">生成失败</Tag>
              ) : (
                <Tag>草稿</Tag>
              )}
            </span>
          }
        >
          {genStatus === 'ready' ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
              title="行程已生成完成"
              description="每日的景点、餐厅与通勤安排都已写入这条行程，可以到「我的行程」里查看。逐日时间轴与到点打卡将在下一阶段开放。"
            />
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              title="点击下方按钮开始排程"
              description={
                <span>
                  AI 会先通过高德查询你目的地的景点、餐厅与天气，再按这些规则排布：以住宿为锚点、
                  每天游览类地点不超过 3 个、餐厅插在相邻两个景点之间、相邻两点实际通勤超过 40 分钟就换点、
                  有雨时优先室内场所。
                  <br />
                  整个过程大约二十秒到一分钟。期间可以离开本页，生成会在服务端继续。
                </span>
              }
            />
          )}

          <Space style={{ marginBottom: 16 }} wrap>
            <Button
              type="primary"
              data-testid="generate-btn"
              loading={generating}
              onClick={startGenerate}
            >
              {genStatus === 'ready' ? '重新生成' : '开始生成行程'}
            </Button>
            {generating && (
              <Typography.Text type="secondary">生成在服务端进行，请勿关闭当前账号的会话</Typography.Text>
            )}
          </Space>

          {genStatus === 'generating' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              data-testid="gen-progress"
              title={`AI 正在排程：${genProgress || '准备中'}`}
              description="正在反复调用高德接口查询景点、餐厅与真实路线，请稍候。"
            />
          )}

          {genError && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              data-testid="gen-error"
              title="生成失败"
              description={genError}
            />
          )}

          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="行程编号">{savedTripId ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="状态">
              {genStatus === 'ready' ? (
                <Tag color="green">已生成</Tag>
              ) : genStatus === 'generating' ? (
                <Tag color="processing">生成中</Tag>
              ) : genStatus === 'failed' ? (
                <Tag color="red">生成失败</Tag>
              ) : (
                <Tag>草稿</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="目的地">
              {resolvedCity?.city}（{resolvedCity?.adcode}）
            </Descriptions.Item>
            <Descriptions.Item label="出发日期">
              {stepOne.startDate.format('YYYY-MM-DD')}
            </Descriptions.Item>
            <Descriptions.Item label="天数 / 人数">
              {stepOne.days} 天 · {stepOne.travelers} 人
            </Descriptions.Item>
            <Descriptions.Item label="预算">
              {stepOne.budgetAmount
                ? `¥${stepOne.budgetAmount}（${stepOne.budgetScope === 'per_person' ? '人均' : '总预算'}）`
                : '不限'}
            </Descriptions.Item>
            <Descriptions.Item label="住宿锚点" span={2}>
              {stayMode === 'manual' && selectedHotel
                ? `${selectedHotel.name}（${selectedHotel.lng}, ${selectedHotel.lat}）`
                : '未确定，将由 AI 推荐交通便利的中心区域'}
            </Descriptions.Item>
            <Descriptions.Item label="偏好" span={2}>
              {stepOne.preferences?.length ? stepOne.preferences.join('、') : '未指定'}
            </Descriptions.Item>
            <Descriptions.Item label="额外需求" span={2}>
              {stepOne.extraNeeds?.length ? stepOne.extraNeeds.join('、') : '未指定'}
            </Descriptions.Item>
          </Descriptions>

          <Divider titlePlacement="start" plain>
            行程期间天气
          </Divider>
          <div style={{ ...listBoxStyle, maxHeight: 'none' }}>
            {tripDates.map((date, index) => {
              const cast = weatherByDate.get(date)
              return (
                <div
                  key={date}
                  data-testid="weather-item"
                  style={{ padding: '8px 12px', borderBottom: '1px solid #f5f5f5' }}
                >
                  <Space wrap>
                    <Tag color="geekblue">第 {index + 1} 天</Tag>
                    <span>{date}</span>
                    {cast ? (
                      <Typography.Text>
                        {cast.dayWeather} {cast.dayTemp}°C / 夜间 {cast.nightWeather}{' '}
                        {cast.nightTemp}°C · {cast.dayWind}风 {cast.dayPower}级
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">
                        超出预报范围（高德天气预报仅覆盖未来约 4 天）
                      </Typography.Text>
                    )}
                  </Space>
                </div>
              )
            })}
          </div>

          <Divider style={{ margin: '16px 0' }} />

          <Space>
            <Button type="primary" onClick={() => navigate('/trips')}>
              前往我的行程
            </Button>
            <Button onClick={() => setCurrent(0)}>返回修改</Button>
          </Space>
        </Card>
      )}
    </div>
  )
}
