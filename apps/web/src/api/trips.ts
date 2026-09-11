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
  openTimeText: string | null
  note: string | null
  /** 打卡时间。null 表示未打卡 */
  checkedAt: string | null
}

/** 行程中的某一天 */
export interface TripDayData {
  id: string
  dayIndex: number
  date: string
  /** 高德天气预报，超出预报窗口时为 null */
  weather: WeatherResult | null
  summary: string | null
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
