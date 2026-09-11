// 行程生成的编排入口。
//
// 生成是**按天**进行的：一次请求只让模型安排一天，排完立刻落库、更新进度，
// 再接着排下一天。为什么改成这样：
//   1. 输出体积小得多。早先一次要模型吐完整趟行程的 JSON，天数越多越容易写坏
//      （实测每多写一天，格式出错的概率就往上跳一截）。
//   2. 失败范围小。某一天排失败时，前面几天已经落库了，重试接着来就行，
//      不必把几十次高德查询和已经排好的内容一起作废。
//   3. 进度看得见。前端能显示「第 2/3 天已完成」，而不是一个笼统的「生成中」。
//
// 一天之内的顺序：
//   1. 取当天的天气（高德只有约 4 天预报，超出窗口就按未知处理）
//   2. 模型带工具（高德查询）反复取数，直到它给出这一天的 JSON
//   3. 解析并修正：地点必须来自登记表、景点不超 3 个、餐厅夹在景点之间、跨天不重复
//   4. 体检真实通勤时间，超 40 分钟的相邻点换掉
//   5. 落库并更新进度
//
// 整个过程是异步的：接口立刻返回，页面轮询进度，不会让浏览器干等几分钟。

import fs from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../../db'
import { getWeather, type Poi } from '../amap'
import { getCredentialsForUser, type ModelCredentials } from '../llm'
import { reaskForJson, runToolLoop, type ChatMessage } from './model-client'
import {
  buildAnchorSystemPrompt,
  buildAnchorUserPrompt,
  buildDaySystemPrompt,
  buildDayUserPrompt,
  type TripBasics,
} from './prompt'
import {
  optimizeCommute,
  parsePlanJson,
  PlanParseError,
  resolveAnchorFromRaw,
  validateDay,
  type PlannedDay,
  type RawPlan,
} from './scheduler'
import { runTool, TOOL_DEFINITIONS, type ToolContext } from './tools'

/** 单天生成的硬超时。一天排不出来就失败，不拖着整趟任务 */
const MAX_DAY_MS = 3 * 60 * 1000

/** 整趟生成的硬超时，兜住「每天都卡在边缘」的极端情况 */
const MAX_TOTAL_MS = 20 * 60 * 1000

/** 单天最多与工具来回多少轮。够覆盖「搜几个景点 + 附近找餐厅 + 查路线」 */
const MAX_DAY_TOOL_ROUNDS = 14

/** 挑住宿锚点时的工具轮次上限。这一步很轻，用不了几轮 */
const MAX_ANCHOR_TOOL_ROUNDS = 8

/** 天气超出预报窗口时的说明，直接写进提示词 */
const NO_FORECAST_TEXT =
  '超出预报范围（高德只提供未来约 4 天），请按天气未知处理，不要编造'

/** getWeather 返回的单个预报条目 */
type WeatherCast = NonNullable<Awaited<ReturnType<typeof getWeather>>>['casts'][number]

/** 生成失败时抛出，携带给用户看的中文原因 */
export class GenerateError extends Error {}

/** generateTrip 的选项 */
export interface GenerateOptions {
  /**
   * continue（默认）：保留已经排好的天，从第一个空缺的天接着排
   * restart：清空已有安排，从第 1 天重新排
   */
  mode?: 'continue' | 'restart'
}

// ---------------------------------------------------------------------------
// 进度上报
// ---------------------------------------------------------------------------

/**
 * 进度写库的节流器。
 *
 * 模型每调用一次工具就会产生一条进度，如果每次都写库，
 * 一次生成会打出几十条 UPDATE，毫无必要。这里限制最快 800 毫秒写一次。
 *
 * 但「第 N 天已完成」这类关键节点要传 force —— 它必须落库，
 * 否则可能被节流吞掉，用户就看不到天与天之间的推进。
 */
function createReporter(tripId: string) {
  let lastWriteAt = 0
  let lastText = ''

  return (text: string, options: { force?: boolean } = {}) => {
    if (text === lastText) return
    lastText = text

    const now = Date.now()
    if (!options.force && now - lastWriteAt < 800) return
    lastWriteAt = now

    // 这里刻意不 await：进度只是给人看的，写失败也不该影响生成主流程
    void prisma.trip
      .update({ where: { id: tripId }, data: { genProgress: text } })
      .catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 模型输出的解析与补救
// ---------------------------------------------------------------------------

/**
 * 解析模型的最终输出；失败时带着原因请模型重新输出一次，再不行才报错。
 *
 * 为什么要留这一次机会：模型输出 JSON 是有随机性的，同一份提示词，
 * 这次把话说毛了（多一句解释、漏一个转义、写到一半被截断），下次可能就正常。
 * 直接判失败等于把这点随机性全部转嫁给用户——他只会看到「生成失败」，
 * 而重试一次的成本只是多一次对话请求（不用重跑工具查询和高德配额）。
 */
async function resolvePlanJson(input: {
  tripId: string
  /** 存档文件名里的标记，例如 day-2 或 anchor */
  tag: string
  /** 出现在报错文案里的对象名，例如「第 2 天」 */
  label: string
  credentials: ModelCredentials
  messages: ChatMessage[]
  content: string
  finishReason: string
  log: (line: string) => void
}): Promise<RawPlan> {
  try {
    return parsePlanJson(input.content)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 两种线索任一成立，就按「被截断」处理：解析器发现括号没配平，或接口直接报告撞了长度上限
    const truncated =
      (error instanceof PlanParseError && error.truncated) || input.finishReason === 'length'

    await dumpRawOutput(`${input.tripId}-${input.tag}-1`, input.content, {
      finishReason: input.finishReason,
      truncated,
      reason,
      snippet: error instanceof PlanParseError ? error.snippet : '',
    })

    input.log(`${input.label}的输出解析失败（${reason}；truncated=${truncated}），请模型重新输出一次`)

    const retry = await reaskForJson({
      credentials: input.credentials,
      messages: input.messages,
      feedback: reason,
      fragment: error instanceof PlanParseError ? error.fragment : undefined,
      askShorter: truncated,
      log: input.log,
    })

    try {
      const raw = parsePlanJson(retry.content)
      input.log(`模型重新输出成功，继续处理${input.label}`)
      return raw
    } catch (secondError) {
      const secondReason = secondError instanceof Error ? secondError.message : String(secondError)
      await dumpRawOutput(`${input.tripId}-${input.tag}-2`, retry.content, {
        finishReason: retry.finishReason,
        truncated: secondError instanceof PlanParseError && secondError.truncated,
        reason: secondReason,
        snippet: secondError instanceof PlanParseError ? secondError.snippet : '',
      })

      throw new GenerateError(
        `${input.label}连续两次都没能给出可用的数据（${secondReason}）。` +
          `可以稍后重试（会从这一天接着排，已排好的天不会丢），` +
          `或在「个人设置」里换用输出更稳定的模型。` +
          `原始输出已留存在 apps/server/.debug/ 下，便于定位。`,
      )
    }
  }
}

/**
 * 把模型的原始输出落盘存档。
 *
 * 这类失败最难的地方在于「事后无法复现」——重跑一次模型可能就又正常了。
 * 把原始回复连同结束原因一起写进文件，下次再遇到同样的报错，
 * 直接打开 .debug 目录就能看到模型当时到底写了什么。目录已在 .gitignore 里。
 */
async function dumpRawOutput(
  name: string,
  content: string,
  meta: { finishReason: string; truncated: boolean; reason: string; snippet: string },
): Promise<void> {
  try {
    // 这里用 import.meta.dirname（源码所在目录）而不是 process.cwd()，
    // 保证不管从哪个目录启动服务，存档都落在同一个地方
    const dir = path.resolve(import.meta.dirname, '../../../.debug')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${name}.txt`)

    const header = [
      `存档：${name}`,
      `时间：${new Date().toISOString()}`,
      `模型结束原因：${meta.finishReason}（length 表示被截断）`,
      `是否判定为截断：${meta.truncated}`,
      `解析错误：${meta.reason}`,
      meta.snippet ? `失败片段（尾部）：\n${meta.snippet}` : '',
      '',
      '===== 模型原始输出（未做任何加工）=====',
      '',
    ]
      .filter(Boolean)
      .join('\n')

    await fs.writeFile(file, header + content, 'utf8')
    console.log(`[生成] 原始输出已存档：${file}`)
  } catch {
    // 存档失败不该把生成流程也带崩，静默忽略
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function generateTrip(
  tripId: string,
  options: GenerateOptions = {},
): Promise<void> {
  const startedAt = Date.now()
  const mode = options.mode ?? 'continue'
  const log = (line: string) => console.log(`[生成 ${tripId}] ${line}`)

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

  // ---- 1. 确定住宿锚点 -----------------------------------------------------
  // 一天都没有锚点就排不出来，所以这一步在所有天之前先做掉，只做一次。
  let anchor: { poi: Poi; reason: string } | null = stayInfo
    ? { poi: stayInfo.poi, reason: '' }
    : null
  if (!anchor) {
    report('正在挑选住宿区域', { force: true })
    anchor = await resolveAnchor({ tripId, credentials, toolContext, basics, log })
    log(`住宿锚点：${anchor.poi.name}（${anchor.reason || '未说明理由'}）`)
  }

  // ---- 2. 清空或续跑 -------------------------------------------------------
  if (mode === 'restart') {
    await prisma.tripDay.deleteMany({ where: { tripId } })
    log('已清空原有安排，从头生成')
  }

  const existing = await prisma.tripDay.findMany({
    where: { tripId },
    orderBy: { dayIndex: 'asc' },
    include: { items: { orderBy: { orderIndex: 'asc' } } },
  })

  // 跨天去重用两个清单：poiId 用于程序判断，地名用于写进提示词
  const usedPoiIds = new Set<string>()
  const previousPlaces: string[] = []
  for (const day of existing) {
    for (const item of day.items) {
      if (item.poiId) usedPoiIds.add(item.poiId)
      previousPlaces.push(item.name)
    }
  }

  const doneDays = new Set(existing.map((day) => day.dayIndex))
  let startDay = 1
  while (doneDays.has(startDay)) startDay += 1

  if (startDay > trip.days) {
    log('所有天都已经排好，无需再生成')
    await prisma.trip.update({
      where: { id: tripId },
      data: { status: 'ready', genProgress: null, genError: null },
    })
    return
  }

  if (existing.length > 0) {
    log(`检测到已排好的 ${existing.length} 天，从第 ${startDay} 天继续`)
  }

  // ---- 3. 天气：取一次，逐天分发 -------------------------------------------
  // 天气只是排程的参考，取不到不影响生成
  const weatherByDate = new Map<string, WeatherCast>()
  try {
    const weather = await getWeather(trip.cityAdcode)
    for (const cast of weather?.casts ?? []) weatherByDate.set(cast.date, cast)
  } catch {
    log('天气获取失败，本次按天气未知处理')
  }

  // ---- 4. 逐天生成 ---------------------------------------------------------
  for (let dayIndex = startDay; dayIndex <= trip.days; dayIndex++) {
    if (Date.now() - startedAt > MAX_TOTAL_MS) {
      throw new GenerateError('整趟生成耗时过长已中止，请稍后重试；已经排好的天会保留')
    }

    const dayStartedAt = Date.now()
    const date = addDays(trip.startDate, dayIndex - 1)
    const dateKey = formatDate(date)
    const cast = weatherByDate.get(dateKey) ?? null

    report(`正在安排第 ${dayIndex}/${trip.days} 天`, { force: true })
    log(`--- 第 ${dayIndex} 天（${dateKey}）开始 ---`)

    const result = await runToolLoop({
      credentials,
      systemPrompt: buildDaySystemPrompt(),
      userPrompt: buildDayUserPrompt({
        ...basics,
        dayIndex,
        date: dateKey,
        weatherText: cast ? describeWeather(cast) : NO_FORECAST_TEXT,
        stay: { poiId: anchor.poi.poiId, name: anchor.poi.name },
        // 只带最近 20 个地名就够模型避开重复了，带太多反而稀释注意力
        previousPlaces: previousPlaces.slice(-20),
      }),
      tools: TOOL_DEFINITIONS,
      executeTool: (name, args) => runTool(name, args, toolContext),
      maxRounds: MAX_DAY_TOOL_ROUNDS,
      log,
      beforeRound: () => {
        if (Date.now() - dayStartedAt > MAX_DAY_MS) {
          throw new GenerateError(
            `第 ${dayIndex} 天生成耗时过长已中止，请稍后重试；已经排好的天会保留`,
          )
        }
      },
    })

    const raw = await resolvePlanJson({
      tripId,
      tag: `day-${dayIndex}`,
      label: `第 ${dayIndex} 天`,
      credentials,
      messages: result.messages,
      content: result.content,
      finishReason: result.finishReason,
      log,
    })

    const { day, warnings } = validateDay(raw, registry, dayIndex, { usedPoiIds })
    for (const warning of warnings) log(`规则修正：${warning}`)

    // 住宿地本身不是游览点，它是一天的起点与终点，不该出现在条目里
    day.items = day.items.filter((item) => item.poiId !== anchor!.poi.poiId)
    day.items.forEach((item, index) => {
      item.orderIndex = index + 1
    })

    if (day.items.length === 0) {
      throw new GenerateError(
        `第 ${dayIndex} 天没有排出可用的地点。常见原因是目的地过于冷门，或模型凭据余额不足；` +
          `稍后重试会从这一天继续，已经排好的天都在。`,
      )
    }

    // 通勤体检只做这一天：问题当天暴露，且换点时避开前面几天已用的地点
    const commuteWarnings = await optimizeCommute([day], registry, report, usedPoiIds)
    for (const warning of commuteWarnings) log(`通勤体检：${warning}`)

    await persistDay(tripId, day, date, cast)

    for (const item of day.items) {
      usedPoiIds.add(item.poiId)
      previousPlaces.push(item.name)
    }

    // 这一天的进度必须落库，用户才能看到天与天之间的推进
    await prisma.trip.update({
      where: { id: tripId },
      data: {
        genDayIndex: dayIndex,
        genProgress: `第 ${dayIndex}/${trip.days} 天已完成`,
      },
    })

    log(
      `第 ${dayIndex} 天完成：${day.items.length} 个条目 / ` +
        `工具调用 ${result.toolCallCount} 次 / 耗时 ${Math.round((Date.now() - dayStartedAt) / 1000)} 秒`,
    )
  }

  // ---- 5. 收尾 -------------------------------------------------------------
  await prisma.trip.update({
    where: { id: tripId },
    data: { status: 'ready', genProgress: null, genError: null },
  })

  const totalItems = await prisma.tripItem.count({ where: { tripDay: { tripId } } })
  log(
    `全部完成：${trip.days} 天 / ${totalItems} 个条目 / ` +
      `总耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`,
  )
}

// ---------------------------------------------------------------------------
// 住宿锚点
// ---------------------------------------------------------------------------

/**
 * 用户还没定住宿时，让模型挑一个锚点。
 *
 * 这一步刻意做得很轻：只搜几次酒店，不排任何一天。理由是锚点是后续每一天
 * 共同的起点，如果混在「第 1 天」的生成里顺便确定，一旦第 1 天失败，
 * 后面所有天都无从开始；单独做掉就不会有这个连锁。
 */
async function resolveAnchor(input: {
  tripId: string
  credentials: ModelCredentials
  toolContext: ToolContext
  basics: TripBasics
  log: (line: string) => void
}): Promise<{ poi: Poi; reason: string }> {
  const result = await runToolLoop({
    credentials: input.credentials,
    systemPrompt: buildAnchorSystemPrompt(),
    userPrompt: buildAnchorUserPrompt({ ...input.basics, stay: null }),
    tools: TOOL_DEFINITIONS,
    executeTool: (name, args) => runTool(name, args, input.toolContext),
    maxRounds: MAX_ANCHOR_TOOL_ROUNDS,
    log: input.log,
  })

  const raw = await resolvePlanJson({
    tripId: input.tripId,
    tag: 'anchor',
    label: '住宿锚点',
    credentials: input.credentials,
    messages: result.messages,
    content: result.content,
    finishReason: result.finishReason,
    log: input.log,
  })

  // 锚点同样必须来自登记表：模型说哪家酒店就哪家，坐标由服务端回填
  const anchor = resolveAnchorFromRaw(raw, input.toolContext.registry)
  if (!anchor) {
    throw new GenerateError(
      '没能确定住宿锚点：模型没有给出可用的酒店。' +
        '可以回到上一步手动选一家住宿，或稍后重试。',
    )
  }

  // 写回行程，后续重新生成时就不必再让模型挑一次
  await prisma.trip.update({
    where: { id: input.tripId },
    data: {
      stayResolved: true,
      stayPoiId: anchor.poi.poiId,
      stayName: anchor.poi.name,
      stayLng: anchor.poi.lng,
      stayLat: anchor.poi.lat,
    },
  })

  return anchor
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

/**
 * 写入某一天。先删后建，保证同一天被重复跑到时（用户点了「重新生成」、
 * 或失败后续跑）不会出现新旧两份安排混在一起。
 */
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

/** 把当天的天气预报拼成一句话，直接写进提示词 */
function describeWeather(cast: WeatherCast): string {
  return `白天${cast.dayWeather} ${cast.dayTemp}℃，夜间${cast.nightWeather} ${cast.nightTemp}℃`
}

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
