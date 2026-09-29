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

/** 生成运行阶段；commit 阶段表示内容已生成但持久化边界需要重试。 */
export type GenerationRunPhase =
  | 'running'
  | 'waiting'
  | 'reviewing'
  | 'recovery'
  | 'commit_pending'
  | null

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
  /** 生成运行阶段：running 执行中、waiting 等待裁决、recovery 需要人工取消后补缺 */
  genRunPhase: GenerationRunPhase
  /** 当前待裁决卡片的不可复用标识，提交裁决时必须原样带回 */
  genReviewId: string | null
  /** 当前待裁决内容（JSON 字符串），刷新后仍可恢复操作 */
  genReview: string | null
  /** 生成运行配置。前端只展示状态，不用客户端值覆盖服务端配置。 */
  genRunConfig: string | null
  /** 生成过程中自动修正的规则提示（通勤超时换点、天型降档等），后端已去重 */
  genWarnings?: string[]
  /** 服务端按真实落库日期计算的完成数 */
  completedDayCount: number
  /** 服务端按 1..days 计算出的缺失日期索引 */
  missingDayIndexes: number[]
  tripDays: TripDayData[]
}

/** 图版人工裁决卡片上的候选方案（来自服务端已验证的数据） */
export interface ReviewCandidate {
  label: 'A' | 'B'
  summary: string
  ratingAvg: number
  commuteMinutes: number | null
  transitMinutes: number | null
  spotCount: number
  pros: string[]
  cons: string[]
}

/** 服务端 interrupt 持久化到 genReview 的展示载荷 */
export interface GenerationReviewRequest {
  kind: 'confirm' | 'choose'
  dayIndex: number
  totalDays: number
  summary?: string
  candidates?: ReviewCandidate[]
}

function isReviewCandidate(value: unknown): value is ReviewCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ReviewCandidate>
  return (
    (candidate.label === 'A' || candidate.label === 'B') &&
    typeof candidate.summary === 'string' &&
    typeof candidate.ratingAvg === 'number' &&
    (candidate.commuteMinutes === null || typeof candidate.commuteMinutes === 'number') &&
    (candidate.transitMinutes === null || typeof candidate.transitMinutes === 'number') &&
    typeof candidate.spotCount === 'number' &&
    Array.isArray(candidate.pros) &&
    candidate.pros.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.cons) &&
    candidate.cons.every((item) => typeof item === 'string')
  )
}

/**
 * 解析服务端待裁决载荷。
 *
 * genReview 是持久化 JSON，可能来自旧数据或异常中断；不满足最小结构时
 * 直接按「没有可安全操作的卡片」处理，避免让用户点击一个不能被服务端接受的动作。
 */
export function parseGenerationReview(value: string | null | undefined): GenerationReviewRequest | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<GenerationReviewRequest>
    if (
      (parsed.kind !== 'confirm' && parsed.kind !== 'choose') ||
      !Number.isInteger(parsed.dayIndex) ||
      !Number.isInteger(parsed.totalDays)
    ) {
      return null
    }
    if (
      parsed.kind === 'choose' &&
      (!Array.isArray(parsed.candidates) ||
        parsed.candidates.length !== 2 ||
        !parsed.candidates.every((candidate) => isReviewCandidate(candidate)))
    ) {
      return null
    }
    return parsed as GenerationReviewRequest
  } catch {
    return null
  }
}

/** 只接受合法范围内的服务端派生完成数；旧响应回退到真实日期集合。 */
export function getCompletedDayCount(trip: {
  days: number
  completedDayCount?: number | null
  tripDays: Array<Pick<TripDayData, 'dayIndex'>>
}): number {
  if (typeof trip.completedDayCount === 'number' && Number.isInteger(trip.completedDayCount)) {
    return Math.max(0, Math.min(trip.days, trip.completedDayCount))
  }
  return new Set(trip.tripDays.map((day) => day.dayIndex).filter((index) => index >= 1 && index <= trip.days)).size
}

/** 取服务端缺失日期；旧响应按 1..days 与真实落库日期集合回退。 */
export function getMissingDayIndexes(
  trip: {
    days: number
    missingDayIndexes?: number[] | null
    tripDays: Array<Pick<TripDayData, 'dayIndex'>>
  },
): number[] {
  if (Array.isArray(trip.missingDayIndexes)) {
    return Array.from(
      new Set(trip.missingDayIndexes.filter((index) => Number.isInteger(index) && index >= 1 && index <= trip.days)),
    ).sort((a, b) => a - b)
  }
  const existing = new Set(trip.tripDays.map((day) => day.dayIndex))
  return Array.from({ length: trip.days }, (_, index) => index + 1).filter((index) => !existing.has(index))
}

/** 获取行程详情（含每日条目） */
export async function getTrip(id: string): Promise<TripDetailData> {
  const { data } = await api.get<{ trip: TripDetailData }>(`/trips/${id}`)
  return data.trip
}

/** 取消等待确认/人工恢复阶段的任务，保留已落库日期与打卡数据。 */
export async function cancelGeneration(tripId: string): Promise<void> {
  await api.post(`/trips/${tripId}/cancel-generation`)
}

/** 显式检查异常中断，不在普通详情 GET 中改变运行状态。 */
export async function recoverGeneration(tripId: string): Promise<{ status: 'active' | 'waiting' | 'recovery' | 'commit_pending' | 'idle'; changed: boolean }> {
  const { data } = await api.post<{ status: 'active' | 'waiting' | 'recovery' | 'commit_pending' | 'idle'; changed: boolean }>(`/trips/${tripId}/recover-generation`)
  return data
}

/** 从已有行程复制基础配置为新草稿，供安全的重新规划使用。 */
export async function createReplanDraft(tripId: string): Promise<string> {
  const { data } = await api.post<{ trip: { id: string } }>(`/trips/${tripId}/replan-copy`)
  return data.trip.id
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
