// LangGraph 版行程生成的对外入口。
//
// 与手写版 generateTrip（index.ts）职责完全相同，只是把编排交给 LangGraph 图。
// 这个入口负责：装外部上下文（凭证、登记表、天气、落库函数）→ 驱动图执行。
//
// 设计上刻意保留原 index.ts 里那些「非编排」的辅助逻辑（进度上报节流、
// 住宿 POI 还原、落库、日期工具），只把编排核心换成图。这样两版并存，
// 便于逐版本对比验证，最终稳定后再切流、删旧版。

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { Command } from '@langchain/langgraph'
import path from 'node:path'
import { prisma } from '../../db'
import { getWeather, type Poi, type WeatherCast } from '../amap'
import { getCredentialsForUser } from '../llm'
import { type PlannedDay } from './scheduler'
import { nightKindOfText, parseDayTypeBan, type DayType, type Intensity } from './spot-rules'
import { type ToolContext } from './tools'
import { buildAgentGraph, type AgentGraphContext } from './graph'
import type { TripBasics } from './prompt'

/** 生成失败时抛出，携带给用户看的中文原因 */
export class GraphGenerateError extends Error {}

/** 单天工具循环轮次上限（与原 index.ts 一致） */
const MAX_DAY_TOOL_ROUNDS = 14

// ---------------------------------------------------------------------------
// checkpointer 单例
// ---------------------------------------------------------------------------

/**
 * 模块级惰性单例：SQLite checkpointer 是无状态的持久化基础设施，
 * 不是会话数据，多个生成会话应复用同一个连接，而不是每次都 fromConnString
 * 打开一个新连接（否则会泄漏文件句柄、且 WAL 模式下多连接争用）。
 */
let _checkpointer: SqliteSaver | null = null

function getCheckpointer(): SqliteSaver {
  if (!_checkpointer) {
    _checkpointer = SqliteSaver.fromConnString(
      path.resolve(import.meta.dirname, '../../../.debug/langgraph-checkpoints.sqlite'),
    )
  }
  return _checkpointer
}

/** 生成图入口 */
export async function generateTripWithGraph(
  tripId: string,
  options: { mode?: 'continue' | 'restart' | 'review' } = {},
): Promise<void> {
  const startedAt = Date.now()
  const mode = options.mode ?? 'continue'
  // review 模式 = 从头重排 + 逐天人工确认（V3）。
  // 语义上等价于 restart（清空旧安排）叠加 reviewMode（每排完一天暂停）。
  // 这样用户点「逐天确认生成」时，一定是从第 1 天开始、逐天过一遍，
  // 而不是在旧行程的残留上续跑。
  const reviewMode = mode === 'review'
  const effectiveMode: 'continue' | 'restart' = mode === 'restart' || reviewMode ? 'restart' : 'continue'
  const log = (line: string) => console.log(`[生成·图 ${tripId}] ${line}`)

  const trip = await prisma.trip.findUnique({ where: { id: tripId } })
  if (!trip) throw new GraphGenerateError('行程不存在')

  const credentials = await getCredentialsForUser(trip.userId)
  if (!credentials) {
    throw new GraphGenerateError('还没有配置模型 API Key，请先到「个人设置」里填写')
  }

  const report = createReporter(tripId)
  const registry = new Map<string, Poi>()

  // 用户已选住宿时登记进表，模型才能算「住宿 → 第一站」的真实通勤
  const stayInfo = await loadStayPoi(trip)
  if (stayInfo) registry.set(stayInfo.poi.poiId, stayInfo.poi)

  const toolContext: ToolContext = {
    cityName: trip.cityName,
    cityAdcode: trip.cityAdcode,
    registry,
    report: (text) => report(text),
  }

  const basics: TripBasics = {
    cityName: trip.cityName,
    cityAdcode: trip.cityAdcode,
    startDate: formatDate(trip.startDate),
    days: trip.days,
    travelers: trip.travelers,
    preferences: safeParseArray(trip.preferences),
    extraNeeds: safeParseArray(trip.extraNeeds),
    budgetAmount: trip.budgetAmount,
    budgetScope: trip.budgetScope === 'total' ? 'total' : 'per_person',
  }

  const ban = parseDayTypeBan(safeParseArray(trip.extraNeeds))

  // 断点续跑：先恢复已落库的天，算出「下一个要排的天」与跨天传导状态
  if (effectiveMode === 'restart') {
    await prisma.tripDay.deleteMany({ where: { tripId } })
    log('已清空原有安排，从头生成')
  }

  const existing = await prisma.tripDay.findMany({
    where: { tripId },
    orderBy: { dayIndex: 'asc' },
    include: { items: { orderBy: { orderIndex: 'asc' } } },
  })

  const usedPoiIds: string[] = []
  const previousPlaces: string[] = []
  const usedNightKinds: string[] = []
  for (const day of existing) {
    for (const item of day.items) {
      if (item.poiId) usedPoiIds.push(item.poiId)
      previousPlaces.push(item.name)
      const kind = nightKindOfText(item.name, item.tag)
      if (kind && !usedNightKinds.includes(kind)) usedNightKinds.push(kind)
    }
  }

  const doneDays = new Set(existing.map((day) => day.dayIndex))
  let startDay = 1
  while (doneDays.has(startDay)) startDay += 1

  // 上一天的天型强度（断点续跑时从已落库的最后一天恢复）
  const lastExisting = existing.length > 0 ? existing[existing.length - 1] : null
  let previousDayState: { dayType: string; intensity: string } | null = null
  if (lastExisting && lastExisting.dayIndex === startDay - 1) {
    previousDayState = {
      dayType: (lastExisting.dayType as DayType) || 'normal',
      intensity: (lastExisting.intensity as Intensity) || 'medium',
    }
  }

  if (startDay > trip.days) {
    log('所有天都已经排好，无需再生成')
    await prisma.trip.update({
      where: { id: tripId },
      data: { status: 'ready', genProgress: null, genError: null },
    })
    return
  }

  // 天气取一次，逐天分发
  const weatherByDate = new Map<string, WeatherCast>()
  try {
    const weather = await getWeather(trip.cityAdcode)
    for (const cast of weather?.casts ?? []) weatherByDate.set(cast.date, cast)
  } catch {
    log('天气获取失败，本次按天气未知处理')
  }

  // 装外部上下文
  const ctx: AgentGraphContext = {
    tripId,
    credentials,
    registry,
    toolContext,
    basics,
    ban,
    anchor: stayInfo?.poi ?? null,
    weatherByDate,
    report,
    log,
    persistDay: (day, date, weather) => persistDay(tripId, day, date, weather),
    maxToolRounds: MAX_DAY_TOOL_ROUNDS,
    reviewMode,
    // V4 并行择优：环境变量可开，默认 1（不并行，成本与手写版一致）
    parallelCandidates: Number(process.env.PARALLEL_CANDIDATES ?? 1),
  }

  // 构建图（闭包捕获 ctx），驱动执行。
  //
  // V2：接入 SQLite checkpointer。图状态（进度、去重清单、传导状态）在每个
  // 超级步被快照到 .debug/langgraph-checkpoints.sqlite，进程崩溃重启后，
  // 用同一个 thread_id 重新 invoke 就能从图中断的节点恢复——这是手写版
  // 「天级落库」做不到的「节点级」断点。
  const graph = buildAgentGraph(ctx, getCheckpointer())
  const config = { configurable: { thread_id: tripId } }

  try {
    // 图状态初值：从已落库的天恢复跨天去重与传导状态
    const result = await graph.invoke(
      {
        dayIndex: startDay,
        totalDays: trip.days,
        usedPoiIds,
        previousPlaces,
        usedNightKinds,
        previousDayState,
        warnings: [],
        finished: false,
        pendingDaySummary: null,
        dayRetryCount: 0,
        dayError: null,
      },
      config,
    )

    // review 模式：图在 reviewDay 的 interrupt 处暂停返回，result 里带 __interrupt__。
    // 这时不是完成、也不是失败，而是「等待用户确认」——把待确认摘要写进
    // genProgress 供前端展示，status 保持 generating，等用户调用 review 接口恢复。
    const interrupts = (result as { __interrupt__?: unknown[] }).__interrupt__
    if (interrupts && interrupts.length > 0) {
      const first = interrupts[0] as { value?: { dayIndex?: number; summary?: string } }
      const dayIndex = first?.value?.dayIndex ?? startDay
      const summary = first?.value?.summary ?? ''
      await prisma.trip
        .update({
          where: { id: tripId },
          data: {
            genProgress: `待确认：第 ${dayIndex} 天 ${summary}`,
          },
        })
        .catch(() => undefined)
      log(`第 ${dayIndex} 天已暂停，等待用户确认`)
      return
    }

    const totalItems = await prisma.tripItem.count({ where: { tripDay: { tripId } } })
    log(
      `图编排完成：${trip.days} 天 / ${totalItems} 个条目 / ` +
        `总耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`,
    )
    void result
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await prisma.trip
      .update({ where: { id: tripId }, data: { status: 'failed', genError: msg } })
      .catch(() => undefined)
    throw new GraphGenerateError(msg)
  }
}

/**
 * review 模式下的恢复：用户在「待确认」后点了「确认采用」。
 *
 * 用同一个 thread_id（= tripId）+ Command({resume}) 让图从 reviewDay 的
 * interrupt 处继续。因为 checkpointer 已把中断时的图状态（含 ctx 之外的
 * 轻量状态）持久化，这里重新 build 图、重建 ctx（从 Prisma 恢复已排好的天），
 * 图会从断点接着排下一天，而不是从头再来。
 */
export async function resumeTripReview(tripId: string): Promise<void> {
  const log = (line: string) => console.log(`[生成·图 ${tripId}] ${line}`)

  const trip = await prisma.trip.findUnique({ where: { id: tripId } })
  if (!trip) throw new GraphGenerateError('行程不存在')

  const credentials = await getCredentialsForUser(trip.userId)
  if (!credentials) throw new GraphGenerateError('还没有配置模型 API Key')

  const report = createReporter(tripId)
  const registry = new Map<string, Poi>()

  const stayInfo = await loadStayPoi(trip)
  if (stayInfo) registry.set(stayInfo.poi.poiId, stayInfo.poi)

  const toolContext: ToolContext = {
    cityName: trip.cityName,
    cityAdcode: trip.cityAdcode,
    registry,
    report: (text) => report(text),
  }

  const basics: TripBasics = {
    cityName: trip.cityName,
    cityAdcode: trip.cityAdcode,
    startDate: formatDate(trip.startDate),
    days: trip.days,
    travelers: trip.travelers,
    preferences: safeParseArray(trip.preferences),
    extraNeeds: safeParseArray(trip.extraNeeds),
    budgetAmount: trip.budgetAmount,
    budgetScope: trip.budgetScope === 'total' ? 'total' : 'per_person',
  }

  const ban = parseDayTypeBan(safeParseArray(trip.extraNeeds))

  const weatherByDate = new Map<string, WeatherCast>()
  try {
    const weather = await getWeather(trip.cityAdcode)
    for (const cast of weather?.casts ?? []) weatherByDate.set(cast.date, cast)
  } catch {
    log('天气获取失败，本次按天气未知处理')
  }

  const ctx: AgentGraphContext = {
    tripId,
    credentials,
    registry,
    toolContext,
    basics,
    ban,
    anchor: stayInfo?.poi ?? null,
    weatherByDate,
    report,
    log,
    persistDay: (day, date, weather) => persistDay(tripId, day, date, weather),
    maxToolRounds: MAX_DAY_TOOL_ROUNDS,
    reviewMode: true,
    // 恢复路径沿用与首次生成相同的并行配置
    parallelCandidates: Number(process.env.PARALLEL_CANDIDATES ?? 1),
  }

  const graph = buildAgentGraph(ctx, getCheckpointer())
  const config = { configurable: { thread_id: tripId } }

  try {
    const result = await graph.invoke(new Command({ resume: 'approved' }), config)

    // 恢复后可能又在下一天的 reviewDay 暂停，继续写「待确认」
    const interrupts = (result as { __interrupt__?: unknown[] }).__interrupt__
    if (interrupts && interrupts.length > 0) {
      const first = interrupts[0] as { value?: { dayIndex?: number; summary?: string } }
      const dayIndex = first?.value?.dayIndex ?? 1
      const summary = first?.value?.summary ?? ''
      await prisma.trip
        .update({
          where: { id: tripId },
          data: { genProgress: `待确认：第 ${dayIndex} 天 ${summary}` },
        })
        .catch(() => undefined)
      log(`第 ${dayIndex} 天已暂停，继续等待用户确认`)
      return
    }

    log('review 模式全部确认完毕')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await prisma.trip
      .update({ where: { id: tripId }, data: { status: 'failed', genError: msg } })
      .catch(() => undefined)
    throw new GraphGenerateError(msg)
  }
}

// ---------------------------------------------------------------------------
// 复用自原 index.ts 的辅助逻辑（进度节流、落库、住宿还原、日期工具）
// ---------------------------------------------------------------------------

function createReporter(tripId: string) {
  let lastWriteAt = 0
  let lastText = ''
  return (text: string, options: { force?: boolean } = {}) => {
    if (text === lastText) return
    lastText = text
    const now = Date.now()
    if (!options.force && now - lastWriteAt < 800) return
    lastWriteAt = now
    void prisma.trip
      .update({ where: { id: tripId }, data: { genProgress: text } })
      .catch(() => undefined)
  }
}

async function persistDay(
  tripId: string,
  day: PlannedDay,
  date: Date,
  weather: WeatherCast | null,
): Promise<void> {
  await prisma.tripDay.deleteMany({ where: { tripId, dayIndex: day.dayIndex } })
  await prisma.tripDay.create({
    data: {
      tripId,
      dayIndex: day.dayIndex,
      date,
      summary: day.summary || null,
      weather: weather ? JSON.stringify(weather) : null,
      dayType: day.dayType,
      intensity: day.intensity,
      items: {
        create: day.items.map((item) => ({
          orderIndex: item.orderIndex,
          slot: item.slot,
          itemType: item.itemType,
          poiId: item.poiId,
          name: item.name,
          lng: item.lng,
          lat: item.lat,
          address: item.address || null,
          tel: item.tel || null,
          rating: item.rating,
          cost: item.cost,
          tag: item.tag || null,
          typecode: item.typecode || null,
          openTimeText: item.openTimeText || null,
          note: item.note || null,
          photos: item.photos.length > 0 ? JSON.stringify(item.photos) : null,
        })),
      },
    },
  })
}

async function loadStayPoi(trip: {
  stayResolved: boolean
  stayPoiId: string | null
  stayName: string | null
  stayLng: number | null
  stayLat: number | null
}) {
  if (!trip.stayResolved || !trip.stayPoiId || trip.stayLng === null || trip.stayLat === null) {
    return null
  }
  return {
    poi: {
      poiId: trip.stayPoiId,
      name: trip.stayName ?? '住宿地',
      lng: trip.stayLng,
      lat: trip.stayLat,
      address: '',
      type: '住宿服务',
      typecode: '100000',
      cityName: '',
      district: '',
      adcode: '',
      rating: null,
      cost: null,
      tag: '',
      keytag: '',
      openTimeToday: '',
      openTimeWeek: '',
      tel: '',
      photos: [],
      distance: null,
    } as Poi,
  }
}

function safeParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}
