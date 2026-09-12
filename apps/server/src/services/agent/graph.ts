// LangGraph 版行程生成编排（V1：线性骨架复刻）。
//
// 这一版的目标不是加新功能，而是**用 StateGraph 把现有的「按天循环」流程
// 原样复刻一遍**，证明图结构能承载现有业务，同时复用所有已验证的纯函数。
//
// 图结构（线性 + 一个条件边做天循环）：
//
//   START → resolveAnchor(锚点) → planDay(单天) ──条件边──┐
//                                        ↑                  │
//                                        └── 还有下一天 ────┘
//                                        └── 全部排完 → finalize(收尾) → END
//
// 对比原来的 while 循环：流程逻辑从「代码里的 for 循环」变成「图里的边」，
// 这是后续 V2（checkpointer 断点）、V3（interrupt 人工介入）、
// V4（并行择优、回退）的地基——那些能力都需要图结构才能自然表达。
//
// 关键设计：**图状态只放可序列化的轻量字段**（进度、去重清单、传导状态），
// POI 登记表 registry、天气、模型凭证这些不可序列化或体积大的对象，
// 通过 buildAgentGraph(ctx) 的**闭包捕获**。
//
// 为什么用闭包而不是通过 config 传：
//   1. config 对象在 LangGraph 内部会被 clone/重建，用 WeakMap(引用) 当 key
//      找不到原对象——实测「找不到生成上下文」就是这么来的。
//   2. registry（Map）、report/log（函数）本就不可序列化，塞进 configurable
//      会让 checkpointer 序列化时直接炸。
//   3. 每个生成会话调用一次 buildAgentGraph(ctx)，图实例本身就是会话隔离的，
//      闭包捕获的 ctx 天然不会并发串味。

import { END, START, StateGraph, type ConditionalEdgeRouter, type GraphNode } from '@langchain/langgraph'
import { prisma } from '../../db'
import { type Poi } from '../amap'
import { type ModelCredentials } from '../llm'
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
import {
  nightKindOfText,
  type DayType,
  type DayTypeBan,
  type Intensity,
  type NightKind,
} from './spot-rules'
import { runTool, TOOL_DEFINITIONS, type ToolContext } from './tools'
import { AgentGraphState } from './graph-state'
import type { WeatherCast } from '../amap'

// ---------------------------------------------------------------------------
// 外部上下文：不可序列化、或一次生成全程不变的东西都放这里，不进图状态
// ---------------------------------------------------------------------------

/**
 * 一次生成会话的外部上下文。
 *
 * 为什么单独拎出来而不是塞进图状态：checkpointer 会把图状态 JSON 序列化存档，
 * Map（registry）、函数（report/log）、网络连接都不该进状态。这些在每次生成开始时
 * 构建一次，通过闭包在整个图执行期间稳定引用。
 */
export interface AgentGraphContext {
  tripId: string
  credentials: ModelCredentials
  /** poiId → POI。只有进过这张表的地点才允许被行程引用（坐标唯一可信来源） */
  registry: Map<string, Poi>
  /** 模型工具执行上下文，直接复用现有 tools.ts 的 runTool */
  toolContext: ToolContext
  basics: TripBasics
  /** 用户天型黑名单 */
  ban: DayTypeBan
  /** 住宿锚点（用户已选或 AI 推荐）。逐天排程前一定已确定。图内节点会写它 */
  anchor: Poi | null
  /** 天气（按日期 YYYY-MM-DD） */
  weatherByDate: Map<string, WeatherCast>
  /** 进度上报 */
  report: (text: string, options?: { force?: boolean }) => void
  log: (line: string) => void
  /** 落库单天 */
  persistDay: (day: PlannedDay, date: Date, weather: WeatherCast | null) => Promise<void>
  /** 单天工具循环的轮次上限 */
  maxToolRounds: number
}

// ---------------------------------------------------------------------------
// 解析 JSON 的兜底（与原 index.ts 的 resolvePlanJson 一致）
// ---------------------------------------------------------------------------

async function resolvePlanJsonWithRetry(
  ctx: AgentGraphContext,
  tag: string,
  label: string,
  result: { messages: ChatMessage[]; content: string; finishReason: string },
): Promise<RawPlan> {
  try {
    return parsePlanJson(result.content)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const truncated =
      (error instanceof PlanParseError && error.truncated) || result.finishReason === 'length'

    ctx.log(`${label}的输出解析失败（${reason}），请模型重新输出一次`)

    const retry = await reaskForJson({
      credentials: ctx.credentials,
      messages: result.messages,
      feedback: reason,
      fragment: error instanceof PlanParseError ? error.fragment : undefined,
      askShorter: truncated,
      log: ctx.log,
    })

    try {
      return parsePlanJson(retry.content)
    } catch (secondError) {
      const secondReason = secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(`${label}连续两次都没能给出可用的数据（${secondReason}）。可以稍后重试。`)
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function describeWeather(cast: WeatherCast): string {
  return `白天${cast.dayWeather} ${cast.dayTemp}℃，夜间${cast.nightWeather} ${cast.nightTemp}℃`
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 构建图：节点函数在闭包内定义，捕获 ctx
// ---------------------------------------------------------------------------

/**
 * 构建并编译行程生成图。
 *
 * 每个生成会话调用一次：ctx 通过闭包捕获，图实例天然会话隔离，支持并发。
 */
export function buildAgentGraph(ctx: AgentGraphContext) {
  // ---- 节点：锚点 ----------------------------------------------------------
  // 用户没选住宿时，让模型挑一个中心区域当锚点。
  // 在 V1 里锚点本可放在图外完成，但为了后续 V3 能对「锚点选择」做人工确认
  // （interrupt），做成图节点，让关键决策都落在图里，便于以后插暂停点。
  const resolveAnchorNode: GraphNode<typeof AgentGraphState> = async () => {
    if (!ctx.anchor) {
      ctx.report('正在挑选住宿区域', { force: true })
      const result = await runToolLoop({
        credentials: ctx.credentials,
        systemPrompt: buildAnchorSystemPrompt(),
        userPrompt: buildAnchorUserPrompt({ ...ctx.basics, stay: null }),
        tools: TOOL_DEFINITIONS,
        executeTool: (name, args) => runTool(name, args, ctx.toolContext),
        maxRounds: 8,
        log: ctx.log,
      })

      const raw = await resolvePlanJsonWithRetry(ctx, 'anchor', '住宿锚点', result)
      const anchor = resolveAnchorFromRaw(raw, ctx.registry)
      if (!anchor) {
        throw new Error(
          '没能确定住宿锚点：模型没有给出可用的酒店。可以回到上一步手动选一家住宿，或稍后重试。',
        )
      }
      ctx.anchor = anchor.poi
      ctx.log(`住宿锚点：${anchor.poi.name}（${anchor.reason || '未说明理由'}）`)

      await prisma.trip.update({
        where: { id: ctx.tripId },
        data: {
          stayResolved: true,
          stayPoiId: anchor.poi.poiId,
          stayName: anchor.poi.name,
          stayLng: anchor.poi.lng,
          stayLat: anchor.poi.lat,
        },
      })
    }
    return {}
  }

  // ---- 节点：单天排程 ------------------------------------------------------
  const planDayNode: GraphNode<typeof AgentGraphState> = async (state) => {
    const dayIndex = state.dayIndex
    const dateKey = addDays(ctx.basics.startDate, dayIndex - 1)
    const cast = ctx.weatherByDate.get(dateKey) ?? null

    ctx.report(`正在安排第 ${dayIndex}/${state.totalDays} 天`, { force: true })
    ctx.log(`--- 第 ${dayIndex} 天（${dateKey}）开始 ---`)

    const anchor = ctx.anchor
    if (!anchor) throw new Error('住宿锚点尚未确定，无法排程')

    // ① 工具循环
    const result = await runToolLoop({
      credentials: ctx.credentials,
      systemPrompt: buildDaySystemPrompt(),
      userPrompt: buildDayUserPrompt({
        ...ctx.basics,
        dayIndex,
        date: dateKey,
        weatherText: cast
          ? describeWeather(cast)
          : '超出预报范围（高德只提供未来约 4 天），请按天气未知处理，不要编造',
        stay: { poiId: anchor.poiId, name: anchor.name },
        previousPlaces: state.previousPlaces.slice(-20),
        previousDayState: state.previousDayState
          ? { dayType: state.previousDayState.dayType, intensity: state.previousDayState.intensity }
          : null,
        usedNightKinds: state.usedNightKinds,
      }),
      tools: TOOL_DEFINITIONS,
      executeTool: (name, args) => runTool(name, args, ctx.toolContext),
      maxRounds: ctx.maxToolRounds,
      log: ctx.log,
    })

    // ② 解析 JSON
    const raw = await resolvePlanJsonWithRetry(ctx, `day-${dayIndex}`, `第 ${dayIndex} 天`, result)

    // ③ 校验
    const { day, warnings } = validateDay(raw, ctx.registry, dayIndex, {
      usedPoiIds: new Set(state.usedPoiIds),
      ban: ctx.ban,
      previousDayState: state.previousDayState
        ? {
            dayType: state.previousDayState.dayType as DayType,
            intensity: state.previousDayState.intensity as Intensity,
          }
        : null,
      usedNightKinds: new Set(state.usedNightKinds as NightKind[]),
    })
    for (const warning of warnings) ctx.log(`规则修正：${warning}`)

    // 住宿地不是游览点，不该出现在条目里
    day.items = day.items.filter((item) => item.poiId !== anchor.poiId)
    day.items.forEach((item, index) => {
      item.orderIndex = index + 1
    })

    if (day.items.length === 0) {
      throw new Error(
        `第 ${dayIndex} 天没有排出可用的地点。常见原因是目的地过于冷门，或模型凭据余额不足。`,
      )
    }

    // ④ 通勤体检（含住处往返）
    const commuteWarnings = await optimizeCommute(
      [day],
      ctx.registry,
      (text) => ctx.report(text),
      new Set(state.usedPoiIds),
      ctx.ban,
      anchor,
      new Set(state.usedNightKinds as NightKind[]),
    )
    for (const warning of commuteWarnings) ctx.log(`通勤体检：${warning}`)

    // ⑤ 落库
    await ctx.persistDay(day, new Date(dateKey), cast)

    // ⑥ 更新传导状态
    const newPoiIds: string[] = []
    const newPlaces: string[] = []
    const newNightKinds: NightKind[] = []
    for (const item of day.items) {
      newPoiIds.push(item.poiId)
      newPlaces.push(item.name)
      const kind = nightKindOfText(item.name, item.tag)
      if (kind) newNightKinds.push(kind)
    }

    ctx.log(`第 ${dayIndex} 天体裁：${day.dayType}（强度 ${day.intensity}）`)

    await prisma.trip.update({
      where: { id: ctx.tripId },
      data: { genDayIndex: dayIndex, genProgress: `第 ${dayIndex}/${state.totalDays} 天已完成` },
    })

    return {
      dayIndex: dayIndex + 1,
      usedPoiIds: newPoiIds,
      previousPlaces: newPlaces,
      usedNightKinds: newNightKinds,
      previousDayState: { dayType: day.dayType, intensity: day.intensity },
      warnings: commuteWarnings,
    }
  }

  // ---- 节点：收尾 ----------------------------------------------------------
  const finalizeNode: GraphNode<typeof AgentGraphState> = async () => {
    await prisma.trip.update({
      where: { id: ctx.tripId },
      data: { status: 'ready', genProgress: null, genError: null },
    })
    ctx.log('全部完成')
    return { finished: true }
  }

  // ---- 条件边 --------------------------------------------------------------
  const shouldContinue: ConditionalEdgeRouter<{
    InputSchema: typeof AgentGraphState
    Nodes: 'planDay' | 'finalize'
  }> = (state) => {
    return state.dayIndex <= state.totalDays ? 'planDay' : 'finalize'
  }

  return new StateGraph(AgentGraphState)
    .addNode('resolveAnchor', resolveAnchorNode)
    .addNode('planDay', planDayNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'resolveAnchor')
    .addEdge('resolveAnchor', 'planDay')
    .addConditionalEdges('planDay', shouldContinue, ['planDay', 'finalize'])
    .addEdge('finalize', END)
    .compile()
}
