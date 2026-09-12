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

import { END, START, StateGraph, interrupt, type BaseCheckpointSaver, type ConditionalEdgeRouter, type GraphNode } from '@langchain/langgraph'
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
  /**
   * 逐天人工确认模式（V3）。为 true 时，每排完一天都会 interrupt 暂停，
   * 等用户在前端确认后再排下一天——这是 LangGraph human-in-the-loop 的落点。
   * 默认 false（全自动），保持与手写版一致的行为。
   */
  reviewMode: boolean
  /**
   * 并行候选方案数（V4 并行择优）。>1 时同一天并行生成 N 套方案再择优，
   * 成本随 N 线性增长（每套都是一次完整的模型+高德往返），默认 1 = 关闭。
   */
  parallelCandidates: number
  /**
   * 记录一条关键决策（V5 可视化）。落进 Trip.genDecisions（JSON 数组），
   * 完成后前端可回看「AI 是怎么排的」。写失败不影响生成主流程。
   */
  recordDecision: (text: string) => void
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
 *
 * @param ctx 外部上下文（凭证、登记表、天气、落库函数等）
 * @param checkpointer 状态快照器。V1 不传（无断点），V2 起传 SqliteSaver，
 *   让图状态在进程重启后也能恢复，实现「节点级」断点续跑。
 */
export function buildAgentGraph(ctx: AgentGraphContext, checkpointer?: BaseCheckpointSaver) {
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

  // ---- 节点：单天排程 ------------------------------------------------------
  // V4 回退纠错：排程失败不再抛错中断整张图，而是 catch 后把失败信息写进状态，
  // 条件边据此决定「重试当前天」还是「放弃继续」。这样模型偶发的格式错误、
  // 高德偶发的连接中断，都有机会在同一天内自动重试，而不是让用户整趟重来。
  //
  // V4 并行择优：ctx.parallelCandidates > 1 时，同一并行生成 N 套候选方案
  // （各自独立 registry 快照，避免写竞争），再按启发式打分选最优落库。
  // 默认 1 = 不并行，行为与 V1 完全一致，不增加成本。
  const planDayNode: GraphNode<typeof AgentGraphState> = async (state) => {
    const dayIndex = state.dayIndex

    try {
      const dateKey = addDays(ctx.basics.startDate, dayIndex - 1)
      const cast = ctx.weatherByDate.get(dateKey) ?? null

      ctx.report(`正在安排第 ${dayIndex}/${state.totalDays} 天`, { force: true })
      ctx.log(`--- 第 ${dayIndex} 天（${dateKey}）开始 ---`)

      const anchor = ctx.anchor
      if (!anchor) throw new Error('住宿锚点尚未确定，无法排程')

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
       * 不再调一次模型打分——那要额外烧 token，且启发式对「择优」已经够用。
       */
      const scoreCandidate = (day: PlannedDay): number => {
        const spots = day.items.filter((item) => item.itemType === 'spot')
        const avgRating =
          spots.length > 0
            ? spots.reduce((sum, item) => sum + (item.rating ? Number(item.rating) : 0), 0) /
              spots.length
            : 0
        const totalCommute = day.items.reduce(
          (sum, item) => sum + (item.commuteMinutes ?? 0),
          0,
        )
        // 评分权重高一些（用户更在意去的地方好不好），通勤其次
        return avgRating * 10 - totalCommute * 0.5 + spots.length * 2
      }

      // 并行生成候选（或单个）
      const candidateCount = Math.max(1, ctx.parallelCandidates)
      let chosenDay: PlannedDay
      let chosenWarnings: string[]

      if (candidateCount === 1) {
        const only = await generateOneCandidate(0, ctx.registry)
        chosenDay = only.day
        chosenWarnings = only.warnings
      } else {
        ctx.report(`并行生成 ${candidateCount} 套方案后择优`, { force: true })
        const candidateRegistries = Array.from({ length: candidateCount }, () =>
          new Map(ctx.registry),
        )
        const settled = await Promise.allSettled(
          candidateRegistries.map((reg, i) => generateOneCandidate(i, reg)),
        )

        // 打分择优：失败/空方案不参与，全失败才走外层 catch 的重试逻辑
        const scored = settled
          .filter((s): s is PromiseFulfilledResult<{ day: PlannedDay; warnings: string[] }> => s.status === 'fulfilled')
          .map((s) => ({ ...s.value, score: scoreCandidate(s.value.day) }))
          .sort((a, b) => b.score - a.score)

        if (scored.length === 0) {
          // 全部候选失败：抛第一个失败原因，走重试/跳过
          const firstError = settled.find(
            (s): s is PromiseRejectedResult => s.status === 'rejected',
          )
          throw firstError?.reason ?? new Error('所有候选方案都失败了')
        }

        chosenDay = scored[0].day
        chosenWarnings = scored[0].warnings
        ctx.log(
          `第 ${dayIndex} 天并行 ${settled.length} 套方案，选中第 1 优（评分 ${scored[0].score.toFixed(1)}，` +
            `其余 ${scored
              .slice(1)
              .map((s) => s.score.toFixed(1))
              .join('、') || '无'}）`,
        )
        ctx.recordDecision(
          `第 ${dayIndex} 天并行生成 ${settled.length} 套方案，择优选用评分最高的一套（${scored[0].score.toFixed(1)} 分）`,
        )
        // 把落选候选的 POI 也登记进主表（它们已通过高德查证，后续天可以复用）
        for (const reg of candidateRegistries) {
          for (const [poiId, poi] of reg) ctx.registry.set(poiId, poi)
        }
      }

      const day = chosenDay

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
      chosenWarnings = [...chosenWarnings, ...commuteWarnings]

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
      // 体裁判定是跨天传导的关键决策，记录下来供用户回看
      ctx.recordDecision(
        `第 ${dayIndex} 天体裁判定为「${day.dayType}」（强度 ${day.intensity}），安排 ${day.items.length} 个地点`,
      )

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
        warnings: chosenWarnings,
        pendingDaySummary: day.summary || `${day.items.length} 个地点（${day.dayType}）`,
        dayRetryCount: 0,
        dayError: null,
      }
    } catch (error) {
      // 回退纠错：把失败记下来，交给条件边决定是否重试。
      const msg = error instanceof Error ? error.message : String(error)
      const nextRetry = state.dayRetryCount + 1
      ctx.log(`第 ${dayIndex} 天排程失败（第 ${nextRetry} 次）：${msg}`)

      if (nextRetry > MAX_DAY_RETRIES) {
        // 重试次数用尽：放弃这一天的剩余地点，推进到下一天，避免死循环。
        // 这一天没有落库（persistDay 没执行），所以用户看到的行程里这一天是空的，
        // 但至少不会卡住整趟生成。
        ctx.log(`第 ${dayIndex} 天连续失败 ${MAX_DAY_RETRIES} 次，跳过这一天继续`)
        return {
          dayIndex: dayIndex + 1,
          dayRetryCount: 0,
          dayError: null,
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

  // ---- 节点：逐天人工确认（V3 human-in-the-loop） ---------------------------
  // 只在 ctx.reviewMode 为 true 时才有存在意义：否则直接透传，等价于没有这个节点。
  // interrupt 会暂停图执行，把 pendingDaySummary 抛给前端；前端用 Command(resume)
  // 恢复后，节点把用户的决定（approved / regenerate）写回状态。
  const reviewDayNode: GraphNode<typeof AgentGraphState> = async (state) => {
    if (!ctx.reviewMode) return {}

    const decision = interrupt({
      dayIndex: state.dayIndex - 1,
      summary: state.pendingDaySummary,
      question: '这一天的安排是否满意？',
    })

    // decision: 'approved' 继续排下一天；'regenerate' 让调用方知道要重排（当前 V3 先只支持 approved）
    if (decision !== 'approved') {
      throw new Error('用户要求重排这一天（V3 暂仅支持确认通过）')
    }
    return { pendingDaySummary: null }
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
  // reviewDay 之后路由。优先级：
  //   1. 当前天失败（dayError 非空）→ 回 planDay 重试（dayIndex 未推进，
  //      重排同一天；超限时 planDay 内部已自行跳过并推进 dayIndex）
  //   2. 还有下一天 → planDay
  //   3. 全部排完 → finalize
  //
  // V4 回退是「重试当前天」而非「回退到前一天」：回退前一天会覆盖已落库、
  // 用户可能已确认的结果，风险高收益低；重试当前天已能兜住绝大多数偶发失败。
  const MAX_DAY_RETRIES = 2
  const shouldContinue: ConditionalEdgeRouter<{
    InputSchema: typeof AgentGraphState
    Nodes: 'planDay' | 'finalize'
  }> = (state) => {
    if (state.dayError) return 'planDay'
    return state.dayIndex <= state.totalDays ? 'planDay' : 'finalize'
  }

  return new StateGraph(AgentGraphState)
    .addNode('resolveAnchor', resolveAnchorNode)
    .addNode('planDay', planDayNode)
    .addNode('reviewDay', reviewDayNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'resolveAnchor')
    .addEdge('resolveAnchor', 'planDay')
    // planDay → reviewDay → 条件边：review 模式会 interrupt，非 review 模式透传
    .addEdge('planDay', 'reviewDay')
    .addConditionalEdges('reviewDay', shouldContinue, ['planDay', 'finalize'])
    .addEdge('finalize', END)
    .compile(checkpointer ? { checkpointer } : undefined)
}
