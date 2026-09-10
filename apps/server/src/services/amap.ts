// 高德（Amap）Web 服务 API 封装。
//
// 设计约定：
//   1. 高德接口地址、参数拼装、返回字段解析只出现在本文件，其他模块拿到的是归一化结果。
//   2. Web 服务 Key 只在服务端使用，绝不出现在响应里下发给前端。
//   3. 任何日志都不允许打印完整请求 URL —— 它带有 Key，一旦记进日志就等于泄漏。
//
// 高德 Web 服务 API 的返回约定：status 为 "1" 表示成功，
// 为 "0" 表示业务失败（例如 Key 无效、配额耗尽、参数错误），失败原因在 info / infocode 里。

import { config } from '../config'
import { cached, TTL } from './cache'

const BASE_URL = 'https://restapi.amap.com'

/** 单次请求超时时间（毫秒） */
const TIMEOUT_MS = 12_000

/** 网络层失败时的额外重试次数。高德接口偶发连接中断，重试一次基本可解 */
const MAX_RETRIES = 2

/** 高德业务错误（Key 失效、配额耗尽、参数不合法等），重试无意义 */
export class AmapError extends Error {
  readonly infocode: string

  constructor(message: string, infocode = '') {
    super(message)
    this.name = 'AmapError'
    this.infocode = infocode
  }
}

/** 网络层错误（连接中断、超时、HTTP 非 2xx），可重试 */
class RetryableError extends Error {}

/** 高德响应公共字段 */
interface AmapEnvelope {
  status: string
  info: string
  infocode: string
}

/** 请求参数。为 undefined 或空字符串时会被自动忽略 */
type QueryParams = Record<string, string | number | undefined>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
/** 取出 Web 服务 Key。没配置时给出可操作的提示，而不是让它以奇怪的错误收场 */
function webServiceKey(): string {
  const key = config.amapWebServiceKey
  if (!key) {
    throw new AmapError('未配置高德 Web 服务 Key，请在 apps/server/.env 中填写 AMAP_WEB_SERVICE_KEY')
  }
  return key
}

/**
 * 发起一次高德请求并解析响应。
 * 注意：参数里可以出现 Key，所以函数内部绝不打印 url。
 */
async function call<T extends AmapEnvelope>(path: string, params: QueryParams): Promise<T> {
  const url = new URL(BASE_URL + path)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    url.searchParams.set(k, String(v))
  }
  url.searchParams.set('key', webServiceKey())

  const requestOnce = async (): Promise<T> => {
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      // 连接中断或超时，属于可重试的网络问题
      throw new RetryableError('高德接口连接失败或超时')
    }
    if (!response.ok) {
      throw new RetryableError(`高德接口返回 HTTP ${response.status}`)
    }

    let json: T
    try {
      json = (await response.json()) as T
    } catch {
      throw new RetryableError('高德接口返回内容不是合法 JSON')
    }

    if (json.status !== '1') {
      // 业务错误：把 info 与 infocode 一起抛出，便于排查是 Key 问题还是参数问题
      throw new AmapError(`高德接口错误：${json.info || '未知原因'}`, json.infocode)
    }
    return json
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestOnce()
    } catch (err) {
      lastError = err
      // 业务错误直接抛出，不做无意义的重试
      if (!(err instanceof RetryableError)) throw err
      if (attempt < MAX_RETRIES) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new AmapError('高德接口请求失败')
}

/** 把 "116.41,39.90" 这样的字符串拆成经纬度 */
function parseLocation(value: string | undefined): { lng: number; lat: number } | null {
  if (!value) return null
  const [lngRaw, latRaw] = value.split(',')
  const lng = Number(lngRaw)
  const lat = Number(latRaw)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lng, lat }
}

/** 把高德返回的字符串数字转成 number，空值或非法值返回 null */
function parseNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// 地理编码
// ---------------------------------------------------------------------------

/** 归一化后的地理编码结果 */
export interface GeocodeResult {
  formattedAddress: string
  province: string
  city: string
  district: string
  /** 高德行政区划编码，POI 检索与天气查询都用它 */
  adcode: string
  citycode: string
  lng: number
  lat: number
}

interface RawGeocode extends AmapEnvelope {
  geocodes?: {
    formatted_address?: string
    province?: string | string[]
    city?: string | string[]
    district?: string | string[]
    adcode?: string
    citycode?: string
    location?: string
  }[]
}

/** 把地址解析成经纬度与行政区划编码。找到多个结果时取第一个 */
export async function geocode(address: string, city?: string): Promise<GeocodeResult | null> {
  const key = `geocode:${city ?? ''}:${address}`
  return cached(key, TTL.geocode, async () => {
    const json = await call<RawGeocode>('/v3/geocode/geo', { address, city })
    const first = json.geocodes?.[0]
    if (!first) return null

    const loc = parseLocation(first.location)
    if (!loc) return null

    // 高德在直辖市场景下会把 province 返回成空数组，这里统一成字符串
    const pick = (v: string | string[] | undefined): string =>
      Array.isArray(v) ? (v[0] ?? '') : (v ?? '')

    return {
      formattedAddress: first.formatted_address ?? '',
      province: pick(first.province),
      city: pick(first.city),
      district: pick(first.district),
      adcode: first.adcode ?? '',
      citycode: first.citycode ?? '',
      lng: loc.lng,
      lat: loc.lat,
    } satisfies GeocodeResult
  })
}

/** 归一化后的逆地理编码结果 */
export interface RegeocodeResult {
  formattedAddress: string
  province: string
  city: string
  district: string
  adcode: string
}

interface RawRegeocode extends AmapEnvelope {
  regeocode?: {
    formatted_address?: string
    addressComponent?: {
      province?: string
      city?: string | string[]
      district?: string
      adcode?: string
    }
  }
}

/** 把经纬度反查成地址，用于把地图上点选的位置转成可读地名 */
export async function regeocode(lng: number, lat: number): Promise<RegeocodeResult | null> {
  const key = `regeo:${lng},${lat}`
  return cached(key, TTL.geocode, async () => {
    const json = await call<RawRegeocode>('/v3/geocode/regeo', { location: `${lng},${lat}` })
    const comp = json.regeocode?.addressComponent
    if (!json.regeocode || !comp) return null

    const city = Array.isArray(comp.city) ? (comp.city[0] ?? '') : (comp.city ?? '')
    return {
      formattedAddress: json.regeocode.formatted_address ?? '',
      province: comp.province ?? '',
      city,
      district: comp.district ?? '',
      adcode: comp.adcode ?? '',
    } satisfies RegeocodeResult
  })
}

// ---------------------------------------------------------------------------
// POI 搜索
// ---------------------------------------------------------------------------

/** 归一化后的 POI。前端与 AI 都只认这个结构 */
export interface Poi {
  poiId: string
  name: string
  lng: number
  lat: number
  address: string
  /** 高德分类原文，如「餐饮服务;中餐厅;清真菜馆」 */
  type: string
  typecode: string
  cityName: string
  district: string
  adcode: string
  /** 评分。仅餐饮 / 酒店 / 景点 / 影院类 POI 会返回，其余为 null */
  rating: number | null
  /** 人均消费（元）。同样仅部分分类返回 */
  cost: number | null
  /** 特色内容，美食 POI 下是特色菜列表 */
  tag: string
  /** 招牌品类，如「北京菜」 */
  keytag: string
  /** 今日营业时间，如「06:00-10:00 10:30-21:30」 */
  openTimeToday: string
  /** 整周营业时间 */
  openTimeWeek: string
  tel: string
  photos: string[]
  /** 周边搜索时的直线距离（米）。文本搜索下为 null */
  distance: number | null
}

interface RawPoi {
  id?: string
  name?: string
  location?: string
  address?: string | string[]
  type?: string
  typecode?: string
  pname?: string
  cityname?: string
  adname?: string
  adcode?: string
  distance?: string
  business?: {
    rating?: string
    cost?: string
    tag?: string
    keytag?: string
    opentime_today?: string
    opentime_week?: string
    tel?: string
  }
  photos?: { title?: string; url?: string }[]
}

interface RawPoiSearch extends AmapEnvelope {
  count?: string
  pois?: RawPoi[]
}

/** 把高德原始 POI 转成归一化结构。缺坐标的条目会被上层丢弃 */
function normalizePoi(raw: RawPoi): Poi | null {
  const loc = parseLocation(raw.location)
  if (!loc || !raw.id || !raw.name) return null

  const address = Array.isArray(raw.address) ? (raw.address[0] ?? '') : (raw.address ?? '')

  return {
    poiId: raw.id,
    name: raw.name,
    lng: loc.lng,
    lat: loc.lat,
    address,
    type: raw.type ?? '',
    typecode: raw.typecode ?? '',
    cityName: raw.cityname ?? raw.pname ?? '',
    district: raw.adname ?? '',
    adcode: raw.adcode ?? '',
    rating: parseNumber(raw.business?.rating),
    cost: parseNumber(raw.business?.cost),
    tag: raw.business?.tag ?? '',
    keytag: raw.business?.keytag ?? '',
    openTimeToday: raw.business?.opentime_today ?? '',
    openTimeWeek: raw.business?.opentime_week ?? '',
    tel: raw.business?.tel ?? '',
    // 只保留 http(s) 开头的图片地址，过滤掉高德偶尔返回的空占位
    photos: (raw.photos ?? [])
      .map((p) => p.url ?? '')
      .filter((u) => u.startsWith('http')),
    distance: parseNumber(raw.distance),
  }
}

/** 要取的扩展字段。business 提供评分/人均/营业时间，photos 提供图片 */
const POI_SHOW_FIELDS = 'business,photos,indoor,children'

export interface PoiSearchOptions {
  keywords: string
  /** 检索区域：城市名或 adcode。文本搜索建议传，用于限定范围 */
  region?: string
  /** 分类编码，如 100000 住宿服务、050000 餐饮服务、110000 风景名胜 */
  types?: string
  pageSize?: number
  pageNum?: number
}

/** POI 关键字搜索（高德 v5 版）。返回归一化后的列表 */
export async function searchPoiText(options: PoiSearchOptions): Promise<Poi[]> {
  const pageSize = Math.min(options.pageSize ?? 10, 25)
  const pageNum = options.pageNum ?? 1
  const key = `poiText:${options.keywords}:${options.region ?? ''}:${options.types ?? ''}:${pageNum}:${pageSize}`

  return cached(key, TTL.poi, async () => {
    const json = await call<RawPoiSearch>('/v5/place/text', {
      keywords: options.keywords,
      region: options.region,
      types: options.types,
      city_limit: options.region ? 'true' : undefined,
      page_size: pageSize,
      page_num: pageNum,
      show_fields: POI_SHOW_FIELDS,
    })

    return (json.pois ?? [])
      .map(normalizePoi)
      .filter((p): p is Poi => p !== null)
  })
}

export interface PoiAroundOptions {
  lng: number
  lat: number
  keywords?: string
  types?: string
  /** 检索半径（米），高德上限 50000 */
  radius?: number
  /** 排序规则：distance 按距离 / weight 按权重（综合） */
  sortRule?: 'distance' | 'weight'
  pageSize?: number
  pageNum?: number
}

/** POI 周边搜索（高德 v5 版）。以某个坐标为圆心找附近地点，结果带 distance 字段 */
export async function searchPoiAround(options: PoiAroundOptions): Promise<Poi[]> {
  const pageSize = Math.min(options.pageSize ?? 10, 25)
  const pageNum = options.pageNum ?? 1
  const radius = Math.min(options.radius ?? 2000, 50_000)
  const sortRule = options.sortRule ?? 'weight'
  const key = `poiAround:${options.lng},${options.lat}:${options.keywords ?? ''}:${options.types ?? ''}:${radius}:${sortRule}:${pageNum}:${pageSize}`

  return cached(key, TTL.poi, async () => {
    const json = await call<RawPoiSearch>('/v5/place/around', {
      location: `${options.lng},${options.lat}`,
      keywords: options.keywords,
      types: options.types,
      radius,
      sortrule: sortRule,
      page_size: pageSize,
      page_num: pageNum,
      show_fields: POI_SHOW_FIELDS,
    })

    return (json.pois ?? [])
      .map(normalizePoi)
      .filter((p): p is Poi => p !== null)
  })
}

// ---------------------------------------------------------------------------
// 天气
// ---------------------------------------------------------------------------

/** 单日预报 */
export interface WeatherCast {
  date: string
  week: string
  dayWeather: string
  nightWeather: string
  dayTemp: number | null
  nightTemp: number | null
  dayWind: string
  nightWind: string
  dayPower: string
  nightPower: string
}

export interface WeatherResult {
  city: string
  adcode: string
  reportTime: string
  casts: WeatherCast[]
}

interface RawWeather extends AmapEnvelope {
  forecasts?: {
    city?: string
    adcode?: string
    reporttime?: string
    casts?: {
      date?: string
      week?: string
      dayweather?: string
      nightweather?: string
      daytemp?: string
      nighttemp?: string
      daywind?: string
      nightwind?: string
      daypower?: string
      nightpower?: string
    }[]
  }[]
}

/**
 * 查询城市天气预报。
 *
 * 重要限制：高德只提供未来约 4 天的预报。行程日期超出这个窗口时，
 * 这里会返回空列表，由上层决定如何降级（例如改用历史同期气候均值）。
 */
export async function getWeather(adcode: string): Promise<WeatherResult | null> {
  const key = `weather:${adcode}`
  return cached(key, TTL.weather, async () => {
    const json = await call<RawWeather>('/v3/weather/weatherInfo', {
      city: adcode,
      extensions: 'all',
    })

    const forecast = json.forecasts?.[0]
    if (!forecast) return null

    return {
      city: forecast.city ?? '',
      adcode: forecast.adcode ?? adcode,
      reportTime: forecast.reporttime ?? '',
      casts: (forecast.casts ?? []).map((c) => ({
        date: c.date ?? '',
        week: c.week ?? '',
        dayWeather: c.dayweather ?? '',
        nightWeather: c.nightweather ?? '',
        dayTemp: parseNumber(c.daytemp),
        nightTemp: parseNumber(c.nighttemp),
        dayWind: c.daywind ?? '',
        nightWind: c.nightwind ?? '',
        dayPower: c.daypower ?? '',
        nightPower: c.nightpower ?? '',
      })),
    } satisfies WeatherResult
  })
}

// ---------------------------------------------------------------------------
// 路径规划
// ---------------------------------------------------------------------------

/** 出行方式 */
export type RouteMode = 'driving' | 'walking' | 'bicycling' | 'transit'

export interface RouteResult {
  mode: RouteMode
  /** 总距离（米） */
  distance: number
  /** 预计耗时（秒） */
  duration: number
  /** 打车参考价（元），仅驾车返回 */
  taxiCost: number | null
  /**
   * 路线折线，格式为「lng,lat;lng,lat;...」，可直接交给地图画线。
   * 这是高德规划出的真实路线，不是两点之间的直线，务必用它而不是自己连直线。
   */
  polyline: string
  /** 驾车方案的文字导航步骤，供 AI 写「怎么去」参考 */
  steps: string[]
}

/** 把高德路径结果里各段的 polyline 拼成一条完整折线 */
function joinPolylines(parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p))
    .join(';')
    .replace(/;;+/g, ';')
}

interface RawDirection extends AmapEnvelope {
  route?: {
    origin?: string
    destination?: string
    distance?: string
    taxi_cost?: string
    paths?: {
      distance?: string
      cost?: { duration?: string }
      steps?: { instruction?: string; polyline?: string }[]
    }[]
    transits?: {
      distance?: string
      cost?: { duration?: string }
      segments?: {
        walking?: { steps?: { polyline?: string }[] }
        bus?: { buslines?: { polyline?: string }[] }
        taxi?: { polyline?: string }
      }[]
    }[]
  }
}

export interface PlanRouteOptions {
  mode: RouteMode
  originLng: number
  originLat: number
  destLng: number
  destLat: number
  /** 公交规划必填：起终点所在城市的城市编码，如北京的 010 */
  city1?: string
  city2?: string
}

/**
 * 路径规划。返回真实距离、耗时与可绘制路线。
 *
 * 说明：驾车与步行/骑行返回的是路径折线；公交由多段（步行 + 乘车）拼接而成，
 * 中间可能因数据缺失而略微不连续，但整体走向可用于展示。
 */
export async function planRoute(options: PlanRouteOptions): Promise<RouteResult> {
  const { mode, originLng, originLat, destLng, destLat } = options
  const origin = `${originLng},${originLat}`
  const destination = `${destLng},${destLat}`
  const key = `route:${mode}:${origin}:${destination}:${options.city1 ?? ''}`

  return cached(key, TTL.direction, async () => {
    if (mode === 'transit') {
      const json = await call<RawDirection>('/v5/direction/transit/integrated', {
        origin,
        destination,
        city1: options.city1,
        city2: options.city2 ?? options.city1,
      })
      const transit = json.route?.transits?.[0]
      const parts: (string | undefined)[] = []
      for (const segment of transit?.segments ?? []) {
        for (const step of segment.walking?.steps ?? []) parts.push(step.polyline)
        for (const line of segment.bus?.buslines ?? []) parts.push(line.polyline)
        parts.push(segment.taxi?.polyline)
      }

      return {
        mode,
        distance: parseNumber(transit?.distance) ?? parseNumber(json.route?.distance) ?? 0,
        duration: parseNumber(transit?.cost?.duration) ?? 0,
        taxiCost: null,
        polyline: joinPolylines(parts),
        steps: [],
      } satisfies RouteResult
    }

    // 驾车 / 步行 / 骑行三者返回结构一致，只是路径不同
    const path = mode === 'driving' ? '/v5/direction/driving' : `/v5/direction/${mode}`
    const json = await call<RawDirection>(path, {
      origin,
      destination,
      show_fields: 'cost,polyline',
    })

    const route = json.route?.paths?.[0]
    return {
      mode,
      distance: parseNumber(route?.distance) ?? 0,
      duration: parseNumber(route?.cost?.duration) ?? 0,
      taxiCost: parseNumber(json.route?.taxi_cost),
      polyline: joinPolylines((route?.steps ?? []).map((s) => s.polyline)),
      steps: (route?.steps ?? [])
        .map((s) => s.instruction ?? '')
        .filter((s) => s !== ''),
    } satisfies RouteResult
  })
}

/** 两点之间的直线距离（米），用于每日行程的粗筛与聚类，不消耗配额 */
export function straightLineDistance(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const EARTH_RADIUS = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * EARTH_RADIUS * Math.asin(Math.sqrt(h)))
}
