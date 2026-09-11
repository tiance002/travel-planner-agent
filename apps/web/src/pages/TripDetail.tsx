// 行程详情页 —— P5 的核心页面。
//
// 三块能力：
//   1. 时段分组的顺序列表：按 orderIndex 顺序展示，时段（上午/中午/下午/晚上）
//      变化时自然分组。因为不计算游览时长，排不出具体钟点，所以用「时段」而不是「时刻」。
//   2. 手动打卡：用户到点后自己点按钮。未打卡 = 空心圆点 + 常规颜色；
//      已打卡 = 实心 + 对勾 + 卡片置灰；当天第一个未到的条目作为「当前目标」高亮。
//   3. 地图联动：默认只显示当前选中那天的标记；点击列表条目或地图标记互相联动；
//      路线用高德路径规划的真实折线逐段绘制（绝不用直线连接，直线只用于排序）。
//
// 数据来源：GET /api/trips/:id 一次性拿全量，打卡走独立的打/取消接口，
// 用乐观更新让按钮立刻有反馈，失败时回滚并提示。

import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Radio,
  Row,
  Skeleton,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { theme as antdTheme } from 'antd'
import { BookOutlined, SwapOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchPoiPhotos, planRoute, type RouteMode, type RouteResult } from '../api/amap'
import { api, extractError } from '../api/client'
import {
  checkinItem,
  DAY_TYPE_LABEL,
  getItemAlternatives,
  getTrip,
  replaceItem,
  uncheckinItem,
  type AlternativeCandidate,
  type DayType,
  type TripDayData,
  type TripDetailData,
  type TripItemData,
} from '../api/trips'
import AmapMap, { type MapMarker } from '../components/AmapMap'
import { NotebookRings, StickyNote, usePaperTheme } from '../components/paper'

/**
 * 便利贴上的小标。
 *
 * 为什么不用 antd 的 Tag：Tag 自带浅彩底，压在淡彩便利贴上会变成
 * 「贴纸叠贴纸」，颜色一多就乱。这里改成墨色描边的空标，
 * 只有「当前目标」给一点主色实底用来抢视线。
 */
function NoteTag({
  children,
  ink,
  rule,
  accent,
}: {
  children: React.ReactNode
  ink: string
  rule: string
  /** primary 用主色强调（当前目标），其余一律朴素墨色描边 */
  accent?: 'primary'
}) {
  const { token } = antdTheme.useToken()
  const isPrimary = accent === 'primary'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 4,
        fontSize: 11.5,
        lineHeight: 1.75,
        color: isPrimary ? token.colorPrimary : ink,
        border: `1px solid ${isPrimary ? token.colorPrimaryBorder : rule}`,
        background: isPrimary ? token.colorPrimaryBg : 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

/** 时段的中文标签。key 与后端 persistDay 写入的 slot 值一一对应 */
const SLOT_LABEL: Record<string, string> = {
  morning: '上午',
  noon: '中午',
  afternoon: '下午',
  evening: '晚上',
}

/** 各天型标记用的颜色。antd Tag 的语义色，白天黑夜都能看清 */
const DAY_TYPE_COLOR: Record<string, string> = {
  theme_park: 'purple',
  hike: 'green',
  night_hike: 'geekblue',
  recovery: 'gold',
}

/** 出行方式选项。默认驾车，与排程时判定「通勤超 40 分钟就换点」用的口径一致 */
const ROUTE_MODES: { value: RouteMode; label: string }[] = [
  { value: 'driving', label: '驾车' },
  { value: 'transit', label: '公交' },
  { value: 'walking', label: '步行' },
  { value: 'bicycling', label: '骑行' },
]

/** 地图上路线的一条段：从 a 点到 b 点 */
interface Segment {
  fromId: string
  toId: string
  fromLng: number
  fromLat: number
  toLng: number
  toLat: number
}

/** 把当天条目按时段分组：保持 orderIndex 顺序，slot 变化时开新组 */
function groupBySlot(items: TripItemData[]) {
  const groups: { slot: string; items: TripItemData[] }[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.slot === item.slot) {
      last.items.push(item)
    } else {
      groups.push({ slot: item.slot, items: [item] })
    }
  }
  return groups
}

/** 跳转小红书搜该地点的攻略。只做关键词跳转，不抓取任何内容——这是项目的合规红线 */
function openXiaohongshu(placeName: string) {
  const keyword = `${placeName} 旅游攻略`
  window.open(
    `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
    '_blank',
    'noopener,noreferrer',
  )
}

/** poiId → 补查到的照片。模块级缓存：翻页/切天回来不用重复请求 */
const poiPhotoCache = new Map<string, string[]>()

/**
 * 景点照片：右侧 84px 方图。
 * 取图顺序：行程里存的 photos（生成时高德搜索顺带返回）
 * → 按 poiId 兜底查一次详情照片（照片功能上线前的旧行程没有存图，靠这个补上）
 * → 都没有时给柔和渐变占位，保持卡片视觉整齐。
 */
function ItemPhoto({ item }: { item: TripItemData }) {
  const { token } = antdTheme.useToken()
  const [failed, setFailed] = useState(false)
  const [extra, setExtra] = useState<string[] | null>(
    item.poiId ? poiPhotoCache.get(item.poiId) ?? null : null,
  )

  useEffect(() => {
    // 已有内嵌照片、或连 poiId 都没有（AI 推荐区域这类无坐标条目）就不用兜底
    if ((item.photos?.length ?? 0) > 0 || !item.poiId) return
    if (poiPhotoCache.has(item.poiId)) {
      setExtra(poiPhotoCache.get(item.poiId) ?? [])
      return
    }
    let cancelled = false
    fetchPoiPhotos(item.poiId)
      .then((photos) => {
        poiPhotoCache.set(item.poiId!, photos)
        if (!cancelled) setExtra(photos)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [item.photos, item.poiId])

  const photo = item.photos?.[0] ?? extra?.[0]

  if (!photo || failed) {
    return (
      <div
        aria-hidden
        style={{
          width: 84,
          height: 84,
          flexShrink: 0,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 30,
          // 用主题色填充：白天淡绿、黑夜自动变成柔和的深色块，不刺眼
          background: token.colorFillSecondary,
        }}
      >
        {item.itemType === 'restaurant' ? '🍜' : '🏞️'}
      </div>
    )
  }

  return (
    <img
      src={photo}
      alt={item.name}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: 84,
        height: 84,
        flexShrink: 0,
        objectFit: 'cover',
        borderRadius: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,.10)',
      }}
    />
  )
}

export default function TripDetail() {
  const { id = '' } = useParams()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  // antd 的主题 token：拿当前主题下的颜色值，保证白天/黑夜都协调
  const { token } = antdTheme.useToken()

  const [trip, setTrip] = useState<TripDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  /** 当前查看第几天（1 起）。默认落在「今天」，不在行程区间内则看第 1 天 */
  const [activeDay, setActiveDay] = useState(1)
  const initializedDayRef = useRef(false)

  /** 用户点选中的条目（列表 ↔ 地图联动的高亮对象） */
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  /** 地图中心，选中条目时跟随移动 */
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>()

  /** 出行方式与路线状态 */
  const [routeMode, setRouteMode] = useState<RouteMode>('driving')
  const [routes, setRoutes] = useState<(RouteResult | null)[]>([])
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeWarn, setRouteWarn] = useState('')
  // 路线缓存：同一段路 + 同一方式只请求一次高德，服务端还有 5 分钟缓存兜底
  const routeCacheRef = useRef<Map<string, RouteResult | null>>(new Map())

  /** 打卡中的条目集合，让按钮各自转圈而不是整页禁用 */
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set())

  /** 「换一个」抽屉的开关与内容 */
  const [swapOpen, setSwapOpen] = useState(false)
  /** 正在替换的那个条目。抽屉标题与执行替换时都要用 */
  const [swapTarget, setSwapTarget] = useState<TripItemData | null>(null)
  const [candidates, setCandidates] = useState<AlternativeCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidatesError, setCandidatesError] = useState('')
  /** 正在替换的候选 poiId，让对应那张卡片转圈 */
  const [replacingPoiId, setReplacingPoiId] = useState<string | null>(null)

  /**
   * 地图的像素高度。
   *
   * 为什么要算而不写死：右列的卡片高度是 calc(100vh - 概要与留白)，
   * 地图要填满卡片 body 的剩余空间，就必须知道视口有多高。
   * 写死 520 在小屏上会把整页撑出滚动条，在大屏上又留出大片空白。
   *
   * 减去 460 的构成：顶部 app-header（约 64）+ 内容区内边距（约 36）
   * + 行程概要卡（约 130）+ 右侧卡片头部与底部说明（约 200）。
   */
  const [mapHeight, setMapHeight] = useState(() => Math.max(300, window.innerHeight - 460))

  // --- 数据加载 ---------------------------------------------------------------

  async function loadTrip() {
    try {
      const data = await getTrip(id)
      setTrip(data)

      // 只在第一次加载时决定默认看到哪天：今天在行程区间内就看今天
      if (!initializedDayRef.current) {
        initializedDayRef.current = true
        const today = dayjs().format('YYYY-MM-DD')
        const hit = data.tripDays.find((d) => dayjs(d.date).format('YYYY-MM-DD') === today)
        setActiveDay(hit ? hit.dayIndex : 1)
      }
      return data
    } catch (err) {
      setLoadError(extractError(err, '行程加载失败'))
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTrip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 生成中的行程持续轮询：详情接口本身就带进度字段，直接复用它
  const pollRef = useRef<number | null>(null)
  useEffect(() => {
    if (trip?.status !== 'generating') return
    pollRef.current = window.setTimeout(async () => {
      const data = await loadTrip()
      if (data?.status === 'ready') message.success('行程生成完成')
    }, 2500)
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.status, trip?.genDayIndex])

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [])

  // 视口尺寸变化时重算地图高度：右列锁定布局依赖它，不能只在挂载时算一次
  useEffect(() => {
    function syncMapHeight() {
      setMapHeight(Math.max(300, window.innerHeight - 460))
    }
    window.addEventListener('resize', syncMapHeight)
    return () => window.removeEventListener('resize', syncMapHeight)
  }, [])

  // 线圈本左侧要排多少个金属环。环间距固定 27px，数量跟着本子高度变，
  // 写死数量会在高屏上稀稀拉拉、矮屏上挤成一条实线
  const ringCount = useMemo(
    () => Math.max(8, Math.floor((window.innerHeight - 248) / 27)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapHeight],
  )

  // 纸质主题的取色入口。note.* 是便利贴上的（恒为浅底深墨，不随主题翻），
  // page.* 是纸页上的文字（跟着主题走）。
  //
  // **这个 hook 必须放在下面那两个提前 return 之前。**
  // React 要求每次渲染的 hook 数量与调用顺序完全一致：一旦放到提前 return 之后，
  // 第一次渲染（loading）会少走一个 hook、第二次却多走一个，直接抛
  // 「Rendered more hooks than during the previous render」，整页白屏。
  const { note, page } = usePaperTheme()

  // --- 当天的派生数据 -----------------------------------------------------------

  const day: TripDayData | undefined = useMemo(
    () => trip?.tripDays.find((d) => d.dayIndex === activeDay),
    [trip, activeDay],
  )

  /**
   * 便利贴的淡彩按条目在当天的顺序轮换（序号 → 颜色）。
   *
   * 用序号而不是随机：随机每次渲染都可能换色，用户滚动时颜色乱跳，看着像 bug。
   * 同样必须留在提前 return 之前——理由见上面 noteInk 处的说明。
   */
  const noteIndex = useMemo(
    () => new Map((day?.items ?? []).map((item, index) => [item.id, index])),
    [day],
  )

  /** 当天第一个未打卡的条目。它就是「当前目标」，列表和地图都要重点突出 */
  const currentTargetId = useMemo(() => {
    const first = day?.items.find((item) => !item.checkedAt)
    return first?.id ?? null
  }, [day])

  /** 按顺序带坐标的点：住宿锚点在最前，接着是当天各条目，最后再回到住宿 */
  const coordPoints = useMemo(() => {
    const points: { id: string; name: string; lng: number; lat: number }[] = []
    const hasStay = trip?.stayLng != null && trip?.stayLat != null
    const stayLng = trip?.stayLng
    const stayLat = trip?.stayLat

    if (hasStay) {
      points.push({ id: '__stay__', name: trip.stayName ?? '住宿', lng: stayLng!, lat: stayLat! })
    }
    for (const item of day?.items ?? []) {
      if (item.lng != null && item.lat != null) {
        points.push({ id: item.id, name: item.name, lng: item.lng, lat: item.lat })
      }
    }
    // 返程段：游玩结束要回住处，路线才是闭环。
    // 用户明确要求「路线规划要考虑最后一个地方到住处的距离」，不补这一段，
    // 地图上就永远看不到当天最后一站离家有多远。
    // id 必须和起点区分开，否则去找「这个点后面那段」时两个住宿点会互相顶掉。
    if (hasStay && points.length > 1) {
      points.push({
        id: '__stay_back__',
        name: `返回${trip.stayName ?? '住宿'}`,
        lng: stayLng!,
        lat: stayLat!,
      })
    }
    return points
  }, [trip, day])

  /** 条目 id 在坐标序列里的位置，用来找「从这个点到下一点」的路线 */
  const seqIndexOf = useMemo(() => {
    const map = new Map<string, number>()
    coordPoints.forEach((point, index) => map.set(point.id, index))
    return map
  }, [coordPoints])

  /** 相邻两点的路段列表 */
  const segments = useMemo<Segment[]>(() => {
    const result: Segment[] = []
    for (let i = 0; i < coordPoints.length - 1; i++) {
      const a = coordPoints[i]
      const b = coordPoints[i + 1]
      result.push({
        fromId: a.id,
        toId: b.id,
        fromLng: a.lng,
        fromLat: a.lat,
        toLng: b.lng,
        toLat: b.lat,
      })
    }
    return result
  }, [coordPoints])

  // 段集合的稳定标识：内容不变就不重新请求路线（打卡更新 trip 对象但点不变）
  const segmentKey = useMemo(
    () => segments.map((s) => `${s.fromId}>${s.toId}`).join('|') + `@${routeMode}`,
    [segments, routeMode],
  )

  // 逐段请求高德路径规划，拿真实路线折线
  useEffect(() => {
    if (segments.length === 0) {
      setRoutes([])
      setRouteWarn('')
      return
    }

    let cancelled = false
    setRouteLoading(true)

    void Promise.all(
      segments.map(async (segment) => {
        const key = `${segment.fromLng},${segment.fromLat}>${segment.toLng},${segment.toLat}@${routeMode}`
        // 缓存里存过 null（该段规划失败）也要直接返回，避免反复打高德
        if (routeCacheRef.current.has(key)) return routeCacheRef.current.get(key) ?? null

        try {
          const result = await planRoute({
            mode: routeMode,
            originLng: segment.fromLng,
            originLat: segment.fromLat,
            destLng: segment.toLng,
            destLat: segment.toLat,
            city1: trip?.cityName,
            city2: trip?.cityName,
          })
          routeCacheRef.current.set(key, result)
          return result as RouteResult | null
        } catch {
          // 单段失败不拖垮整条路线，折线里跳过这一段即可
          routeCacheRef.current.set(key, null)
          return null
        }
      }),
    ).then((results) => {
      if (cancelled) return
      setRoutes(results)
      setRouteWarn(results.some((r) => r === null) ? '部分路段未能规划出路线，地图上会缺这一段' : '')
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentKey])

  /** 拼接全部路段的折线，格式与高德原始串一致："lng,lat;lng,lat;..." */
  const mapPolyline = useMemo(
    () =>
      routes
        .filter((route): route is RouteResult => route !== null)
        .map((route) => route.polyline)
        .join(';'),
    [routes],
  )

  /** 地图标记：住宿用水滴形，条目用圆点（已打卡实心绿 + 对勾） */
  const markers = useMemo<MapMarker[]>(() => {
    if (!trip || !day) return []
    const result: MapMarker[] = []

    if (trip.stayLng != null && trip.stayLat != null) {
      result.push({ id: '__stay__', lng: trip.stayLng, lat: trip.stayLat, shape: 'pin', label: '住' })
    }
    for (const point of coordPoints) {
      if (point.id === '__stay__') continue
      const item = day.items.find((entry) => entry.id === point.id)
      if (!item) continue
      result.push({
        id: item.id,
        lng: item.lng!,
        lat: item.lat!,
        shape: 'dot',
        done: Boolean(item.checkedAt),
        active: item.id === currentTargetId || item.id === selectedItemId,
      })
    }
    return result
  }, [trip, day, coordPoints, currentTargetId, selectedItemId])

  // --- 交互 -------------------------------------------------------------------

  /** 打卡 / 取消打卡。先请求后更新本地状态，失败给提示 */
  async function toggleCheckin(item: TripItemData) {
    if (!trip) return
    setCheckingIds((prev) => new Set(prev).add(item.id))
    try {
      if (item.checkedAt) {
        await uncheckinItem(trip.id, item.id)
        patchItem(item.id, { checkedAt: null })
        message.success('已取消打卡')
      } else {
        const checkedAt = await checkinItem(trip.id, item.id)
        patchItem(item.id, { checkedAt })
        message.success(`已打卡：${item.name}`)
      }
    } catch (err) {
      message.error(extractError(err, '打卡操作失败'))
    } finally {
      setCheckingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  /** 就地更新某条目，避免整页重新拉取 */
  function patchItem(itemId: string, patch: Partial<TripItemData>) {
    setTrip((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        tripDays: prev.tripDays.map((d) => ({
          ...d,
          items: d.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
        })),
      }
    })
  }

  /** 点列表条目：地图移动过去并高亮 */
  function selectItem(item: TripItemData) {
    setSelectedItemId(item.id)
    if (item.lng != null && item.lat != null) {
      setMapCenter([item.lng, item.lat])
    }
  }

  // --- 换一个 -----------------------------------------------------------------

  /**
   * 打开替换候选抽屉。
   *
   * 天型日的处理：主题乐园整天、全天徒步这类日子，换掉唯一那个景点等于把
   * 当天的结构改掉了（从「泡一整天」变成「上午一个下午一个」）。所以先弹确认，
   * 让用户明确选择是「换一个同类的大景区」还是「换成普通行程」——
   * 后者就按常规一天来排，用户自己承担结构变化。
   */
  async function openAlternatives(item: TripItemData) {
    if (!trip) return

    const dayType = (day?.dayType ?? 'normal') as DayType
    const isSpecialDay = dayType === 'theme_park' || dayType === 'hike'

    if (isSpecialDay) {
      // 用 Modal 的静态方法做确认。这里没有用 App.useApp 的 modal，
      // 因为只需要一个简单的二选一，静态调用足够且代码更短
      const confirmed = await new Promise<boolean>((resolve) => {
        const label = DAY_TYPE_LABEL[dayType] || '这一天'
        const instance = modal.confirm({
          title: '这一天是整天行程',
          content: `${label}的结构是「一整天都在同一个地方」。换掉它会改变当天的安排结构，是否继续？`,
          okText: '继续挑选替换',
          cancelText: '算了',
          onOk: () => {
            instance.destroy()
            resolve(true)
          },
          onCancel: () => {
            instance.destroy()
            resolve(false)
          },
        })
      })
      if (!confirmed) return
    }

    setSwapTarget(item)
    setSwapOpen(true)
    setCandidates([])
    setCandidatesError('')
    setCandidatesLoading(true)

    try {
      const { candidates: list } = await getItemAlternatives(trip.id, item.id)
      setCandidates(list)
    } catch (err) {
      setCandidatesError(extractError(err, '候选地点查询失败'))
    } finally {
      setCandidatesLoading(false)
    }
  }

  /** 把目标条目换成选中的候选 */
  async function confirmReplace(candidate: AlternativeCandidate) {
    if (!trip || !swapTarget) return
    setReplacingPoiId(candidate.poiId)
    try {
      const updated = await replaceItem(trip.id, swapTarget.id, candidate.poiId)
      // 就地替换条目。不重排整天的顺序——用户只换了这一个，
      // 把其他条目的位置也一起动会让人困惑
      setTrip((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          tripDays: prev.tripDays.map((d) => ({
            ...d,
            items: d.items.map((entry) => (entry.id === swapTarget.id ? updated : entry)),
          })),
        }
      })
      message.success(`已换成「${updated.name}」`)
      setSwapOpen(false)
      setSwapTarget(null)
      // 换了地点，原来的路线缓存全部失效
      routeCacheRef.current.clear()
    } catch (err) {
      message.error(extractError(err, '替换失败'))
    } finally {
      setReplacingPoiId(null)
    }
  }

  // --- 渲染辅助 -----------------------------------------------------------------

  /** 换算路段信息文案，如「驾车约 12 分钟 · 5.2 km」 */
  function segmentText(item: TripItemData): string | null {
    const index = seqIndexOf.get(item.id)
    if (index === undefined || index >= segments.length) return null
    const route = routes[index]
    if (!route) return null
    const minutes = Math.max(1, Math.round(route.duration / 60))
    const km = (route.distance / 1000).toFixed(1)
    const modeLabel = ROUTE_MODES.find((m) => m.value === routeMode)?.label ?? ''
    const nextPoint = coordPoints[index + 1]
    return `${modeLabel}约 ${minutes} 分钟 · ${km} km 前往「${nextPoint.name}」`
  }

  if (loading) {
    return (
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    )
  }

  if (loadError || !trip) {
    return (
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <Alert
          type="error"
          showIcon
          title="行程加载失败"
          description={loadError || '行程不存在或已被删除'}
          action={
            <Button onClick={() => navigate('/trips')}>返回列表</Button>
          }
        />
      </div>
    )
  }

  const dayItems = day?.items ?? []
  const checkedCount = dayItems.filter((item) => item.checkedAt).length
  const groups = groupBySlot(dayItems)

  // 便利贴的墨色与序号在文件上方定义（那里是 hook 区）。
  // 这里只用它们，不再声明任何 hook —— 本行以下都在提前 return 之后。

  // 「换一个」抽屉要用它把邻站说清楚：首站的上一站是住处，末站的下一站是住处
  const swapIsFirst = Boolean(swapTarget && dayItems[0]?.id === swapTarget.id)
  const swapIsLast = Boolean(
    swapTarget && dayItems.length > 0 && dayItems[dayItems.length - 1].id === swapTarget.id,
  )

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      {/* ---- 行程概要 ---- */}
      <Card style={{ marginBottom: 16 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
          <div>
            <Space size={8} align="center">
              <Typography.Title level={4} style={{ margin: 0 }}>
                {trip.title}
              </Typography.Title>
              {trip.status === 'ready' && <Tag color="success">已完成</Tag>}
              {trip.status === 'generating' && <Tag color="processing">生成中</Tag>}
              {trip.status === 'failed' && <Tag color="error">生成失败</Tag>}
              {trip.status === 'draft' && <Tag>草稿</Tag>}
            </Space>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">
                {trip.cityName} · {trip.startDate.slice(0, 10)} 出发 · {trip.days} 天 ·{' '}
                {trip.travelers} 人
                {trip.stayName ? ` · 住宿：${trip.stayName}` : ' · 住宿未确定'}
              </Typography.Text>
            </div>
          </div>
          <Button onClick={() => navigate('/trips')}>返回列表</Button>
        </Space>

        {trip.status === 'generating' && (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            title={`AI 正在排程：${trip.genProgress || '准备中'}${
              trip.genDayIndex ? `（已完成 ${trip.genDayIndex}/${trip.days} 天）` : ''
            }`}
            description="排好的天会实时出现在下方，生成完成前打卡按钮暂时关闭。"
          />
        )}
        {trip.status === 'failed' && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            title="这次生成没有完成"
            description={trip.genError ?? '生成失败，已排好的天不受影响。可回到新建流程重新触发。'}
          />
        )}
      </Card>

      {trip.tripDays.length === 0 ? (
        <Card>
          <Empty description="这个行程还没有排好的天。生成完成后就能在这里看到每日安排。" />
        </Card>
      ) : (
        <Row gutter={16} align="top">
          {/* ---- 左列：线圈本。每天的景点是贴在纸页上的便利贴 ----
              左右各占 12 格（等宽）：两张纸的标题栏宽度必须一致，
              11/13 的分法会让它们一宽一窄，视觉上像没对齐 */}
          <Col xs={24} lg={12} data-testid="day-column">
            <div
              className="notebook"
              style={{ height: 'calc(100vh - 248px)', display: 'flex', flexDirection: 'column' }}
            >
              {/* 左侧那排金属线圈，让它一眼就是个本子 */}
              <NotebookRings count={ringCount} />

              {/* 本子的抬头 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '16px 18px 6px 0',
                  flexShrink: 0,
                }}
              >
                <Typography.Title level={5} style={{ margin: 0 }}>
                  每日安排
                </Typography.Title>
                {dayItems.length > 0 && (
                  <Typography.Text type="secondary" data-testid="checkin-progress">
                    已打卡 {checkedCount}/{dayItems.length}
                  </Typography.Text>
                )}
              </div>

              {/* 可滚动区。右边距留够，内容不会贴着纸边 */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 18px 20px 0' }}>
                {/* 天数切换。label 里带日期与当天打卡进度 */}
                <Space orientation="horizontal" wrap size={6} style={{ marginBottom: 14 }}>
                  {trip.tripDays.map((d) => {
                    const total = d.items.length
                    const done = d.items.filter((item) => item.checkedAt).length
                    const isActive = d.dayIndex === activeDay
                    return (
                      <Button
                        key={d.dayIndex}
                        size="small"
                        data-testid={`day-tab-${d.dayIndex}`}
                        type={isActive ? 'primary' : 'default'}
                        onClick={() => {
                          setActiveDay(d.dayIndex)
                          setSelectedItemId(null)
                        }}
                      >
                        第 {d.dayIndex} 天
                        {total > 0 && ` · ${done}/${total}`}
                      </Button>
                    )
                  })}
                </Space>

              {day && (
                <div style={{ marginBottom: 12 }}>
                  {/* 天型标记：这一天的结构不同于常规（整天泡乐园、全天徒步、夜爬、恢复日），
                      不标出来用户会以为排漏了 */}
                  {day.dayType && day.dayType !== 'normal' && (
                    <div style={{ marginBottom: 6 }}>
                      <Tag color={DAY_TYPE_COLOR[day.dayType] ?? 'default'}>
                        {DAY_TYPE_LABEL[day.dayType]}
                      </Tag>
                      {day.intensity === 'light' && <Tag color="cyan">节奏轻松</Tag>}
                    </div>
                  )}
                  {day.summary && (
                    <Typography.Paragraph style={{ marginBottom: 4 }} strong>
                      {day.summary}
                    </Typography.Paragraph>
                  )}
                  {day.weather?.casts?.[0] && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {dayjs(day.date).format('M月D日')} · {day.weather.casts[0].dayWeather}{' '}
                      {day.weather.casts[0].dayTemp}°C / 夜间 {day.weather.casts[0].nightWeather}{' '}
                      {day.weather.casts[0].nightTemp}°C
                    </Typography.Text>
                  )}
                </div>
              )}

              {dayItems.length === 0 ? (
                <Empty description="这一天还没排好" />
              ) : (
                groups.map((group, groupIndex) => (
                  // key 不能只用 slot：一天里可能出现两段不连续的同名时段
                  // （例如中午一顿饭、晚上夜市又是一段 noon），会撞 React key
                  <div key={`${group.slot}-${groupIndex}`} style={{ marginBottom: 8 }}>
                    <Typography.Text type="secondary" strong style={{ fontSize: 12 }}>
                      {SLOT_LABEL[group.slot] ?? group.slot}
                    </Typography.Text>

                    {group.items.map((item) => {
                      const done = Boolean(item.checkedAt)
                      const isTarget = item.id === currentTargetId && !done
                      const isSelected = item.id === selectedItemId
                      const segment = segmentText(item)

                      return (
                        <StickyNote
                          key={item.id}
                          index={noteIndex.get(item.id) ?? 0}
                          data-testid="trip-item"
                          data-checked={done ? 'true' : 'false'}
                          onClick={() => selectItem(item)}
                          style={{
                            // 上方留出胶带的位置：胶带是 top:-9px 的，不留就会被标题压住
                            margin: '17px 0 12px',
                            padding: '14px 13px 11px',
                            // 选中的那张用主色描边加粗，告诉用户地图正在跟着它
                            border: isSelected
                              ? `1.5px solid ${note.ink}`
                              : `1px solid ${note.rule}`,
                            // 已打卡的便利贴像被翻过去一样压暗
                            opacity: done ? 0.62 : 1,
                            cursor: 'pointer',
                          }}
                        >
                          {/* 标题行：名称 + 一排状态标签 */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {/* 打卡状态圆点：未打卡空心 / 已打卡实心带对勾 / 当前目标脉冲 */}
                            {done ? (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  width: 18,
                                  height: 18,
                                  borderRadius: '50%',
                                  background: token.colorSuccess,
                                  color: '#fff',
                                  fontSize: 11,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                }}
                              >
                                ✓
                              </span>
                            ) : (
                              <span
                                style={{
                                  display: 'inline-block',
                                  width: 12,
                                  height: 12,
                                  borderRadius: '50%',
                                  border: `2px solid ${token.colorPrimary}`,
                                  flexShrink: 0,
                                  animation: isTarget ? 'amap-pulse 1.6s ease-out infinite' : undefined,
                                }}
                              />
                            )}

                            <Typography.Text
                              strong
                              style={{
                                textDecoration: done ? 'line-through' : undefined,
                                color: note.ink,
                              }}
                              className="trip-item-title"
                              data-testid="trip-item-title"
                            >
                              {item.name}
                            </Typography.Text>
                            <NoteTag ink={note.ink} rule={note.rule}>
                              {item.itemType === 'restaurant' ? '餐厅' : '景点'}
                            </NoteTag>
                            {isTarget && (
                              <NoteTag ink={note.ink} rule={note.rule} accent="primary">
                                当前目标
                              </NoteTag>
                            )}
                            {item.rating && (
                              <NoteTag ink={note.ink} rule={note.rule}>
                                ★ {item.rating}
                              </NoteTag>
                            )}
                            {item.cost && (
                              <NoteTag ink={note.ink} rule={note.rule}>
                                人均 ¥{item.cost}
                              </NoteTag>
                            )}
                          </div>

                          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            {/* 左侧信息区 */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ marginTop: 4 }}>
                                <Typography.Text style={{ fontSize: 12, color: note.inkSoft }}>
                                  {[
                                    item.openTimeText || (item.itemType === 'restaurant' ? '营业时间未知' : null),
                                    item.address,
                                    item.tag,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Typography.Text>
                              </div>

                              {item.note && (
                                <div style={{ marginTop: 4 }}>
                                  <Typography.Text style={{ fontSize: 12, color: note.ink }}>
                                    {item.note}
                                  </Typography.Text>
                                </div>
                              )}
                            </div>

                            {/* 右侧照片：有图用高德返回的真实图片，无图用柔和渐变占位。
                                加载失败时隐藏，不留破图图标 */}
                            <ItemPhoto item={item} />
                          </div>

                          <div
                            style={{ marginTop: 8 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Space size={8} wrap>
                              <Button
                                size="small"
                                type={done ? 'default' : 'primary'}
                                danger={done}
                                disabled={trip.status === 'generating'}
                                loading={checkingIds.has(item.id)}
                                data-testid={`checkin-btn-${item.id}`}
                                onClick={() => void toggleCheckin(item)}
                              >
                                {done ? '取消打卡' : '打卡'}
                              </Button>
                              {done && item.checkedAt && (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  打卡于 {dayjs(item.checkedAt).format('HH:mm')}
                                </Typography.Text>
                              )}
                              {/* 换一个：看过评价不满意时，在可行距离内换同类型的景点或餐厅。
                                  主题乐园整天、爬山这类天型会先弹确认，因为它们换掉会改变当天结构 */}
                              <Button
                                size="small"
                                data-testid={`swap-btn-${item.id}`}
                                icon={<SwapOutlined />}
                                disabled={trip.status === 'generating'}
                                onClick={() => void openAlternatives(item)}
                              >
                                换一个
                              </Button>
                              {/* 小红书攻略：只做关键词跳转搜索页，不抓取任何内容。
                                  点击在浏览器新标签打开该地点的攻略搜索结果 */}
                              <Button
                                size="small"
                                data-testid={`xhs-btn-${item.id}`}
                                icon={<BookOutlined />}
                                style={{ color: '#ff2442', borderColor: 'rgba(255,36,66,.45)' }}
                                onClick={() => openXiaohongshu(item.name)}
                              >
                                小红书攻略
                              </Button>
                            </Space>
                          </div>

                          {segment && (
                            <div style={{ marginTop: 6 }}>
                              <Typography.Text style={{ fontSize: 12, color: note.inkSoft }}>
                                ↓ {segment}
                              </Typography.Text>
                            </div>
                          )}
                        </StickyNote>
                      )
                    })}
                  </div>
                ))
              )}

                {/* 这句写在纸页上（不在便利贴里），所以用 page.* 的墨色：
                    便利贴恒为浅底深墨、纸页跟着主题走，两者不能用同一套 */}
                {dayItems.length > 0 && (
                  <Typography.Text style={{ fontSize: 12, color: page.inkSoft }}>
                    营业时间、价格与开放状态由 AI 整理，请以实际为准。点击条目可在右侧地图定位。
                  </Typography.Text>
                )}
              </div>
            </div>
          </Col>

          {/* ---- 右列：地图联动。整列固定在视口内，滚动时不动 ----
              与左列等宽（12/12），保证两个标题栏宽度一致 */}
          <Col
            xs={24}
            lg={12}
            data-testid="route-panel"
            style={{
              // 与左列同高，且用 sticky 钉在视口顶部：
              // 左列内部滚动时右列不跟着动，地图始终可见
              position: 'sticky',
              top: 0,
              height: 'calc(100vh - 248px)',
            }}
          >
            <Card
              // 标题用「日期 + 当日路线」而不是孤零零的「当日路线」，
              // 这样它能和左边「每日安排」的标题栏视觉宽度对齐（都在卡片顶部同一行）
              title={day ? `${dayjs(day.date).format('M月D日')} 当日路线` : '当日路线'}
              style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
              styles={{
                body: {
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  // 收紧内边距，把地图往上提，腾出一屏的空间
                  paddingTop: 12,
                },
              }}
              extra={
                <Radio.Group
                  size="small"
                  value={routeMode}
                  onChange={(e) => setRouteMode(e.target.value as RouteMode)}
                  optionType="button"
                  options={ROUTE_MODES.map((m) => ({ label: m.label, value: m.value }))}
                />
              }
            >
              {/* 地图高度按视口算：卡片可用高度减去卡片头部、底部说明与内边距，
                  让地图自适应剩余空间。写死像素值在小屏上会溢出到屏幕外 */}
              <div style={{ flex: 1, minHeight: 260 }}>
                <AmapMap
                  center={mapCenter}
                  zoom={14}
                  markers={markers}
                  polyline={mapPolyline}
                  onMarkerClick={(markerId) => setSelectedItemId(markerId === '__stay__' ? null : markerId)}
                  height={mapHeight}
                  fitToContent
                />
              </div>

              <div style={{ marginTop: 8 }}>
                {routeLoading && (
                  <Space size={8}>
                    <Spin size="small" />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      正在从高德获取真实路线…
                    </Typography.Text>
                  </Space>
                )}
                {!routeLoading && routeWarn && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    {routeWarn}
                  </Typography.Text>
                )}
                {!routeLoading && !routeWarn && routes.length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    路线为高德路径规划的真实道路，非直线距离。
                    {trip.stayName ? `从「${trip.stayName}」出发，末站后返回住处。` : ''}
                  </Typography.Text>
                )}
              </div>

              {trip.stayResolved && trip.stayName && (
                <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
                  住宿锚点：{trip.stayName}
                </Typography.Text>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* ---- 换一个：候选抽屉 ---- */}
      <Drawer
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        // antd 6 用 size 表达抽屉宽度，旧的 width 已弃用
        size="default"
        title={swapTarget ? `替换「${swapTarget.name}」` : '替换地点'}
        data-testid="swap-drawer"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          以下候选都在可行距离内（与前后两站的通勤各不超过 40 分钟），
          且评分与营业时间符合这一天的时段要求。换掉后当天顺序不变。
          {swapIsFirst && ' 这是当天第一站，所以上一站按住宿算。'}
          {swapIsLast && ' 这是当天最后一站，所以下一站按住宿算（要考虑回程）。'}
        </Typography.Paragraph>

        {candidatesLoading && (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <Spin />
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                正在查询附近符合条件的候选，并核对通勤时间…
              </Typography.Text>
            </div>
          </div>
        )}

        {!candidatesLoading && candidatesError && (
          <Alert type="error" showIcon title="查询失败" description={candidatesError} />
        )}

        {!candidatesLoading && !candidatesError && candidates.length === 0 && (
          <Empty
            description={
              <span style={{ fontSize: 13 }}>
                附近没有符合条件的替换地点
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  可能是这一带同类地点较少，或评分都低于 4 分。
                </Typography.Text>
              </span>
            }
          />
        )}

        {!candidatesLoading &&
          candidates.map((candidate) => (
            <div
              key={candidate.poiId}
              data-testid="swap-candidate"
              style={{
                display: 'flex',
                gap: 10,
                padding: 12,
                marginBottom: 10,
                borderRadius: token.borderRadius,
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              {/* 候选缩略图。没有图时留一个安静的占位块 */}
              {candidate.photos.length > 0 ? (
                <img
                  src={candidate.photos[0]}
                  alt={candidate.name}
                  style={{
                    width: 56,
                    height: 56,
                    flexShrink: 0,
                    objectFit: 'cover',
                    borderRadius: 8,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 56,
                    height: 56,
                    flexShrink: 0,
                    borderRadius: 8,
                    background: token.colorFillSecondary,
                  }}
                />
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {candidate.name}
                </Typography.Text>

                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {candidate.rating && (
                    <Tag color={Number(candidate.rating) >= 4.5 ? 'green' : 'default'}>
                      评分 {candidate.rating}
                    </Tag>
                  )}
                  {candidate.cost && <Tag>人均 ¥{candidate.cost}</Tag>}
                </div>

                <div style={{ marginTop: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {/* 通勤时间是真实路径规划的结果，用户最关心的就是这个。
                        首/末站的邻站是住宿，文案要跟着说「住处」，否则用户会以为算错了 */}
                    {candidate.commuteFromPrevMinutes !== null
                      ? `${swapIsFirst ? '距住处' : '距上一站'}约 ${candidate.commuteFromPrevMinutes} 分钟`
                      : `${swapIsFirst ? '距住处' : '距上一站'}约 ${candidate.distanceFromPrevKm} km`}
                    {candidate.commuteToNextMinutes !== null &&
                      ` · ${swapIsLast ? '回住处' : '到下一站'}约 ${candidate.commuteToNextMinutes} 分钟`}
                  </Typography.Text>
                </div>

                {candidate.openTimeText && (
                  <div style={{ marginTop: 2 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {candidate.openTimeText}
                    </Typography.Text>
                  </div>
                )}

                <Button
                  size="small"
                  type="primary"
                  style={{ marginTop: 8 }}
                  loading={replacingPoiId === candidate.poiId}
                  disabled={replacingPoiId !== null && replacingPoiId !== candidate.poiId}
                  data-testid={`apply-swap-${candidate.poiId}`}
                  onClick={() => void confirmReplace(candidate)}
                >
                  换成这个
                </Button>
              </div>
            </div>
          ))}
      </Drawer>
    </div>
  )
}
