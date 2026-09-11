// 行程数据的调用封装：详情、打卡、取消打卡。

import { api } from './client'
import type { WeatherResult } from './amap'

/** 行程条目：景点或餐厅，坐标与营业信息均来自高德 */
export interface TripItemData {
  id: string
  tripDayId: string
  orderIndex: number
  /** 时段：morning / noon / afternoon / evening */
  slot: string
  /** spot 景点 / restaurant 餐厅 */
  itemType: string
  poiId: string | null
  name: string
  lng: number | null
  lat: number | null
  address: string | null
  tel: string | null
  rating: string | null
  cost: string | null
  tag: string | null
  /** 高德分类编码。用于判断是不是餐厅、以及替换时找同类型候选 */
  typecode: string | null
  openTimeText: string | null
  note: string | null
  /** 景点照片 URL 列表（高德 POI 返回，最多 3 张） */
  photos: string[]
  /** 打卡时间。null 表示未打卡 */
  checkedAt: string | null
}

/** 行程体裁：常规 / 主题乐园整天 / 高强度徒步 / 夜爬看日出 / 恢复日 */
export type DayType = 'normal' | 'theme_park' | 'hike' | 'night_hike' | 'recovery'

/** 各天型的展示文案与配色标识，前端多处共用 */
export const DAY_TYPE_LABEL: Record<DayType, string> = {
  normal: '',
  theme_park: '主题乐园整天',
  hike: '全天徒步',
  night_hike: '夜爬看日出',
  recovery: '轻松恢复日',
}

/** 行程中的某一天 */
export interface TripDayData {
  id: string
  dayIndex: number
  date: string
  /** 高德天气预报，超出预报窗口时为 null */
  weather: WeatherResult | null
  summary: string | null
  /** 这一天的行程体裁。老数据可能没有这个字段，前端要按 normal 兜底 */
  dayType?: DayType
  /** 体力强度：light / medium / heavy */
  intensity?: string
  items: TripItemData[]
}

/** 行程完整详情 */
export interface TripDetailData {
  id: string
  title: string
  cityName: string
  cityAdcode: string
  startDate: string
  days: number
  travelers: number
  preferences: string[]
  extraNeeds: string[]
  budgetAmount: number | null
  budgetScope: string
  stayResolved: boolean
  stayPoiId: string | null
  stayName: string | null
  stayLng: number | null
  stayLat: number | null
  status: string
  genProgress: string | null
  genDayIndex: number | null
  genError: string | null
  tripDays: TripDayData[]
}

/** 获取行程详情（含每日条目） */
export async function getTrip(id: string): Promise<TripDetailData> {
  const { data } = await api.get<{ trip: TripDetailData }>(`/trips/${id}`)
  return data.trip
}

/** 到点打卡 */
export async function checkinItem(tripId: string, itemId: string): Promise<string> {
  const { data } = await api.post<{ checkedAt: string }>(`/trips/${tripId}/items/${itemId}/checkin`)
  return data.checkedAt
}

/** 取消打卡 */
export async function uncheckinItem(tripId: string, itemId: string): Promise<void> {
  await api.delete(`/trips/${tripId}/items/${itemId}/checkin`)
}

/** 「换一个」的候选地点。距离与通勤都是真实路径规划算出来的，不是直线距离 */
export interface AlternativeCandidate {
  poiId: string
  name: string
  lng: number
  lat: number
  address: string | null
  rating: string | null
  cost: string | null
  tag: string | null
  typecode: string | null
  openTimeText: string | null
  photos: string[]
  /** 与上一个地点之间的直线距离，公里，保留一位小数 */
  distanceFromPrevKm: number
  /** 与上一个地点之间的真实通勤分钟数。算不出来时为 null */
  commuteFromPrevMinutes: number | null
  /** 与下一个地点之间的真实通勤分钟数。没有下一个地点时为 null */
  commuteToNextMinutes: number | null
}

/** 查询某个条目的替换候选 */
export async function getItemAlternatives(
  tripId: string,
  itemId: string,
): Promise<{ candidates: AlternativeCandidate[]; currentPoiId: string | null }> {
  const { data } = await api.get<{
    candidates: AlternativeCandidate[]
    currentPoiId: string | null
  }>(`/trips/${tripId}/items/${itemId}/alternatives`)
  return data
}

/** 把某个条目换成指定候选 */
export async function replaceItem(
  tripId: string,
  itemId: string,
  poiId: string,
): Promise<TripItemData> {
  const { data } = await api.patch<{ item: TripItemData }>(
    `/trips/${tripId}/items/${itemId}/replace`,
    { poiId },
  )
  return data.item
}
