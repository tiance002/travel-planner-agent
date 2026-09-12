// LangGraph 版行程生成编排。
//
// 图结构：
//
//   START → resolveAnchor(锚点) → planDay(单天排程) → reviewDay(用户裁决) ──条件边──┐
//                                        ↑   ↑                        │           │
//                                        │   └── 驳回：按意见重排 ────┘           │
//                                        └────── 失败重试 / 还有下一天 ───────────┘
//                                                  └── 全部排完 → finalize(收尾) → END
//
// 两种运行形态：
//   - 全自动（无开关）：planDay 排完立刻落库推进，reviewDay 透传——与手写版一致。
//   - 交互式（逐天确认 / 并行择优任一开启）：planDay 只「挂起」方案不落库，
//     由 reviewDay interrupt 问用户：
//       · 单方案 → 确认采用 / 驳回（可附修改意见，图回到 planDay 按意见重排）
//       · 双方案 → 展示两案的优缺点与评分/通勤数据，用户挑一个，或都不满意驳回重排
//
// 为什么交互模式下 planDay 不能先落库再问：驳回重排时，跨天状态（usedPoiIds、
// previousDayState、usedNightKinds）已经吸收了这一天的内容——重排会被自己的
// 旧地点「去重」掉、天型传导也算错。先挂起、裁决后再提交，状态永远不会倒退。
//
// 关键设计：**图状态只放可序列化的轻量字段**（进度、去重清单、传导状态、挂起方案），
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

import { END, START, StateGraph, interrupt, type BaseCheckpointSaver, type ConditionalEdgeRouter, type GraphNode } from '@langchain/langgraph'
import { prisma } from '../../db'
import { planRoute, type Poi } from '../amap'
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
import { AgentGraphState, type AgentState } from './graph-state'
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
  /**
   * 逐天人工确认模式。为 true 时每排完一天都会 interrupt 暂停，
   * 等用户确认或驳回（可附修改意见）后再继续——human-in-the-loop 的落点。
   * 默认 false（全自动），保持与手写版一致的行为。
   */
  reviewMode: boolean
  /**
   * 并行候选方案数。>1 时同一天并行生成 N 套候选，取最好的两套展示给用户
   * （附优缺点与评分/通勤数据），由用户挑一个或驳回重排。
   * 成本随 N 线性增长（每套都是一次完整的模型+高德往返），默认 1 = 关闭。
   */
  parallelCandidates: number
  /**
   * 记录一条关键决策。落进 Trip.genDecisions（JSON 数组），
   * 完成后前端可回看「AI 是怎么排的」。写失败不影响生成主流程。
   */
  recordDecision: (text: string) => void
}

/** 用户在「待确认」卡片上的裁决结果（由前端经 review-confirm 路由传回） */
export interface ReviewAnswer {
  decision: 'approve' | 'choose' | 'reject'
  /** decision 为 choose 时：采用哪个方案 */
  choice?: 'A' | 'B'
  /** decision 为 reject 时：用户的修改意见（可空 = 不满意但没具体说） */
  feedback?: string
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

/** 候选方案的展示数据：给用户对比用的量化指标。commuteMinutes 为 null 表示没有任何可用的通勤数据 */
interface CandidateStats {
  ratingAvg: number
  commuteMinutes: number | null
  spotCount: number
}

function statsOf(day: PlannedDay): CandidateStats {
  const spots = day.items.filter((item) => item.itemType === 'spot')
  const ratingAvg =
    spots.length > 0
      ? spots.reduce((sum, item) => sum + (item.rating ? Number(item.rating) : 0), 0) / spots.length
      : 0
  // 只对拿到的通勤数据求和；全是 null（路线查询与估算都失败）时保持 null，
  // 绝不能当 0 参与「谁更短」的对比——那会得出「通勤 0 分钟」这种虚假结论
  const known = day.items
    .map((item) => item.commuteMinutes)
    .filter((m): m is number => typeof m === 'number')
  const commuteMinutes = known.length > 0 ? known.reduce((sum, m) => sum + m, 0) : null
  return { ratingAvg, commuteMinutes, spotCount: spots.length }
}

/**
 * 对比两个候选，生成各自的优缺点。
 * 判据只有三个：景点评分、总通勤、景点数——全部来自已验证的数据，
 * 不调模型、不编形容词，用户看到的是可复核的数字。
 * 任一方案通勤数据缺失时，通勤维度直接不参与对比（宁缺毋错）。
 */
function buildProsCons(mine: CandidateStats, other: CandidateStats): { pros: string[]; cons: string[] } {
  const pros: string[] = []
  const cons: string[] = []

  if (mine.ratingAvg > other.ratingAvg + 0.01) {
    pros.push(`景点评分更高（均分 ${mine.ratingAvg.toFixed(1)}）`)
  } else if (mine.ratingAvg < other.ratingAvg - 0.01) {
    cons.push(`景点评分略低（均分 ${mine.ratingAvg.toFixed(1)}）`)
  } else {
    pros.push(`景点评分与另一案相当（均分 ${mine.ratingAvg.toFixed(1)}）`)
  }

  if (mine.commuteMinutes !== null && other.commuteMinutes !== null) {
    if (mine.commuteMinutes < other.commuteMinutes - 5) {
      pros.push(`驾车通勤更短（约 ${Math.round(mine.commuteMinutes)} 分钟）`)
    } else if (mine.commuteMinutes > other.commuteMinutes + 5) {
      cons.push(`驾车通勤更长（约 ${Math.round(mine.commuteMinutes)} 分钟）`)
    } else {
      pros.push(`驾车通勤与另一案相当（约 ${Math.round(mine.commuteMinutes)} 分钟）`)
    }
  } else {
    cons.push('驾车通勤数据暂缺（路线查询未成功），请以地图实际路线为准')
  }

  if (mine.spotCount > other.spotCount) {
    pros.push(`安排更满（${mine.spotCount} 个景点）`)
  } else if (mine.spotCount < other.spotCount) {
    cons.push(`景点更少（${mine.spotCount} 个），节奏更松`)
  }

  return { pros, cons }
}

/**
 * 估算一段路程的公共交通耗时（分钟）。公交路径规划需要城市 adcode（city1/city2）。
 * 查不到公交方案（线路太少、限流）时返回 null——宁缺毋错，
 * 绝不能把缺失当 0 参与展示（「通勤 0 分钟」那次就是这么来的）。
 */
async function estimateTransitMinutes(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  cityAdcode: string,
): Promise<number | null> {
  try {
    const route = await planRoute({
      mode: 'transit',
      originLng: from.lng,
      originLat: from.lat,
      destLng: to.lng,
      destLat: to.lat,
      city1: cityAdcode,
      city2: cityAdcode,
    })
    if (!route.duration || route.duration <= 0) return null
    return Math.max(1, Math.round(route.duration / 60))
  } catch {
    return null
  }
}

/**
 * 一整天的公共交通总耗时：住处→首站 + 相邻各段（与驾车统计同口径）。
 * 某段查不到公交方案就跳过；全都没有时返回 null（前端展示「公交未知」）。
 * 导出供自检脚本直接验证组装逻辑。
 */
export async function estimateTransitTotal(
  day: PlannedDay,
  anchor: Poi,
  cityAdcode: string,
): Promise<number | null> {
  const points: ({ lng: number; lat: number } | null)[] = [
    { lng: anchor.lng, lat: anchor.lat },
    ...day.items.map((item) =>
      item.lng != null && item.lat != null ? { lng: item.lng, lat: item.lat } : null,
    ),
  ]
  const segments: number[] = []
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    if (!from || !to) continue
    const m = await estimateTransitMinutes(from, to, cityAdcode)
    if (m !== null) segments.push(m)
  }
  return segments.length > 0 ? segments.reduce((sum, m) => sum + m, 0) : null
}

// ---------------------------------------------------------------------------
// 构建图：节点函数在闭包内定义，捕获 ctx
// ---------------------------------------------------------------------------

/**
 * 构建并编译行程生成图。
 *
 * 每个生成会话调用一次：ctx 通过闭包捕获，图实例天然会话隔离，支持并发。
 *
 * @param ctx 外部上下文（凭证、登记表、天气、落库函数等）
 * @param checkpointer 状态快照器。不传则无断点能力；传 SqliteSaver 可在
 *   进程重启后从图中断的节点恢复。
 */
export function buildAgentGraph(ctx: AgentGraphContext, checkpointer?: BaseCheckpointSaver) {
  /** 本会话是否为交互式（需要 interrupt 问用户）：逐天确认或并行择优任一开启 */
  const interactive = ctx.reviewMode || ctx.parallelCandidates > 1

  // ---- 节点：锚点 ----------------------------------------------------------
  // 用户没选住宿时，让模型挑一个中心区域当锚点。
  // 做成图节点，让关键决策都落在图里，便于以后插暂停点。
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
      ctx.recordDecision(
        `住宿锚点选在「${anchor.poi.name}」${anchor.reason ? `：${anchor.reason}` : ''}`,
      )

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

  // ---- 落库与跨天状态推进（提交动作） ---------------------------------------
  // 交互模式下由 reviewDay 在用户裁决后调用；全自动模式下由 planDay 直接调用。
  // 抽成同一个函数，保证两条路径的落库内容与状态推进完全一致。
  const commitDay = async (state: AgentState, day: PlannedDay, warnings: string[]) => {
    const dayIndex = state.dayIndex
    const dateKey = addDays(ctx.basics.startDate, dayIndex - 1)
    const cast = ctx.weatherByDate.get(dateKey) ?? null

    await ctx.persistDay(day, new Date(dateKey), cast)

    // 跨天传导状态：这一天的地点进入去重清单，天型强度流向下一天
    const newPoiIds: string[] = []
    const newPlaces: string[] = []
    const newNightKinds: NightKind[] = []
    for (const item of day.items) {
      newPoiIds.push(item.poiId)
      newPlaces.push(item.name)
      const kind = nightKindOfText(item.name, item.tag)
      if (kind) newNightKinds.push(kind)
    }

    ctx.log(`第 ${dayIndex} 天已确认落库（体裁 ${day.dayType}，强度 ${day.intensity}）`)
    ctx.recordDecision(
      `第 ${dayIndex} 天体裁判定为「${day.dayType}」（强度 ${day.intensity}），安排 ${day.items.length} 个地点`,
    )

    await prisma.trip.update({
      where: { id: ctx.tripId },
      data: {
        genDayIndex: dayIndex,
        genProgress: `第 ${dayIndex}/${state.totalDays} 天已完成`,
        genReview: null, // 待确认卡片已裁决，撤下
      },
    })

    return {
      dayIndex: dayIndex + 1,
      usedPoiIds: newPoiIds,
      previousPlaces: newPlaces,
      usedNightKinds: newNightKinds,
      previousDayState: { dayType: day.dayType, intensity: day.intensity },
      warnings,
      pendingDaySummary: day.summary || `${day.items.length} 个地点（${day.dayType}）`,
      pendingDay: null,
      pendingCandidates: null,
      dayFeedback: null,
      dayError: null,
      dayRetryCount: 0,
    }
  }

  // ---- 节点：单天排程 ------------------------------------------------------
  // 失败不再抛错中断整张图：catch 后把失败信息写进状态，条件边据此决定
  // 「重试当前天」还是「放弃继续」（V4 回退纠错）。
  //
  // 全自动模式：排完立即 commitDay（落库 + 推进），与手写版一致。
  // 交互模式：只挂起（pendingDay / pendingCandidates），等用户裁决后由
  // reviewDay 提交；驳回时把意见写进 dayFeedback，图回到本节点重排。
  const planDayNode: GraphNode<typeof AgentGraphState> = async (state) => {
    const dayIndex = state.dayIndex

    try {
      const dateKey = addDays(ctx.basics.startDate, dayIndex - 1)
      const cast = ctx.weatherByDate.get(dateKey) ?? null

      const isReplan = Boolean(state.dayFeedback)
      ctx.report(
        isReplan ? `根据你的意见重新安排第 ${dayIndex} 天` : `正在安排第 ${dayIndex}/${state.totalDays} 天`,
        { force: true },
      )
      ctx.log(`--- 第 ${dayIndex} 天（${dateKey}）${isReplan ? '按用户意见重排' : '开始'} ---`)

      const anchor = ctx.anchor
      if (!anchor) throw new Error('住宿锚点尚未确定，无法排程')

      // 用户驳回时填的修改意见，原样注入提示词。放在最后、加粗标题，
      // 让模型把它当成本轮最高优先级的要求。
      const feedbackNote = state.dayFeedback
        ? `\n\n## 用户对上一版方案的修改意见（本轮最高优先级，务必落实）\n${state.dayFeedback}\n请据此重新安排这一天的行程，其余要求不变，输出格式与之前完全相同。`
        : ''

      /**
       * 生成一套候选方案。
       *
       * @param registrySnapshot 该候选独立的 POI 登记表（从主表 clone），
       *   避免并行候选之间写竞争，也让每个候选的选点真正独立。
       */
      const generateOneCandidate = async (
        candidateIndex: number,
        registrySnapshot: Map<string, Poi>,
      ): Promise<{ day: PlannedDay; warnings: string[] }> => {
        const candidateCtx: ToolContext = {
          ...ctx.toolContext,
          registry: registrySnapshot,
          report: (text) => {
            // 并行时进度会互相穿插，只让 0 号候选上报，避免进度条乱跳
            if (candidateIndex === 0) ctx.report(text)
          },
        }

        // ① 工具循环
        const result = await runToolLoop({
          credentials: ctx.credentials,
          systemPrompt: buildDaySystemPrompt(),
          userPrompt:
            buildDayUserPrompt({
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
            }) + feedbackNote,
          tools: TOOL_DEFINITIONS,
          executeTool: (name, args) => runTool(name, args, candidateCtx),
          maxRounds: ctx.maxToolRounds,
          log: (line) =>
            ctx.log(ctx.parallelCandidates > 1 ? `[候选${candidateIndex + 1}] ${line}` : line),
        })

        // ② 解析 JSON
        const raw = await resolvePlanJsonWithRetry(
          ctx,
          `day-${dayIndex}-c${candidateIndex}`,
          `第 ${dayIndex} 天（候选 ${candidateIndex + 1}）`,
          result,
        )

        // ③ 校验
        const { day, warnings } = validateDay(raw, registrySnapshot, dayIndex, {
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

        return { day, warnings }
      }

      /**
       * 启发式打分：通勤越短越好、景点评分越高越好。
       * 不再调一次模型打分——那要额外烧 token，且启发式对排序已经够用。
       * 注意：打分只决定「哪个是方案 A / 默认推荐」，最终采用权在用户手里。
       */
      const scoreCandidate = (day: PlannedDay): number => {
        const s = statsOf(day)
        // 评分权重高一些（用户更在意去的地方好不好），通勤其次。
        // 通勤数据缺失按 0（中性）计——打分只决定推荐顺序，采用权在用户手里。
        const commutePenalty = (s.commuteMinutes ?? 0) * 0.5
        return s.ratingAvg * 10 - commutePenalty + s.spotCount * 2
      }

      const candidateCount = Math.max(1, ctx.parallelCandidates)

      // 并行生成候选（或单个）
      let generated: { day: PlannedDay; warnings: string[] }[]
      let candidateRegistries: Map<string, Poi>[] = []

      if (candidateCount === 1) {
        generated = [await generateOneCandidate(0, ctx.registry)]
      } else {
        ctx.report(`并行生成 ${candidateCount} 套方案，稍后请你挑选`, { force: true })
        candidateRegistries = Array.from({ length: candidateCount }, () => new Map(ctx.registry))
        const settled = await Promise.allSettled(
          candidateRegistries.map((reg, i) => generateOneCandidate(i, reg)),
        )

        generated = settled
          .filter((s): s is PromiseFulfilledResult<{ day: PlannedDay; warnings: string[] }> => s.status === 'fulfilled')
          .map((s) => s.value)

        if (generated.length === 0) {
          // 全部候选失败：抛第一个失败原因，走重试/跳过
          const firstError = settled.find(
            (s): s is PromiseRejectedResult => s.status === 'rejected',
          )
          throw firstError?.reason ?? new Error('所有候选方案都失败了')
        }

        // 把所有候选的 POI 登记进主表（它们已通过高德查证，后续天可以复用）
        for (const reg of candidateRegistries) {
          for (const [poiId, poi] of reg) ctx.registry.set(poiId, poi)
        }
      }

      // ④ 通勤体检（含住处往返）。每个要展示给用户的候选都要体检——
      // 用户看到的就是最终会落库的版本，不能展示一套、提交另一套。
      for (const cand of generated) {
        const commuteWarnings = await optimizeCommute(
          [cand.day],
          ctx.registry,
          (text) => ctx.report(text),
          new Set(state.usedPoiIds),
          ctx.ban,
          anchor,
          new Set(state.usedNightKinds as NightKind[]),
        )
        cand.warnings = [...cand.warnings, ...commuteWarnings]
      }

      // ⑤ 按打分排序。全自动模式取第一；交互模式取前两套给用户挑
      generated.sort((a, b) => scoreCandidate(b.day) - scoreCandidate(a.day))

      if (!interactive) {
        // 全自动：直接提交第一套（即原行为）
        const chosen = generated[0]
        ctx.log(
          `第 ${dayIndex} 天体裁：${chosen.day.dayType}（强度 ${chosen.day.intensity}）` +
            (candidateCount > 1 ? `（并行 ${generated.length} 套中评分最高）` : ''),
        )
        if (candidateCount > 1) {
          ctx.recordDecision(
            `第 ${dayIndex} 天并行生成 ${generated.length} 套方案，自动选用评分最高的一套`,
          )
        }
        const deltas = await commitDay(state, chosen.day, chosen.warnings)
        return deltas
      }

      if (candidateCount > 1) {
        // 并行择优：取前两套，构建展示数据（优缺点互相对比），挂起等用户挑。
        // 只有一套成功时降级为单方案确认——优缺点对比需要两个对象，
        // 硬凑会把 undefined 当对比项（实测崩溃：reading 'day' of undefined）。
        const shown = generated.slice(0, 2)

        if (shown.length >= 2) {
          const labels = ['A', 'B'] as const
          // 公共交通估算：用户不一定会开车，只给驾车时间没有参考意义。
          // 逐案顺序查询（transit 接口较重，且高德对并发敏感）
          const transitTotals: (number | null)[] = []
          for (const cand of shown) {
            transitTotals.push(await estimateTransitTotal(cand.day, anchor, ctx.basics.cityAdcode))
          }
          const pendingCandidates = shown.map((cand, i) => {
            const mine = statsOf(cand.day)
            const other = statsOf(shown[1 - i].day)
            const { pros, cons } = buildProsCons(mine, other)
            return {
              label: labels[i],
              summary:
                cand.day.summary ||
                cand.day.items.map((item) => item.name).join(' → ') ||
                `${cand.day.items.length} 个地点（${cand.day.dayType}）`,
              ratingAvg: Number(mine.ratingAvg.toFixed(1)),
              commuteMinutes: mine.commuteMinutes === null ? null : Math.round(mine.commuteMinutes),
              transitMinutes: transitTotals[i],
              spotCount: mine.spotCount,
              pros,
              cons,
              warnings: cand.warnings,
              day: cand.day,
            }
          })
          ctx.log(`第 ${dayIndex} 天已生成 ${generated.length} 套方案，展示前 2 套等待用户挑选`)
          return {
            pendingCandidates,
            pendingDay: null,
            dayFeedback: null,
            dayError: null,
            dayRetryCount: 0,
          }
        }
        // 只剩一套：走单方案确认
      }

      // 逐天确认（单方案）：挂起等用户确认/驳回。
      // 并行模式只剩一套成功候选时也会落到这里（见上方的降级逻辑）。
      const only = generated[0]
      const summary =
        only.day.summary ||
        only.day.items.map((item) => item.name).join(' → ') ||
        `${only.day.items.length} 个地点（${only.day.dayType}）`
      ctx.log(`第 ${dayIndex} 天已排好，等待用户确认`)
      return {
        pendingDay: { day: only.day, warnings: only.warnings, summary },
        pendingCandidates: null,
        dayFeedback: null,
        dayError: null,
        dayRetryCount: 0,
      }
    } catch (error) {
      // 回退纠错：把失败记下来，交给条件边决定是否重试。
      const msg = error instanceof Error ? error.message : String(error)
      const nextRetry = state.dayRetryCount + 1
      ctx.log(`第 ${dayIndex} 天排程失败（第 ${nextRetry} 次）：${msg}`)

      if (nextRetry > MAX_DAY_RETRIES) {
        // 重试次数用尽：放弃这一天的剩余地点，推进到下一天，避免死循环。
        // 这一天没有落库（commitDay 没执行），所以用户看到的行程里这一天是空的，
        // 但至少不会卡住整趟生成。
        ctx.log(`第 ${dayIndex} 天连续失败 ${MAX_DAY_RETRIES} 次，跳过这一天继续`)
        return {
          dayIndex: dayIndex + 1,
          dayRetryCount: 0,
          dayError: null,
          dayFeedback: null,
          warnings: [`第 ${dayIndex} 天连续失败已跳过：${msg}`],
        }
      }

      // 未超限：dayIndex 不变，重试同一天
      return {
        dayRetryCount: nextRetry,
        dayError: msg,
      }
    }
  }

  // ---- 节点：逐天人工裁决（human-in-the-loop） ------------------------------
  // 非交互模式直接透传；交互模式 interrupt 问用户：
  //   · 单方案（逐天确认）：确认采用 / 驳回重排（可附修改意见）
  //   · 双方案（并行择优）：展示 A/B 的优缺点与评分/通勤数据，用户挑一个或驳回
  // 驳回 = dayFeedback 写进状态 → 条件边回到 planDay 按意见重排同一天。
  const reviewDayNode: GraphNode<typeof AgentGraphState> = async (state) => {
    if (!interactive) return {}

    const dayIndex = state.dayIndex

    // 并行择优：两个候选等用户挑
    const candidates = state.pendingCandidates as
      | Array<{
          label: 'A' | 'B'
          summary: string
          ratingAvg: number
          commuteMinutes: number | null
          transitMinutes: number | null
          spotCount: number
          pros: string[]
          cons: string[]
          warnings: string[]
          day: PlannedDay
        }>
      | null
    if (ctx.parallelCandidates > 1 && Array.isArray(candidates) && candidates.length > 0) {
      // interrupt 载荷只放展示数据，完整的 day 留在图状态里（不推给前端）
      const answer = (await interrupt({
        kind: 'choose',
        dayIndex,
        totalDays: state.totalDays,
        candidates: candidates.map(({ day: _day, warnings: _warnings, ...rest }) => rest),
      })) as ReviewAnswer | undefined

      if (answer?.decision === 'reject') {
        const feedback = (answer.feedback ?? '').trim()
        ctx.log(`第 ${dayIndex} 天两个方案都被驳回${feedback ? `：${feedback}` : '（未填具体意见）'}`)
        ctx.recordDecision(`第 ${dayIndex} 天两个候选方案均被用户驳回，将按意见重排`)
        return {
          dayFeedback:
            feedback ||
            '用户对上一版两个方案都不满意，请换一批不同的地点重新安排这一天的行程',
          pendingCandidates: null,
          pendingDay: null,
        }
      }

      const chosen = candidates.find((c) => c.label === answer?.choice) ?? candidates[0]
      ctx.log(`第 ${dayIndex} 天用户选择了方案${chosen.label}`)
      const deltas = await commitDay(state, chosen.day, chosen.warnings)
      return { ...deltas, pendingCandidates: null, pendingDay: null }
    }

    // 逐天确认：单方案等用户确认/驳回
    const pending = state.pendingDay as
      | { day: PlannedDay; warnings: string[]; summary: string }
      | null
    if (pending) {
      const answer = (await interrupt({
        kind: 'confirm',
        dayIndex,
        totalDays: state.totalDays,
        summary: pending.summary,
      })) as ReviewAnswer | undefined

      if (answer?.decision === 'reject') {
        const feedback = (answer.feedback ?? '').trim()
        ctx.log(`第 ${dayIndex} 天被驳回${feedback ? `：${feedback}` : '（未填具体意见）'}`)
        ctx.recordDecision(`第 ${dayIndex} 天方案被用户驳回，将按意见重排`)
        return {
          dayFeedback:
            feedback || '用户对上一版方案不满意，请换一批不同的地点重新安排这一天的行程',
          pendingCandidates: null,
          pendingDay: null,
        }
      }

      ctx.log(`第 ${dayIndex} 天用户确认采用`)
      const deltas = await commitDay(state, pending.day, pending.warnings)
      return { ...deltas, pendingDay: null, pendingCandidates: null }
    }

    // 没有挂起内容（例如当天被跳过），透传
    return {}
  }

  // ---- 节点：收尾 ----------------------------------------------------------
  const finalizeNode: GraphNode<typeof AgentGraphState> = async () => {
    await prisma.trip.update({
      where: { id: ctx.tripId },
      data: { status: 'ready', genProgress: null, genError: null, genReview: null },
    })
    ctx.log('全部完成')
    return { finished: true }
  }

  // ---- 条件边 --------------------------------------------------------------
  // reviewDay 之后路由。优先级：
  //   1. 当前天失败（dayError）→ 回 planDay 重试（V4 回退纠错）
  //   2. 当前天被驳回（dayFeedback）→ 回 planDay 按意见重排（dayIndex 未推进）
  //   3. 还有下一天 → planDay
  //   4. 全部排完 → finalize
  //
  // 刻意不做「回退到前一天」：那会覆盖已落库、用户可能已确认的结果，
  // 风险高收益低；重试/重排当前天已能兜住绝大多数问题。
  const MAX_DAY_RETRIES = 2
  const shouldContinue: ConditionalEdgeRouter<{
    InputSchema: typeof AgentGraphState
    Nodes: 'planDay' | 'finalize'
  }> = (state) => {
    if (state.dayError || state.dayFeedback) return 'planDay'
    return state.dayIndex <= state.totalDays ? 'planDay' : 'finalize'
  }

  return new StateGraph(AgentGraphState)
    .addNode('resolveAnchor', resolveAnchorNode)
    .addNode('planDay', planDayNode)
    .addNode('reviewDay', reviewDayNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'resolveAnchor')
    .addEdge('resolveAnchor', 'planDay')
    // planDay → reviewDay → 条件边：交互模式会 interrupt，全自动模式透传
    .addEdge('planDay', 'reviewDay')
    .addConditionalEdges('reviewDay', shouldContinue, ['planDay', 'finalize'])
    .addEdge('finalize', END)
    .compile(checkpointer ? { checkpointer } : undefined)
}
