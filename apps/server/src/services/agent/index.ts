// 行程生成的编排入口。
//
// 一次生成按下面的顺序发生：
//   1. 校验行程状态，取出用户自己的模型凭据
//   2. 把行程状态置为 generating，前端就能轮询到「生成中」
//   3. 让模型带着工具（高德查询）反复取数，直到它给出最终 JSON
//   4. 解析并修正这份 JSON —— 地点必须来自登记表、每天景点不超 3 个、餐厅夹在景点之间
//   5. 体检真实通勤时间，超 40 分钟的相邻点换掉
//   6. 写入每日安排与条目表，状态置为 ready
//
// 整个过程是异步的：接口立刻返回，页面轮询进度，不会让浏览器干等几分钟。

import { prisma } from '../../db'
import { getWeather, type Poi } from '../amap'
import { getCredentialsForUser } from '../llm'
import { runToolLoop } from './model-client'
import { buildSystemPrompt, buildUserPrompt } from './prompt'
import { optimizeCommute, parsePlanJson, validatePlan, type PlanResult } from './scheduler'
import { runTool, TOOL_DEFINITIONS, type ToolContext } from './tools'

/** 整轮生成的硬超时。超过就判定失败，避免任务永远挂在 generating */
const MAX_GENERATION_MS = 5 * 60 * 1000

/** 模型最多与工具来回多少轮。够覆盖「搜索若干次 + 查路线」的常规用量 */
const MAX_TOOL_ROUNDS = 24

/** 生成失败时抛出，携带给用户看的中文原因 */
export class GenerateError extends Error {}

// ---------------------------------------------------------------------------
// 进度上报
// ---------------------------------------------------------------------------

/**
 * 进度写库的节流器。
 *
 * 模型每调用一次工具就会产生一条进度，如果每次都写库，
 * 一次生成会打出几十条 UPDATE，毫无必要。这里限制最快 800 毫秒写一次。
 */
function createReporter(tripId: string) {
  let lastWriteAt = 0
  let lastText = ''

  return (text: string) => {
    if (text === lastText) return
    lastText = text

    const now = Date.now()
    if (now - lastWriteAt < 800) return
    lastWriteAt = now

    // 这里刻意不 await：进度只是给人看的，写失败也不该影响生成主流程
    void prisma.trip
      .update({ where: { id: tripId }, data: { genProgress: text } })
      .catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function generateTrip(tripId: string): Promise<void> {
  const startedAt = Date.now()

  const trip = await prisma.trip.findUnique({ where: { id: tripId } })
  if (!trip) throw new GenerateError('行程不存在')

  const credentials = await getCredentialsForUser(trip.userId)
  if (!credentials) {
    throw new GenerateError('还没有配置模型 API Key，请先到「个人设置」里填写')
  }

  const report = createReporter(tripId)
  const registry = new Map<string, Poi>()

  // 用户已经选好住宿时，把住宿也登记进去，
  // 这样模型才能用 get_route 计算「住宿 → 第一个景点」的真实通勤
  const stayInfo = await loadStayPoi(trip)
  if (stayInfo) registry.set(stayInfo.poi.poiId, stayInfo.poi)

  const toolContext: ToolContext = {
    cityName: trip.cityName,
    cityAdcode: trip.cityAdcode,
    registry,
    report,
  }

  const preferences = safeParseArray(trip.preferences)
  const extraNeeds = safeParseArray(trip.extraNeeds)

  report('正在理解你的需求')

  const result = await runToolLoop({
    credentials,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt({
      cityName: trip.cityName,
      cityAdcode: trip.cityAdcode,
      startDate: formatDate(trip.startDate),
      days: trip.days,
      travelers: trip.travelers,
      preferences,
      extraNeeds,
      budgetAmount: trip.budgetAmount,
      budgetScope: trip.budgetScope === 'total' ? 'total' : 'per_person',
      stay: stayInfo ? { poiId: stayInfo.poi.poiId, name: stayInfo.poi.name } : null,
    }),
    tools: TOOL_DEFINITIONS,
    executeTool: (name, args) => runTool(name, args, toolContext),
    maxRounds: MAX_TOOL_ROUNDS,
    log: (line) => console.log(`[生成 ${tripId}] ${line}`),
    beforeRound: () => {
      // 在每一轮的边界检查超时，比让请求无限跑下去友好
      if (Date.now() - startedAt > MAX_GENERATION_MS) {
        throw new GenerateError('生成耗时过长已中止，请稍后重试或简化行程需求')
      }
    },
  })

  report('正在整理行程安排')

  // 解析 + 按规则修正
  const raw = parsePlanJson(result.content)
  const plan = validatePlan(raw, registry, trip.days)

  // 通勤体检（会消耗高德路径规划配额，所以放在修正之后、落库之前）
  await optimizeCommute(plan, registry, report)

  // 把住宿地本身从行程条目里剔除：它是一天的起点，不是一个游览点
  if (stayInfo) {
    for (const day of plan.days) {
      day.items = day.items.filter((item) => item.poiId !== stayInfo.poi.poiId)
      day.items.forEach((item, index) => {
        item.orderIndex = index + 1
      })
    }
  }

  const totalItems = plan.days.reduce((sum, day) => sum + day.items.length, 0)
  if (totalItems === 0) {
    throw new GenerateError(
      '模型没有给出可用的地点安排。常见原因是目的地过于冷门，或模型凭据余额不足',
    )
  }

  report('正在写入行程')

  // 天气：高德只有约 4 天预报，超出窗口的日期留空，前端会显示「超出预报范围」
  const weather = await getWeather(trip.cityAdcode).catch(() => null)
  const weatherByDate = new Map<string, unknown>()
  for (const cast of weather?.casts ?? []) {
    weatherByDate.set(cast.date, cast)
  }

  await persistPlan(trip, plan, stayInfo, weatherByDate)

  console.log(
    `[生成 ${trip.id}] 完成：${plan.days.length} 天 / ${totalItems} 个条目 / ` +
      `工具调用 ${result.toolCallCount} 次 / 耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`,
  )
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

async function persistPlan(
  trip: { id: string; days: number; startDate: Date; stayResolved: boolean },
  plan: PlanResult,
  stayInfo: Awaited<ReturnType<typeof loadStayPoi>>,
  weatherByDate: Map<string, unknown>,
): Promise<void> {
  // 重新生成时先清掉旧安排，避免新旧混在一起。条目的删除由数据库级联完成
  await prisma.tripDay.deleteMany({ where: { tripId: trip.id } })

  for (const day of plan.days) {
    const date = addDays(trip.startDate, day.dayIndex - 1)
    const dateKey = formatDate(date)
    const weather = weatherByDate.get(dateKey) ?? null

    await prisma.tripDay.create({
      data: {
        tripId: trip.id,
        dayIndex: day.dayIndex,
        date,
        summary: day.summary || null,
        weather: weather ? JSON.stringify(weather) : null,
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
            openTimeText: item.openTimeText || null,
            note: item.note || null,
          })),
        },
      },
    })
  }

  // 用户没定住宿但模型推荐了锚点，一并写回去
  const stayUpdate =
    !stayInfo && plan.stay
      ? {
          stayResolved: true,
          stayPoiId: plan.stay.poiId,
          stayName: plan.stay.name,
          stayLng: plan.stay.lng ?? null,
          stayLat: plan.stay.lat ?? null,
        }
      : {}

  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'ready',
      genProgress: null,
      genError: null,
      ...stayUpdate,
    },
  })
}

/** 把住宿锚点还原成 POI 形状，供登记表与路线查询使用 */
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
      // 类型留空：住宿不是游览点，也不是餐厅，不参与每天的景点计数
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
    },
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function safeParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** 输出 YYYY-MM-DD。用 UTC 计算，避免时区差异把日期整体挪一天 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + delta)
  return next
}
