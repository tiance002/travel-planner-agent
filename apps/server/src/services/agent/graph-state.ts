// LangGraph 图状态定义。
//
// 这是把「手写 while 循环」改写成 LangGraph 图之后，最需要想清楚的地方：
// 图里的每个节点共享这一份状态，状态会随着图执行被 checkpointer 自动快照。
//
// 一个关键约束：**放进图状态的字段必须是可 JSON 序列化的**——
// 因为 checkpointer 要把状态序列化存档，像 Map、函数、网络连接这类东西不能放进来。
// 所以「POI 登记表 registry」「天气」「模型凭证」这些不可序列化或体积大的对象，
// 都放在图外的闭包里（见 graph.ts 的 AgentGraphContext），图状态只放轻量的、
// 需要跨节点传递的进度与去重信息。
//
// 状态字段的两类写法（都是 LangGraph JS 1.4.x 的 StateSchema 约定）：
//   - 标量字段（dayIndex、totalDays、previousDayState、finished）直接用 zod schema，
//     语义是「覆盖」——节点返回新值就整体替换。
//   - 需要跨节点累积的字段（usedPoiIds、previousPlaces、usedNightKinds、warnings）
//     用 ReducedValue，配一个 reducer 说明「新值怎么合并进旧值」。

import { ReducedValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod'

/** 跨天传导需要记住的上一天状态。只有 dayType 与 intensity 两个标量，天然可序列化 */
export const DayStateRefSchema = z.object({
  dayType: z.string(),
  intensity: z.string(),
})

export type DayStateRef = z.infer<typeof DayStateRefSchema>

/**
 * 图状态。
 *
 * 字段按用途分三类：
 *   - 进度：dayIndex（当前排到第几天）、totalDays（共几天）
 *   - 跨天去重/传导：usedPoiIds（已用地点）、previousPlaces（已用地名）、
 *     usedNightKinds（已去过的夜生活类别）、previousDayState（昨天的天型强度）
 *   - 结果：warnings（累积的规则修正提示）、finished（是否全部排完）
 */
export const AgentGraphState = new StateSchema({
  /** 当前要排的天序号，从 1 开始。标量，覆盖式 */
  dayIndex: z.number().int().min(1),
  /** 行程总天数。标量，覆盖式 */
  totalDays: z.number().int().min(1),
  /** 已用过的 poiId。Set 不能序列化，用数组 + reducer 合并去重 */
  usedPoiIds: new ReducedValue(z.array(z.string()), {
    reducer: (a, b) => Array.from(new Set([...a, ...b])),
  }),
  /** 已安排过的地点名，写进提示词避免跨天重复。数组追加 */
  previousPlaces: new ReducedValue(z.array(z.string()), {
    reducer: (a, b) => [...a, ...b],
  }),
  /** 已去过的夜生活类别（bar / snack_street），整趟各只一次。合并去重 */
  usedNightKinds: new ReducedValue(z.array(z.string()), {
    reducer: (a, b) => Array.from(new Set([...a, ...b])),
  }),
  /** 前一天的天型与强度，跨天传导的唯一通道。标量（对象），覆盖式 */
  previousDayState: DayStateRefSchema.nullable(),
  /** 累积的规则修正提示。数组追加 */
  warnings: new ReducedValue(z.array(z.string()), {
    reducer: (a, b) => [...a, ...b],
  }),
  /** 是否已全部排完。标量，覆盖式 */
  finished: z.boolean(),
  /**
   * 刚排好的这一天的摘要（供 review 模式下 interrupt 展示给用户确认）。
   * 标量字符串，覆盖式。null 表示没有待确认的摘要。
   */
  pendingDaySummary: z.string().nullable(),
  /**
   * 当前这一天的连续失败次数（V4 回退纠错用）。
   * planDay 排程失败时不抛错，而是把失败信息记下来、这个计数 +1；
   * 条件边据此决定「重试当前天」还是「放弃并继续」。覆盖式。
   */
  dayRetryCount: z.number().int().min(0),
  /**
   * 当前这一天的失败信息。非 null 表示这一天的排程遇到了问题（V4 回退纠错）。
   * 覆盖式。
   */
  dayError: z.string().nullable(),
})

/** 从图状态里取字段的类型，供节点函数标注参数 */
export type AgentState = typeof AgentGraphState.State
