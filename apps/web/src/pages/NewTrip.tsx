// 新建行程页 —— 三步向导。
//
// 向导流程：
//   1. 基本信息：目的地（需解析成行政区划编码）、出发日期、天数、人数、偏好、预算、额外需求
//   2. 选定住宿：在页面内嵌的高德地图上搜索并点选酒店，作为每日行程的锚点；
//      也可以选「还没定」，此时交给 AI 推荐交通便利的中心区域
//   3. 生成行程：按天触发 AI 排布景点与餐厅，页面轮询显示逐天进度；
//      某一天失败不影响已经排好的天，可以从断点继续。
//      可选「逐天确认」（每排完一天暂停裁决）与「并行择优」（每天并排生成 2 套取优）
//
// 为什么一定要先解析目的地：高德做 POI 检索和天气查询用的都是 6 位行政区划编码（adcode），
// 只拿一个城市名是查不准的。解析动作同时把城市中心坐标取回来，用于地图初始视野。

import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
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
  Switch,
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
import {
  cancelGeneration,
  createReplanDraft,
  getCompletedDayCount,
  getMissingDayIndexes,
  parseGenerationReview,
  recoverGeneration,
  type GenerationReviewRequest,
  type GenerationRunPhase,
} from '../api/trips'
import AmapMap, { type MapMarker } from '../components/AmapMap'
import FormSection from '../components/FormSection'
import GenerationStatusTag from '../components/GenerationStatusTag'

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
 * 轮询连续失败多少次后才放弃（任务4）。
 *
 * 取 5：按 2.5 秒的间隔算，约 12 秒的容忍窗口——足够跨过一次网络抖动或
 * 后端短暂重启，又不会让用户对着一个真的挂掉的页面无限等待。
 */
const MAX_POLL_FAILURES = 5

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

/**
 * 行程生成状态。
 *
 * partial 是审查报告 A08 新增的一档：存在「连续失败被跳过」的天时，
 * 整趟不应标记为 ready（那会让用户以为 5 天都排好了），
 * 而是标记 partial，并把缺失的天数明确告知。
 */
type GenStatus = 'draft' | 'generating' | 'ready' | 'partial' | 'failed'

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
  const [genStatus, setGenStatus] = useState<GenStatus>('draft')
  const [genProgress, setGenProgress] = useState('')
  const [genError, setGenError] = useState('')
  /** 已真实落库的天数与缺失日期，不能用生成游标代替 */
  const [completedDayCount, setCompletedDayCount] = useState(0)
  const [missingDayIndexes, setMissingDayIndexes] = useState<number[]>([])
  /** 生成过程中服务端自动修正过的规则提示（通勤超时换点、天型降档等） */
  const [genWarnings, setGenWarnings] = useState<string[]>([])
  const [genRunPhase, setGenRunPhase] = useState<GenerationRunPhase>(null)
  const [genReviewId, setGenReviewId] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)
  /** 切换到重新规划副本后，旧行程在途响应不得覆盖新行程的状态。 */
  const pollTripIdRef = useRef<string | null>(null)
  const pollTokenRef = useRef(0)
  /** 连续轮询失败次数（任务4）。成功一次即归零，用于区分「偶发抖动」与「持续不可达」 */
  const pollFailuresRef = useRef(0)

  // --- 图版专属的两个开关（LangGraph 编排） ---------------------------------
  /** 逐天人工确认：每排完一天暂停，展示摘要，等用户点头再排下一天 */
  const [reviewEnabled, setReviewEnabled] = useState(false)
  /** 服务端发来的待裁决载荷（genReview JSON 解析）。null 表示没有暂停等待裁决 */
  const [reviewRequest, setReviewRequest] = useState<GenerationReviewRequest | null>(null)
  /** 驳回时填的修改意见（可空 = 不满意但没具体说，AI 会换一批地点重排） */
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [confirming, setConfirming] = useState(false)
  /** 并行择优：每天并行 2 套方案打分选最优。成本与耗时约翻倍，默认关 */
  const [parallelEnabled, setParallelEnabled] = useState(false)

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
  async function pollGeneration(tripId: string, token = pollTokenRef.current) {
    if (pollTripIdRef.current !== tripId || token !== pollTokenRef.current) return
    try {
      const { data } = await api.get<{
        trip: {
          status: string
          days: number
          tripDays: Array<{ dayIndex: number }>
          genProgress: string | null
          genError: string | null
          genReview: string | null
          genReviewId: string | null
          genRunPhase: GenerationRunPhase
          completedDayCount?: number
          missingDayIndexes?: number[]
          genWarnings?: string[]
        }
      }>(`/trips/${tripId}`)

      const trip = data.trip
      if (pollTripIdRef.current !== tripId || token !== pollTokenRef.current) return
      // 拉取成功即重置失败计数，保证「偶发抖动」永远不会累积到放弃阈值
      pollFailuresRef.current = 0
      // partial = 部分完成（有跳过的天）。它属于「已结束」而不是「进行中」，
      // 所以同样要停止轮询、把 generating 关掉（见报告 A08）。
      setGenStatus(trip.status as GenStatus)
      setGenProgress(trip.genProgress ?? '')
      // 图版交互模式：genReview 是服务端 interrupt 的结构化载荷（JSON 字符串）。
      // kind=confirm 单方案确认/驳回；kind=choose 双方案对比挑选。
      // 解析失败按「没有待裁决内容」处理，不影响其它状态的展示。
      setReviewRequest(parseGenerationReview(trip.genReview))
      setGenReviewId(trip.genReviewId ?? null)
      setGenRunPhase(trip.genRunPhase ?? null)
      setGenError(trip.genError ?? '')
      setCompletedDayCount(
        getCompletedDayCount({
          days: trip.days,
          completedDayCount: trip.completedDayCount,
          tripDays: trip.tripDays,
        }),
      )
      setMissingDayIndexes(
        getMissingDayIndexes({
          days: trip.days,
          missingDayIndexes: trip.missingDayIndexes,
          tripDays: trip.tripDays,
        }),
      )
      // 规则修正提示（报告 A09）：这些是「AI 原本排得不合理、已被自动纠正」
      // 的记录，让用户能判断生成质量，而不是只看到一个「已完成」
      setGenWarnings(trip.genWarnings ?? [])

      if (trip.status === 'generating') {
        pollTimer.current = window.setTimeout(() => void pollGeneration(tripId, token), 2500)
      } else {
        setGenerating(false)
      }
    } catch (err) {
      // 网络偶发失败不应终结轮询（见审查报告任务4 第4点）。
      //
      // 原实现一遇到异常就 setGenerating(false)，等于「一次抖动 = 进度条永远卡住」，
      // 用户完全不知道后台其实还在生成。这里改成：只要用户还停留在生成态，
      // 就隔一会儿重试；连续失败若干次后才真正放弃并给提示，避免无限空转。
      pollFailuresRef.current += 1
      if (pollTripIdRef.current !== tripId || token !== pollTokenRef.current) return
      if (pollFailuresRef.current <= MAX_POLL_FAILURES) {
        pollTimer.current = window.setTimeout(() => void pollGeneration(tripId, token), 2500)
        return
      }
      setGenError(extractError(err, '读取生成状态失败，请刷新页面查看'))
      setGenerating(false)
    }
  }

  /**
   * 触发生成。
   *
   * mode 有两种：continue 保留已经排好的天，从第一个空缺的天接着排；
   * restart 对已有日期会先复制基础配置到新草稿，再从第 1 天重新规划；
   * 原行程与打卡数据保持不动。服务端是按天生成的，所以中途失败时用户可以先「继续」。
   *
   * 勾了「逐天人工确认」时走图版专属的 review 模式；服务端会保留已有日期，
   * 因此 partial 也可以在这个模式下安全补缺。
   * 「并行择优」作为独立开关随请求带给服务端，由它决定是否强制走图版。
   */
  async function startGenerate(mode: 'continue' | 'restart') {
    if (!savedTripId) return

    let targetTripId = savedTripId
    // 后端会拒绝对已有日期的 restart，避免误删已确认内容；这里先创建安全副本，
    // 原行程与打卡数据保持不动，新副本再按当前 review/普通模式开始生成。
    if (mode === 'restart' && completedDayCount > 0) {
      try {
        targetTripId = await createReplanDraft(savedTripId)
        setSavedTripId(targetTripId)
        setCompletedDayCount(0)
        setMissingDayIndexes(Array.from({ length: totalDays }, (_, index) => index + 1))
      } catch (err) {
        message.error(extractError(err, '创建重新规划副本失败，原行程未修改'))
        return
      }
    }

    pollTokenRef.current += 1
    pollTripIdRef.current = targetTripId
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = null
    }

    const actualMode = reviewEnabled ? 'review' : mode
    setGenerating(true)
    // 新一轮生成从零计失败次数（任务4），避免上一轮的残余计数立刻触发放弃
    pollFailuresRef.current = 0
    setGenError('')
    setReviewRequest(null)
    setGenReviewId(null)
    setGenRunPhase('running')
    setReviewFeedback('')
    setGenProgress(
      reviewEnabled
        ? '正在准备（逐天确认模式，每排完一天会暂停等你确认）'
        : mode === 'restart'
          ? '正在准备（重新生成）'
          : '正在准备',
    )
    setGenStatus('generating')

    try {
      await api.post(`/trips/${targetTripId}/generate`, {
        mode: actualMode,
        parallel: parallelEnabled,
      })
      void pollGeneration(targetTripId, pollTokenRef.current)
    } catch (err) {
      setGenError(extractError(err, '触发失败，请稍后重试'))
      setGenerating(false)
      setGenStatus('failed')
    }
  }

  /**
   * 逐天确认/并行择优模式下的用户裁决：让图从 interrupt 处恢复。
   *   - approve：确认采用（单方案）
   *   - choose：采用指定方案（A/B）
   *   - reject：驳回（附修改意见，AI 按意见重排这一天）
   * 轮询一直在跑（行程状态始终是 generating），裁决后无需重新起轮询。
   */
  async function confirmReview(answer: { decision: 'approve' | 'choose' | 'reject'; choice?: 'A' | 'B' }) {
    if (!savedTripId) return
    if (!genReviewId) {
      message.warning('待确认方案标识已丢失，请刷新后重新选择')
      return
    }
    setConfirming(true)
    try {
      await api.post(`/trips/${savedTripId}/review-confirm`, {
        decision: answer.decision,
        choice: answer.choice,
        feedback: answer.decision === 'reject' ? reviewFeedback.trim() || undefined : undefined,
        reviewId: genReviewId,
        parallel: parallelEnabled,
      })
      setReviewRequest(null)
      setReviewFeedback('')
      setGenRunPhase('running')
    } catch (err) {
      setGenError(extractError(err, '操作失败，请稍后重试'))
    } finally {
      setConfirming(false)
    }
  }

  /** 仅取消等待确认/人工恢复阶段，服务端会保留已落库日期与打卡数据。 */
  async function cancelCurrentGeneration() {
    if (!savedTripId) return
    try {
      await cancelGeneration(savedTripId)
      setReviewRequest(null)
      setReviewFeedback('')
      setGenReviewId(null)
      setGenRunPhase(null)
      await pollGeneration(savedTripId, pollTokenRef.current)
      message.success('已取消未确认方案，可继续补齐缺失日期')
    } catch (err) {
      message.error(extractError(err, '当前生成仍在执行，请稍候再试'))
    }
  }

  async function checkInterruptedGeneration() {
    if (!savedTripId) return
    try {
      const result = await recoverGeneration(savedTripId)
      await pollGeneration(savedTripId, pollTokenRef.current)
      if (result.status === 'recovery') message.warning('任务已中断，取消后可安全补齐缺失日期')
      else if (result.status === 'commit_pending') message.info('已生成安排仍在，可以重试保存')
      else if (result.status === 'waiting') message.info('正在等待你的确认')
      else if (result.status === 'active') message.info('任务仍在执行')
    } catch (err) { message.error(extractError(err, '暂时无法检查生成状态')) }
  }

  // 离开页面时清掉定时器，避免在后台空转
  useEffect(() => {
    return () => {
      pollTokenRef.current += 1
      pollTripIdRef.current = null
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

  // 进度必须按服务端真实落库日期计算，不能用生成序号推断连续完成。
  const totalDays = stepOne?.days ?? 0
  const doneDays = completedDayCount
  const commitPending = genRunPhase === 'commit_pending'
  // partial/failed 都没有正在执行的模型任务；即使服务端已经落库全部日期，
  // 也要保留幂等 continue 入口，让后端完成最后的收尾状态推进。
  const canContinue = (genStatus === 'failed' || genStatus === 'partial') && genRunPhase !== 'recovery'
  const continueLabel = commitPending
    ? '重试保存已生成安排'
    : missingDayIndexes.length > 0
      ? `继续补齐${missingDayIndexes.length === 1 ? `第 ${missingDayIndexes[0]} 天` : `第 ${missingDayIndexes.join('、')} 天`}`
      : '核对并完成行程'

  return (
    <div className="page-shell">
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        新建行程
      </Typography.Title>

      <Card style={{ marginBottom: 16 }}>
        <Steps
          current={current}
          items={[
            { title: '旅行信息' },
            { title: '住宿安排' },
            { title: '生成行程' },
          ]}
        />
      </Card>

      {/* ---------------- 第一步：基本信息 ---------------- */}
      {current === 0 && (
        <Card
          className="form-shell"
          styles={{ body: { display: 'flex', flexDirection: 'column', gap: 16 } }}
        >
          <div
            style={{
              minWidth: 0,
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
          className="stay-card"
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
                          <button
                            key={hotel.poiId}
                            type="button"
                            data-testid="hotel-item"
                            onClick={() => pickHotel(hotel)}
                            style={{
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              font: 'inherit',
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
                          </button>
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
              <div className="stay-map"><AmapMap
                center={mapCenter}
                zoom={mapZoom}
                markers={stayMarkers}
                onMarkerClick={(id) => {
                  const hotel = hotels.find((item) => item.poiId === id)
                  if (hotel) pickHotel(hotel)
                }}
                height="clamp(320px, 40vw, 520px)"
              />
              </div>
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

      {/* ---------------- 第三步：生成行程 ---------------- */}
      {current === 2 && stepOne && (
        <Card
          title="生成行程"
          extra={
            <span data-testid="gen-status">
              <GenerationStatusTag status={genStatus} phase={genRunPhase} />
            </span>
          }
        >
          {genStatus === 'ready' ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
              title="行程已生成完成"
              description="每日的景点、餐厅与通勤安排都已写入这条行程，可以到「我的行程」里查看。逐日时间轴、地图联动与到点打卡都已就绪。"
            />
          ) : (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                title={doneDays > 0 ? `已保存 ${doneDays}/${totalDays} 天` : '行程已保存，准备生成'}
                description={genRunPhase === 'waiting'
                  ? '请先确认下方方案，系统会继续安排下一天。'
                  : genRunPhase === 'recovery'
                    ? '请检查中断状态，必要时取消未确认方案后补齐缺失日期。'
                    : '按天安排并保存；离开页面后仍可在行程详情查看状态。'}
              />
              <Collapse
                size="small"
                style={{ marginBottom: 16 }}
                items={[{ key: 'rules', label: '了解选点与生成规则', children: (
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    AI 以住宿为锚点查询高德的景点、餐厅、天气与真实路线。每天游览类地点不超过 3 个，
                    主题乐园或爬山通常只排 1 个；餐厅安排在相邻景点之间，通勤超过 40 分钟会换点，雨天优先室内。
                    景点建议评分不低于 4 分，并核对营业时间；高强度行程后一天会安排得轻松一些。
                    每次只生成并保存一天，已保存日期在失败后会保留。
                  </Typography.Paragraph>
                ) }]}
              />
            </>
          )}

          {/* 图版专属开关区。普通生成不受影响；勾选后才走 LangGraph 的增强能力 */}
          <div
            style={{
              display: 'flex',
              gap: 32,
              flexWrap: 'wrap',
              marginBottom: 16,
              padding: '12px 16px',
              borderRadius: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div>
              <Space size={8}>
                <Switch
                  size="small"
                  checked={reviewEnabled}
                  onChange={setReviewEnabled}
                  data-testid="review-toggle"
                />
                <Typography.Text strong>逐天人工确认</Typography.Text>
              </Space>
              <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 4, maxWidth: 300 }}>
                每排完一天就暂停，展示当天摘要，等你确认后再排下一天（生成会从头开始）
              </div>
            </div>
            <div>
              <Space size={8}>
                <Switch
                  size="small"
                  checked={parallelEnabled}
                  onChange={setParallelEnabled}
                  data-testid="parallel-toggle"
                />
                <Typography.Text strong>并行择优</Typography.Text>
                {parallelEnabled && <Tag color="orange">消耗与耗时约翻倍</Tag>}
              </Space>
              <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 4, maxWidth: 300 }}>
                每天并行生成 2 套方案，按评分与通勤打分选最优再落库
              </div>
            </div>
          </div>

          {/* 图版交互模式：图暂停在 interrupt 上时弹出裁决卡片。
              kind=confirm 单方案（确认/驳回），kind=choose 双方案（挑一个/都驳回）。
              驳回可附修改意见，AI 会按意见重排这一天。 */}
          {reviewRequest && genStatus === 'generating' && genRunPhase === 'waiting' && (
            <div
              data-testid="review-card"
              style={{
                border: `1px solid ${token.colorWarningBorder}`,
                borderLeft: `3px solid ${token.colorWarning}`,
                borderRadius: 6,
                padding: '14px 16px',
                marginBottom: 16,
                background: token.colorWarningBg,
              }}
            >
              <Typography.Text strong style={{ fontSize: 14 }}>
                {reviewRequest.kind === 'choose'
                  ? `第 ${reviewRequest.dayIndex}/${reviewRequest.totalDays} 天：两个方案请你挑一个`
                  : `第 ${reviewRequest.dayIndex}/${reviewRequest.totalDays} 天已排好，等待你的确认`}
              </Typography.Text>

              {reviewRequest.kind === 'confirm' && reviewRequest.summary && (
                <Typography.Paragraph style={{ marginTop: 8, marginBottom: 8 }}>
                  {reviewRequest.summary}
                </Typography.Paragraph>
              )}

              {/* 双方案对比：优缺点与评分/通勤数据都来自已验证的高德数据，
                  不掺 AI 的主观形容，用户看到的是可复核的数字 */}
              {reviewRequest.kind === 'choose' && reviewRequest.candidates && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12, margin: '10px 0' }}>
                  {reviewRequest.candidates.map((c) => (
                    <div
                      key={c.label}
                      data-testid={`review-candidate-${c.label}`}
                      style={{
                        border: `1px solid ${token.colorBorder}`,
                        borderRadius: 6,
                        padding: '10px 12px',
                        background: token.colorBgContainer,
                      }}
                    >
                      <Space size={8} style={{ marginBottom: 6 }}>
                        <Tag color="blue">方案 {c.label}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          评分均值 {c.ratingAvg} 分 ｜ {c.spotCount} 个景点
                        </Typography.Text>
                      </Space>
                      {/* 通勤分驾车/公交两种方式展示：用户不一定开车，
                          只给一个不标方式的数字没有参考意义 */}
                      <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 6 }}>
                        🚗 驾车约 {c.commuteMinutes === null ? '未知' : `${c.commuteMinutes} 分钟`}
                        {' ｜ '}🚇 公交约 {c.transitMinutes === null ? '未知' : `${c.transitMinutes} 分钟`}
                      </div>
                      <Typography.Paragraph style={{ marginBottom: 8, fontSize: 13 }}>
                        {c.summary}
                      </Typography.Paragraph>
                      <div style={{ fontSize: 12.5 }}>
                        {c.pros.map((p) => (
                          <div key={p} style={{ color: token.colorSuccess }}>＋ {p}</div>
                        ))}
                        {c.cons.map((cItem) => (
                          <div key={cItem} style={{ color: token.colorWarning }}>－ {cItem}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Input.TextArea
                rows={2}
                value={reviewFeedback}
                onChange={(e) => setReviewFeedback(e.target.value)}
                placeholder="不满意？写下修改意见（可选），例如「不要博物馆，多安排户外」，AI 会按意见重排这一天"
                maxLength={500}
                style={{ marginBottom: 10 }}
              />

              <Space wrap>
                {reviewRequest.kind === 'confirm' ? (
                  <Button
                    type="primary"
                    size="small"
                    loading={confirming}
                    data-testid="review-confirm-btn"
                    onClick={() => void confirmReview({ decision: 'approve' })}
                  >
                    确认采用，继续排下一天
                  </Button>
                ) : (
                  <>
                    <Button
                      type="primary"
                      size="small"
                      loading={confirming}
                      data-testid="review-choose-a-btn"
                      onClick={() => void confirmReview({ decision: 'choose', choice: 'A' })}
                    >
                      采用方案 A
                    </Button>
                    <Button
                      size="small"
                      loading={confirming}
                      data-testid="review-choose-b-btn"
                      onClick={() => void confirmReview({ decision: 'choose', choice: 'B' })}
                    >
                      采用方案 B
                    </Button>
                  </>
                )}
                <Button
                  size="small"
                  loading={confirming}
                  data-testid="review-reject-btn"
                  onClick={() => void confirmReview({ decision: 'reject' })}
                >
                  需要调整，按意见重新安排
                </Button>
                <Button
                  size="small"
                  loading={confirming}
                  data-testid="review-cancel-btn"
                  onClick={() => void cancelCurrentGeneration()}
                >
                  取消未确认方案
                </Button>
              </Space>
            </div>
          )}

          {genStatus === 'generating' && genRunPhase === 'waiting' && !reviewRequest && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="有待确认内容，但卡片暂时无法读取"
              description="请刷新后重试；如果仍无法恢复，可以取消未确认方案，保留已落库日期后安全补缺。"
              action={
                <Button size="small" onClick={() => void cancelCurrentGeneration()}>
                  取消并安全补缺
                </Button>
              }
            />
          )}

          {genStatus === 'generating' && genRunPhase === 'recovery' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="这次确认需要人工恢复"
              description="原有候选方案已保留，取消后会保留已落库日期和打卡数据，再从缺失日期安全补齐。"
              action={
                <Button size="small" onClick={() => void cancelCurrentGeneration()}>
                  取消并安全补缺
                </Button>
              }
            />
          )}

          {genStatus === 'generating' && commitPending && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="安排已生成，保存未成功"
              description="服务端正在等待安全的保存重试；恢复为失败状态后点击「重试保存已生成安排」，不会再次调用模型。"
            />
          )}

          <Space style={{ marginBottom: 16 }} wrap>
            {savedTripId && (genStatus === 'generating' || commitPending) && (
              <Button onClick={() => void checkInterruptedGeneration()} data-testid="newtrip-recover-check">检查中断状态</Button>
            )}
            {canContinue && (
              <Button
                type="primary"
                data-testid="generate-continue-btn"
                loading={generating}
                onClick={() => void startGenerate('continue')}
              >
                {continueLabel}
              </Button>
            )}
            <Button
              type={canContinue ? 'default' : 'primary'}
              data-testid="generate-btn"
              loading={generating}
              disabled={genStatus === 'generating' || genRunPhase === 'recovery'}
              onClick={() =>
                void startGenerate(commitPending ? 'continue' : genStatus === 'ready' || doneDays > 0 ? 'restart' : 'continue')
              }
            >
                {commitPending
                  ? '重试保存已生成安排'
                  : reviewEnabled
                  ? genStatus === 'ready' || doneDays > 0
                   ? '新建副本逐天确认'
                   : '开始生成（逐天确认）'
                  : genStatus === 'ready'
                   ? '新建副本重新规划'
                   : doneDays > 0
                     ? '新建副本重新规划'
                     : '开始生成行程'}
            </Button>
            {generating && (
              <Typography.Text type="secondary">生成在服务端进行，请勿关闭当前账号的会话</Typography.Text>
            )}
          </Space>

          {(genStatus === 'ready' || genStatus === 'generating' || genStatus === 'partial' || doneDays > 0) && (
            <div data-testid="gen-progress" style={{ marginBottom: 16 }}>
              <Alert
                type={genStatus === 'generating' ? 'info' : genStatus === 'partial' ? 'warning' : genStatus === 'ready' ? 'success' : 'warning'}
                showIcon
                title={
                  genStatus === 'generating'
                    ? reviewRequest
                      ? 'AI 正在等待你的裁决（见上方卡片）'
                      : `AI 正在排程：${genProgress || '准备中'}`
                    : genStatus === 'partial'
                      ? `已完成 ${doneDays}/${totalDays} 天${missingDayIndexes.length > 0 ? `，待补齐第 ${missingDayIndexes.join('、')} 天` : '，没有缺失日期，可核对并完成行程'}`
                      : genStatus === 'ready'
                        ? `行程已完成：${doneDays}/${totalDays} 天`
                        : `已排好 ${doneDays}/${totalDays} 天`
                }
                description={
                  genStatus === 'generating'
                    ? '正在调用高德接口查询景点、餐厅与真实路线，每排完一天就会立刻存下来。'
                    : genStatus === 'partial'
                      ? `${genError ? `${genError}。` : ''}${missingDayIndexes.length > 0 ? '缺失的天没有生成数据，可以点「继续补齐」保留已有日期，或选择「新建副本重新规划」。' : '可以点「核对并完成行程」完成最终状态收尾，或选择「新建副本重新规划」。'}`
                      : genStatus === 'ready'
                        ? '所有日期都已保存，可以到「我的行程」查看时间轴、地图与打卡。'
                        : '上面这些天已经保存在行程里了，可以接着把剩下的排完。'
                }
              />
              <Progress
                percent={totalDays > 0 ? Math.round((doneDays / totalDays) * 100) : 0}
                size="small"
                format={() => `${doneDays}/${totalDays} 天`}
                style={{ marginTop: 8 }}
                status={genStatus === 'partial' ? 'exception' : genStatus === 'ready' ? 'success' : undefined}
              />
            </div>
          )}

          {/* 规则修正提示（报告 A09）：AI 原本排得不合理、被自动纠正的地方。
              折叠展示，不打断主流程，但让用户能主动检查生成质量。 */}
          {genWarnings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Collapse
                size="small"
                items={[
                  {
                    key: 'warnings',
                    label: `AI 自动调整了 ${genWarnings.length} 处安排（点击查看）`,
                    children: (
                      <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                        {genWarnings.map((warning, index) => (
                          <li key={index} style={{ marginBottom: 4 }}>
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
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
                  {missingDayIndexes.length > 0 ? (
                    <>
                      <br />
                      已经排好的 {doneDays} 天不受影响，点「继续补齐」即可处理第 {missingDayIndexes.join('、')} 天。
                    </>
                  ) : canContinue ? (
                    <>
                      <br />
                      没有缺失日期，点「核对并完成行程」即可完成最终状态收尾。
                    </>
                  ) : null}
                </span>
              }
            />
          )}

          <Collapse size="small" items={[{ key: 'details', label: '行程与天气详情', children: <>
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
               <GenerationStatusTag status={genStatus} phase={genRunPhase} />
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
          </> }]} />

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
