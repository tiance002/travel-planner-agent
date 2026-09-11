// 高德能力的调用封装。
//
// 前端永远不直接请求高德，而是调自家的 /api/amap/*，
// 由后端带上 Web 服务 Key 去请求并把结果归一化后返回。
// 这样做的好处是 Key 不出服务端，同时前端拿到的字段是稳定的。

import { api } from './client'

/** 地理编码结果 */
export interface GeocodeResult {
  formattedAddress: string
  province: string
  city: string
  district: string
  /** 行政区划编码，POI 检索与天气查询都依赖它 */
  adcode: string
  citycode: string
  lng: number
  lat: number
}

/** 归一化后的地点。所有字段都来自高德返回值 */
export interface Poi {
  poiId: string
  name: string
  lng: number
  lat: number
  address: string
  type: string
  typecode: string
  cityName: string
  district: string
  adcode: string
  rating: number | null
  cost: number | null
  tag: string
  keytag: string
  openTimeToday: string
  openTimeWeek: string
  tel: string
  photos: string[]
  distance: number | null
}

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

export type RouteMode = 'driving' | 'walking' | 'bicycling' | 'transit'

export interface RouteResult {
  mode: RouteMode
  distance: number
  duration: number
  taxiCost: number | null
  polyline: string
  steps: string[]
}

/** 高德 POI 分类编码。编码含义见高德官方「POI 分类编码表」 */
export const POI_TYPE = {
  /** 住宿服务（酒店、民宿等） */
  hotel: '100000',
  /** 餐饮服务 */
  restaurant: '050000',
  /** 风景名胜 */
  attraction: '110000',
} as const

/** 地址解析成经纬度与行政区划编码 */
export async function geocode(address: string, city?: string): Promise<GeocodeResult> {
  const { data } = await api.get<{ result: GeocodeResult }>('/amap/geocode', {
    params: { address, city },
  })
  return data.result
}

/** 经纬度反查地址 */
export async function regeocode(lng: number, lat: number) {
  const { data } = await api.get<{ result: { formattedAddress: string; city: string; district: string; adcode: string } }>(
    '/amap/regeo',
    { params: { lng, lat } },
  )
  return data.result
}

/** POI 关键字搜索 */
export async function searchPoiText(params: {
  keywords: string
  region?: string
  types?: string
  pageSize?: number
  pageNum?: number
}): Promise<Poi[]> {
  const { data } = await api.get<{ pois: Poi[] }>('/amap/poi/text', { params })
  return data.pois
}

/** POI 周边搜索，结果带 distance 字段 */
export async function searchPoiAround(params: {
  lng: number
  lat: number
  keywords?: string
  types?: string
  radius?: number
  sortRule?: 'distance' | 'weight'
  pageSize?: number
  pageNum?: number
}): Promise<Poi[]> {
  const { data } = await api.get<{ pois: Poi[] }>('/amap/poi/around', { params })
  return data.pois
}

/** 城市天气预报。高德仅提供约 4 天，超出窗口时 casts 为空数组 */
export async function getWeather(adcode: string): Promise<WeatherResult | null> {
  const { data } = await api.get<{ weather: WeatherResult | null }>('/amap/weather', {
    params: { adcode },
  })
  return data.weather
}

/** 按 poiId 兜底查 POI 详情照片（给旧行程条目补图用）。查不到返回空数组 */
export async function fetchPoiPhotos(poiId: string): Promise<string[]> {
  const { data } = await api.get<{ photos: string[] }>('/amap/poi/photos', {
    params: { poiId },
  })
  return data.photos
}

/** 路径规划，返回真实距离、耗时与可绘制的路线折线 */
export async function planRoute(params: {
  mode: RouteMode
  originLng: number
  originLat: number
  destLng: number
  destLat: number
  city1?: string
  city2?: string
}): Promise<RouteResult> {
  const { data } = await api.get<{ route: RouteResult }>('/amap/direction', { params })
  return data.route
}
