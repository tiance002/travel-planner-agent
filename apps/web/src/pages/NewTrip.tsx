// 新建行程页 —— 四步向导。
//
// 向导流程：
//   1. 基本信息：目的地（需解析成行政区划编码）、出发日期、天数、人数、偏好、预算、额外需求
//   2. 选定住宿：在页面内嵌的高德地图上搜索并点选酒店，作为每日行程的锚点；
//      也可以选「还没定」，此时交给 AI 推荐交通便利的中心区域
//   3. 生成行程：按天触发 AI 排布景点与餐厅，页面轮询显示逐天进度；
//      某一天失败不影响已经排好的天，可以从断点继续
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
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  theme as antdTheme,
  type GlobalToken,
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
import { FormSection } from '../components/paper'

/** 旅游偏好选项。定成枚举而不是自由文本，AI 的选点倾向才可控。
 *  下拉框用 tags 模式：既可以从这里选，也可以输入列表里没有的自定义偏好 */
const PREFERENCE_OPTIONS = ['美食', '自然风光', '历史人文', '亲子', '摄影', '户外徒步', '购物', '夜生活', '地标打卡', '夜市小吃']

/** 额外需求选项。同样支持自定义输入 */
const EXTRA_NEED_OPTIONS = [
  '带老人',
  '带小孩',
  '无障碍',
  '素食',
  '宠物友好',
  '避开人流',
  '自驾',
  // 以下四项是行程体裁的开关。文案要写成模型和规则都能识别的说法，
  // 后端的 parseDayTypeBan 靠关键词判断（「不」+「爬山/主题乐园/夜爬」）。
  // 用户如果自己手打同义句（例如「这次别安排爬山」）也能被识别。
  '不含爬山等高强度行程',
  '不含主题乐园整天行程',
  '不安排夜爬看日出',
  '行程节奏轻松一些',
]

/** antd 的下拉框要求选项是 { label, value } 结构，这里统一转换一次 */
const toSelectOptions = (values: string[]) => values.map((value) => ({ label: value, value }))

// 列表容器样式。用原生 div 而不是 antd 的 List 组件：
// antd 6.6 已把 List 标记为废弃（官方建议改用虚拟列表 Listy），
// 而我们这里的条目数很少，自己写结构更简单、也不承担组件废弃的风险。
//
// 注意这两种样式现在是**函数**：颜色必须取自当前主题的 token，
// 早先写成模块级常量会把浅色定死，黑夜模式下就是一块亮框。
const listBoxStyle = (token: GlobalToken): React.CSSProperties => ({
  border: `1px solid ${token.colorBorderSecondary}`,
  borderRadius: token.borderRadius,
  maxHeight: 396,
  overflowY: 'auto',
  background: token.colorFillQuaternary,
})

const listHintStyle = (token: GlobalToken): React.CSSProperties => ({
  padding: 24,
  textAlign: 'center',
  color: token.colorTextTertiary,
})

const MAX_DAYS = 15

/**
 * 行程概览里的一格信息。
 *
 * 为什么不用 Descriptions：带边框的 Descriptions 是一张表格，
 * 在旅游产品里显得像后台报表。这里改成「字段名在上、内容在下」的小块，
 * 底色用主题的淡填充，视觉上和整页的卡片语言更一致。
 */
function InfoBlock({
  label,
  children,
  token,
  span = 1,
}: {
  label: string
  children: React.ReactNode
  token: GlobalToken
  /** 占几列。跨列用在「偏好」「额外需求」这种内容可能很长的字段上 */
  span?: number
}) {
  return (
    <div
      data-testid="info-block"
      style={{
        gridColumn: span > 1 ? `span ${span}` : undefined,
        padding: '10px 12px',
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {label}
        </Typography.Text>
      </div>
      {children}
    </div>
  )
}

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
  const { token } = antdTheme.useToken()
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
  /** 已完成到第几天。服务端按天生成，这个数字让进度看得见 */
  const [genDayIndex, setGenDayIndex] = useState<number | null>(null)
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
        trip: {
          status: string
          genProgress: string | null
          genError: string | null
          genDayIndex: number | null
        }
      }>(`/trips/${tripId}`)

      const trip = data.trip
      setGenStatus(trip.status as 'draft' | 'generating' | 'ready' | 'failed')
      setGenProgress(trip.genProgress ?? '')
      setGenError(trip.genError ?? '')
      setGenDayIndex(trip.genDayIndex ?? null)

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

  /**
   * 触发生成。
   *
   * mode 有两种：continue 保留已经排好的天，从第一个空缺的天接着排；
   * restart 清空已有安排从第 1 天重来。服务端是按天生成的，
   * 所以中途失败时用户可以先「继续」，不必把已经排好的几天一起废掉。
   */
  async function startGenerate(mode: 'continue' | 'restart') {
    if (!savedTripId) return

    setGenerating(true)
    setGenError('')
    setGenProgress(mode === 'restart' ? '正在准备（重新生成）' : '正在准备')
    setGenStatus('generating')
    if (mode === 'restart') setGenDayIndex(null)

    try {
      await api.post(`/trips/${savedTripId}/generate`, { mode })
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

  // 逐天生成的进度。服务端把「已完成到第几天」写在 genDayIndex 上
  const totalDays = stepOne?.days ?? 0
  const doneDays = genDayIndex ?? 0
  // 失败但已经排好了部分天数：这时值得给一个「继续」而不是逼着他从头重来
  const canContinue = genStatus === 'failed' && doneDays > 0 && doneDays < totalDays

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
        <Card
          // 第一步字段多，纵向堆起来会超过一屏。这里把「表单」装进一个限高、
          // 内部滚动的容器，把「下一步 / 取消」钉在滚动区外面：无论字段多长，
          // 都不会把整页撑破，外层步骤条、顶栏、侧栏稳如泰山，滚动条被关在卡片里。
          style={{ display: 'flex', flexDirection: 'column' }}
          styles={{ body: { display: 'flex', flexDirection: 'column', gap: 16 } }}
        >
          <div
            style={{
              maxHeight: 'calc(100vh - 320px)',
              overflowY: 'auto',
              paddingRight: 16,
              scrollbarGutter: 'stable',
            }}
          >
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
            <FormSection hint="先确定去哪、去几天">行程概况</FormSection>

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

            <FormSection hint="决定 AI 会推荐什么类型的地方">偏好与预算</FormSection>

            <Form.Item
              name="preferences"
              label="旅游偏好"
              extra="可多选，也可以直接输入列表之外的偏好（回车确认）"
            >
              <Select
                options={toSelectOptions(PREFERENCE_OPTIONS)}
                mode="tags"
                placeholder="选择或输入偏好，可不选"
              />
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

            <FormSection hint="会作为硬约束交给 AI">额外需求</FormSection>

            <Form.Item
              name="extraNeeds"
              label="额外需求（可选）"
              extra="会作为硬约束交给 AI，例如「带老人」会减少步行强度；同样支持自行输入"
            >
              <Select
                options={toSelectOptions(EXTRA_NEED_OPTIONS)}
                mode="tags"
                placeholder="选择或输入额外需求，可不选"
              />
            </Form.Item>
          </Form>
          </div>

          <Divider style={{ margin: 0 }} />

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

                  <div style={listBoxStyle(token)}>
                    {hotelsLoading && (
                      <div style={listHintStyle(token)}>
                        <Spin size="small" />
                        <span style={{ marginLeft: 8 }}>正在搜索…</span>
                      </div>
                    )}

                    {!hotelsLoading && hotels.length === 0 && (
                      <div style={listHintStyle(token)}>
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
                              borderRadius: token.borderRadius,
                              // 选中项用主色淡底 + 主色描边，比整行刷蓝更克制，也更适配双主题
                              border: `1px solid ${active ? token.colorPrimaryBorder : 'transparent'}`,
                              background: active ? token.colorPrimaryBg : undefined,
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
                  AI 会通过高德查询你目的地的景点、餐厅、天气与真实路线，再按这些规则排布：以住宿为锚点、
                  每天游览类地点不超过 3 个（主题乐园整天、爬山这类行程只排 1 个）、餐厅插在相邻两个景点之间、
                  相邻两点实际通勤超过 40 分钟就换点、有雨时优先室内场所。
                  <br />
                  <b>选点标准</b>：景点评分不低于 4 分，且营业时间要和安排的时段对得上
                  （不会把 17:00 就关门的地方排到晚上）。如果某天体力消耗特别大，
                  次日会自动排得轻松一些。生成后对某个地点不满意，可以在行程里点「换一个」，
                  在可行距离内替换同类地点。
                  <br />
                  <b>按天生成</b>：每次只排一天，排完立刻存下来，进度会在这里推进。
                  某一天失败也不必从头再来，已经排好的天都会保留。期间可以离开本页，生成在服务端继续。
                </span>
              }
            />
          )}

          <Space style={{ marginBottom: 16 }} wrap>
            {canContinue && (
              <Button
                type="primary"
                data-testid="generate-continue-btn"
                loading={generating}
                onClick={() => void startGenerate('continue')}
              >
                继续生成第 {doneDays + 1} 天
              </Button>
            )}
            <Button
              type={canContinue ? 'default' : 'primary'}
              data-testid="generate-btn"
              loading={generating}
              onClick={() =>
                void startGenerate(genStatus === 'ready' || doneDays > 0 ? 'restart' : 'continue')
              }
            >
              {genStatus === 'ready' ? '重新生成' : doneDays > 0 ? '从头重新生成' : '开始生成行程'}
            </Button>
            {generating && (
              <Typography.Text type="secondary">生成在服务端进行，请勿关闭当前账号的会话</Typography.Text>
            )}
          </Space>

          {(genStatus === 'generating' || doneDays > 0) && (
            <div data-testid="gen-progress" style={{ marginBottom: 16 }}>
              <Alert
                type={genStatus === 'generating' ? 'info' : 'warning'}
                showIcon
                title={
                  genStatus === 'generating'
                    ? `AI 正在排程：${genProgress || '准备中'}`
                    : `已排好 ${doneDays}/${totalDays} 天`
                }
                description={
                  genStatus === 'generating'
                    ? '正在调用高德接口查询景点、餐厅与真实路线，每排完一天就会立刻存下来。'
                    : '上面这些天已经保存在行程里了，可以接着把剩下的排完。'
                }
              />
              <Progress
                percent={totalDays > 0 ? Math.round((doneDays / totalDays) * 100) : 0}
                size="small"
                format={() => `${doneDays}/${totalDays} 天`}
                style={{ marginTop: 8 }}
              />
            </div>
          )}

          {genError && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              data-testid="gen-error"
              title="生成失败"
              description={
                <span>
                  {genError}
                  {doneDays > 0 && (
                    <>
                      <br />
                      已经排好的 {doneDays} 天不受影响，点「继续生成第 {doneDays + 1} 天」就能接着来。
                    </>
                  )}
                </span>
              }
            />
          )}

          {/* 行程概览。早先用的是 Descriptions 带边框表格，视觉上像一张数据报表，
              和旅游产品的气质不搭。改成「两列信息网格 + 胶囊标签」：
              每条信息是一个独立小块，字段名在上、内容在下，扫起来更轻松 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
              marginBottom: 16,
            }}
          >
            <InfoBlock label="行程编号" token={token}>
              <Typography.Text style={{ fontSize: 13 }} copyable={Boolean(savedTripId)}>
                {savedTripId ?? '-'}
              </Typography.Text>
            </InfoBlock>

            <InfoBlock label="状态" token={token}>
              {genStatus === 'ready' ? (
                <Tag color="green">已生成</Tag>
              ) : genStatus === 'generating' ? (
                <Tag color="processing">生成中</Tag>
              ) : genStatus === 'failed' ? (
                <Tag color="red">生成失败</Tag>
              ) : (
                <Tag>草稿</Tag>
              )}
            </InfoBlock>

            <InfoBlock label="目的地" token={token}>
              <Typography.Text style={{ fontSize: 13 }}>
                {resolvedCity?.city}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                {resolvedCity?.adcode}
              </Typography.Text>
            </InfoBlock>

            <InfoBlock label="出发日期" token={token}>
              <Typography.Text style={{ fontSize: 13 }}>
                {stepOne.startDate.format('YYYY-MM-DD')}
              </Typography.Text>
            </InfoBlock>

            <InfoBlock label="天数 / 人数" token={token}>
              <Space size={4}>
                <Tag color="blue">{stepOne.days} 天</Tag>
                <Tag color="cyan">{stepOne.travelers} 人</Tag>
              </Space>
            </InfoBlock>

            <InfoBlock label="预算" token={token}>
              <Typography.Text style={{ fontSize: 13 }}>
                {stepOne.budgetAmount
                  ? `¥${stepOne.budgetAmount} · ${stepOne.budgetScope === 'per_person' ? '人均' : '总预算'}`
                  : '不限'}
              </Typography.Text>
            </InfoBlock>

            <InfoBlock label="住宿锚点" token={token} span={2}>
              <Typography.Text style={{ fontSize: 13 }}>
                {stayMode === 'manual' && selectedHotel
                  ? selectedHotel.name
                  : '未确定，将由 AI 推荐交通便利的中心区域'}
              </Typography.Text>
            </InfoBlock>

            <InfoBlock label="偏好" token={token} span={2}>
              {stepOne.preferences?.length ? (
                <Space size={4} wrap>
                  {stepOne.preferences.map((item) => (
                    <Tag key={item} color="purple">
                      {item}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  未指定
                </Typography.Text>
              )}
            </InfoBlock>

            <InfoBlock label="额外需求" token={token} span={2}>
              {stepOne.extraNeeds?.length ? (
                <Space size={4} wrap>
                  {stepOne.extraNeeds.map((item) => (
                    <Tag key={item} color="gold">
                      {item}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  未指定
                </Typography.Text>
              )}
            </InfoBlock>
          </div>

          <Divider titlePlacement="start" plain>
            行程期间天气
          </Divider>

          {/* 天气改成横向卡片：一天一张，有预报的用主色淡底，
              超窗的用虚线框，视觉上明确区分「有数据」与「超出范围」，
              不再是一行行灰字排下来 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 8,
            }}
          >
            {tripDates.map((date, index) => {
              const cast = weatherByDate.get(date)
              return (
                <div
                  key={date}
                  data-testid="weather-item"
                  style={{
                    padding: '10px 12px',
                    borderRadius: token.borderRadius,
                    border: cast
                      ? `1px solid ${token.colorPrimaryBorder}`
                      : `1px dashed ${token.colorBorderSecondary}`,
                    background: cast ? token.colorPrimaryBg : token.colorFillQuaternary,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 4,
                    }}
                  >
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      第 {index + 1} 天
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {date.slice(5)}
                    </Typography.Text>
                  </div>

                  {cast ? (
                    <>
                      <div>
                        <Typography.Text style={{ fontSize: 13 }}>
                          {cast.dayWeather} {cast.dayTemp}°C
                        </Typography.Text>
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        夜间 {cast.nightWeather} {cast.nightTemp}°C · {cast.dayWind}风{' '}
                        {cast.dayPower}级
                      </Typography.Text>
                    </>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      超出预报范围
                      <br />
                      （高德仅覆盖未来约 4 天）
                    </Typography.Text>
                  )}
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
