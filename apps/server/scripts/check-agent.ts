// **生产图编排**的行为自检（见审查报告任务5、任务8、任务9）。
//
// 与 check-graph.ts 的根本区别：
//   check-graph.ts 另造了几个「结构相似」的 StateGraph 来验证「LangGraph 本身好不好使」，
//   它验证的不是我们的代码。本脚本直接驱动**生产实现 buildAgentGraph(ctx)**——
//   通过注入 mock 的 chatClient（替代模型）与 toolRunner（替代高德），
//   在零网络、零模型额度下让**同一份生产图**完整跑一遍，
//   再把断言打在**真实的数据库落库结果**上。
//
// 这样测到的是真正会出问题的东西：图拓扑、条件边、跨天状态、断点续跑跳过、
// warnings 累积、ready/partial 判定——全是生产路径。
//
// 用法：在 apps/server 目录 `npx tsx scripts/check-agent.ts`

import { prisma } from '../src/db'
import { buildAgentGraph, type AgentGraphContext } from '../src/services/agent/graph'
import type { Poi } from '../src/services/amap'
import type { ToolResult } from '../src/services/agent/tools'
import type { ToolLoopResult } from '../src/services/agent/model-client'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name}`)
  }
}

const suffix = Math.random().toString(36).slice(2, 10)
const createdTripIds: string[] = []
let tempUserId = ''

// ---------------------------------------------------------------------------
// 造一个可信 POI。坐标只来自「高德」，这里用 mock toolRunner 模拟高德返回
// ---------------------------------------------------------------------------

function makePoi(poiId: string, name: string, opts: Partial<Poi> = {}): Poi {
  return {
    poiId,
    name,
    lng: 120.15,
    lat: 30.28,
    address: '杭州市西湖区',
    type: '风景名胜;公园广场;公园',
    typecode: '110101',
    cityName: '杭州',
    district: '西湖区',
    adcode: '330100',
    rating: 4.6,
    cost: null,
    tag: '',
    keytag: '',
    openTimeToday: '00:00-24:00',
    openTimeWeek: '00:00-24:00',
    tel: '',
    photos: [],
    distance: null,
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// mock 工具：把预置 POI 登记进 registry，并回给模型
// ---------------------------------------------------------------------------

interface MockToolOptions {
  /** 每次 search_poi 要返回的 POI（按调用次数轮换） */
  poiBatches: Poi[][]
  /** get_route 是否成功 */
  routeOk?: boolean
}

function makeToolRunner(opts: MockToolOptions) {
  let callIndex = 0
  return async (name: string, _rawArgs: string, ctx: { registry: Map<string, Poi> }): Promise<ToolResult> => {
    if (name === 'search_poi' || name === 'search_nearby') {
      const batch = opts.poiBatches[Math.min(callIndex, opts.poiBatches.length - 1)] ?? []
      callIndex += 1
      for (const poi of batch) ctx.registry.set(poi.poiId, poi)
      return { ok: true, data: batch.map((p) => ({ poiId: p.poiId, name: p.name, rating: p.rating })) }
    }
    if (name === 'get_route') {
      if (opts.routeOk === false) return { ok: false, error: '路线查询失败' }
      return { ok: true, data: { minutes: 15, distance: 3200 } }
    }
    if (name === 'get_city_center') {
      return { ok: true, data: { lng: 120.15, lat: 30.28 } }
    }
    if (name === 'get_weather') {
      return { ok: true, data: { casts: [] } }
    }
    return { ok: false, error: `未预期的工具：${name}` }
  }
}

// ---------------------------------------------------------------------------
// mock 模型：按顺序吐出预置的 JSON 文本
// ---------------------------------------------------------------------------

function makeChatClient(responses: string[]) {
  let index = 0
  return async (): Promise<ToolLoopResult> => {
    const content = responses[Math.min(index, responses.length - 1)] ?? '{}'
    index += 1
    return { content, messages: [], rounds: 1, toolCallCount: 0, finishReason: 'stop' }
  }
}

/** 造一份「单天」的模型输出 JSON */
function dayJson(
  dayIndex: number,
  items: Array<{ poiId: string; itemType: 'spot' | 'restaurant' | 'hotel'; slot: string }>,
  summary = `第 ${dayIndex} 天安排`,
): string {
  return JSON.stringify({
    days: [{ dayIndex, summary, items }],
  })
}

async function makeTrip(days: number, status = 'draft'): Promise<{ id: string }> {
  const trip = await prisma.trip.create({
    data: {
      userId: tempUserId,
      title: `图自检-${suffix}-${createdTripIds.length}`,
      cityName: '杭州',
      cityAdcode: '330100',
      startDate: new Date('2026-10-01'),
      days,
      travelers: 2,
      status,
      // 住宿锚点直接给定，省掉 resolveAnchor 节点（该节点已有其它覆盖）
      stayResolved: true,
      stayPoiId: 'HOTEL1',
      stayName: '西湖边的酒店',
      stayLng: 120.15,
      stayLat: 30.28,
    },
  })
  createdTripIds.push(trip.id)
  return { id: trip.id }
}

/** 构造一个生产图上下文，模型与工具都注入 mock */
function makeCtx(
  tripId: string,
  responses: string[],
  toolOpts: MockToolOptions,
): AgentGraphContext {
  const registry = new Map<string, Poi>()
  // 住宿锚点也进登记表
  registry.set('HOTEL1', makePoi('HOTEL1', '西湖边的酒店', { type: '住宿服务;宾馆酒店', typecode: '100100' }))
  // 关键：mock 模型直接吐 JSON、不真的走工具循环，所以 search_poi 不会被调用，
  // 登记表里也就不会有那些 POI。生产里它们是由工具循环写入登记表的——
  // 这里在构建上下文时**预登记**全部批次，等价于「高德已经查证过这些点」，
  // 否则 validateDay 会把每一个 poiId 都当「不在候选列表」丢弃，测不出真实行为。
  for (const batch of toolOpts.poiBatches) {
    for (const poi of batch) registry.set(poi.poiId, poi)
  }

  const logs: string[] = []
  return {
    tripId,
    credentials: { provider: 'mock', baseUrl: 'https://mock.local/v1', modelName: 'mock', apiKey: 'k' },
    registry,
    toolContext: { cityName: '杭州', cityAdcode: '330100', registry, report: () => {} },
    basics: {
      cityName: '杭州',
      cityAdcode: '330100',
      startDate: '2026-10-01',
      days: 3,
      travelers: 2,
      preferences: [],
      extraNeeds: [],
      budgetAmount: null,
      budgetScope: 'per_person',
    },
    ban: {},
    anchor: registry.get('HOTEL1')!,
    weatherByDate: new Map(),
    report: () => {},
    log: (line) => logs.push(line),
    persistDay: makePersistDay(tripId),
    maxToolRounds: 6,
    reviewMode: false,
    parallelCandidates: 1,
    recordDecision: () => {},
    chatClient: makeChatClient(responses) as unknown as AgentGraphContext['chatClient'],
    toolRunner: makeToolRunner(toolOpts) as unknown as AgentGraphContext['toolRunner'],
  }
}

/**
 * 与生产 graph-run.ts 中的落库实现保持同一事务语义。
 *
 * 签名必须与 AgentGraphContext.persistDay 一致：**只接收 (day, date, weather)**——
 * tripId 由图上下文（闭包）提供。生产里 Trip 是外部变量，这里从闭包捕获。
 */
function makePersistDay(tripId: string) {
  return async function persistDay(
    day: import('../src/services/agent/scheduler').PlannedDay,
    date: Date,
    weather: unknown,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.tripDay.deleteMany({ where: { tripId, dayIndex: day.dayIndex } })
      await tx.tripDay.create({
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
    })
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  const user = await prisma.user.create({ data: { username: `agent-${suffix}`, passwordHash: 'x' } })
  tempUserId = user.id

  // =========================================================================
  console.log('\n--- 【任务5/8】生产图：三天全自动生成 → 落库 + ready ---')
  // =========================================================================

  const tripA = await makeTrip(3)
  // 三天各自的 POI 批次（每天后推 search_poi 会拿到新的批次）
  const batchesA: Poi[][] = [
    [makePoi('S1', '西湖'), makePoi('R1', '楼外楼', { type: '餐饮服务;中餐厅', typecode: '050100', rating: 4.7 })],
    [makePoi('S2', '灵隐寺'), makePoi('R2', '知味观', { type: '餐饮服务;中餐厅', typecode: '050100', rating: 4.4 })],
    [makePoi('S3', '雷峰塔'), makePoi('R3', '外婆家', { type: '餐饮服务;中餐厅', typecode: '050100', rating: 4.3 })],
  ]
  const responsesA = [
    dayJson(1, [
      { poiId: 'S1', itemType: 'spot', slot: 'morning' },
      { poiId: 'R1', itemType: 'restaurant', slot: 'noon' },
    ]),
    dayJson(2, [
      { poiId: 'S2', itemType: 'spot', slot: 'morning' },
      { poiId: 'R2', itemType: 'restaurant', slot: 'noon' },
    ]),
    dayJson(3, [
      { poiId: 'S3', itemType: 'spot', slot: 'morning' },
      { poiId: 'R3', itemType: 'restaurant', slot: 'noon' },
    ]),
  ]

  const ctxA = makeCtx(tripA.id, responsesA, { poiBatches: batchesA })
  const graphA = buildAgentGraph(ctxA)
  await graphA.invoke({
    dayIndex: 1,
    totalDays: 3,
    usedPoiIds: [],
    previousPlaces: [],
    usedNightKinds: [],
    previousDayState: null,
    warnings: [],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    gapDays: [],
  })

  const daysA = await prisma.tripDay.findMany({
    where: { tripId: tripA.id },
    orderBy: { dayIndex: 'asc' },
    include: { items: true },
  })
  check('三天全部落库', daysA.length, 3)
  check('每天都有条目', daysA.length === 3 && daysA.every((d) => d.items.length > 0), true)
  check('dayIndex 连续 1,2,3', daysA.map((d) => d.dayIndex), [1, 2, 3])
  // 三天全自动跑完 → finalize 应写 ready（任务8：完成判定不能假成功）
  const tripAAfter = await prisma.trip.findUnique({ where: { id: tripA.id } })
  check('三天全部落库后状态为 ready', tripAAfter?.status, 'ready')

  // =========================================================================
  console.log('\n--- 【任务5】断点续跑：缺第 2 天，不得覆盖第 3 天 ---')
  // =========================================================================

  const tripB = await makeTrip(3)
  // 先手工落库第 1 天与第 3 天（模拟「第 2 天失败被跳过」的历史状态）
  await prisma.tripDay.create({
    data: {
      tripId: tripB.id,
      dayIndex: 1,
      date: new Date('2026-10-01'),
      summary: '已有的第1天',
      dayType: 'normal',
      intensity: 'medium',
      items: {
        create: [
          { orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'OLD1', name: '老西湖', lng: 120.1, lat: 30.2, photos: null },
        ],
      },
    },
  })
  await prisma.tripDay.create({
    data: {
      tripId: tripB.id,
      dayIndex: 3,
      date: new Date('2026-10-03'),
      summary: '已有的第3天（用户已确认）',
      dayType: 'normal',
      intensity: 'medium',
      items: {
        create: [
          { orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'OLD3', name: '老雷峰塔', lng: 120.1, lat: 30.2, photos: null },
        ],
      },
    },
  })

  // 只补第 2 天
  const batchesB: Poi[][] = [
    [makePoi('S2B', '灵隐寺'), makePoi('R2B', '知味观', { type: '餐饮服务;中餐厅', typecode: '050100', rating: 4.4 })],
  ]
  const responsesB = [
    dayJson(2, [
      { poiId: 'S2B', itemType: 'spot', slot: 'morning' },
      { poiId: 'R2B', itemType: 'restaurant', slot: 'noon' },
    ]),
  ]
  const ctxB = makeCtx(tripB.id, responsesB, { poiBatches: batchesB })
  const graphB = buildAgentGraph(ctxB)
  await graphB.invoke({
    dayIndex: 1,
    totalDays: 3,
    usedPoiIds: ['OLD1', 'OLD3'],
    previousPlaces: ['老西湖', '老雷峰塔'],
    usedNightKinds: [],
    previousDayState: null,
    warnings: [],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    // 第 1、3 天已存在 → 图应跳过它们，只排第 2 天
    gapDays: [1, 3],
  })

  const daysB = await prisma.tripDay.findMany({
    where: { tripId: tripB.id },
    orderBy: { dayIndex: 'asc' },
    include: { items: true },
  })
  check('补第2天后仍是 3 天', daysB.length, 3)
  check('第 1 天未被覆盖', daysB.find((d) => d.dayIndex === 1)?.summary, '已有的第1天')
  check('第 3 天未被覆盖（关键：不覆盖后续已有天）', daysB.find((d) => d.dayIndex === 3)?.summary, '已有的第3天（用户已确认）')
  check('第 3 天的原有条目仍在', daysB.find((d) => d.dayIndex === 3)?.items[0]?.name, '老雷峰塔')
  check('第 2 天被补齐', daysB.find((d) => d.dayIndex === 2)?.items.length, 2)

  // =========================================================================
  console.log('\n--- 【任务5】全断点续跑：没有任何缺失 → 一天都不重排 ---')
  // =========================================================================

  const tripC = await makeTrip(2)
  await prisma.tripDay.create({
    data: {
      tripId: tripC.id,
      dayIndex: 1,
      date: new Date('2026-10-01'),
      summary: '第一天已定',
      dayType: 'normal',
      intensity: 'medium',
      items: { create: [{ orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'C1', name: 'C1', lng: 120.1, lat: 30.2, photos: null }] },
    },
  })
  await prisma.tripDay.create({
    data: {
      tripId: tripC.id,
      dayIndex: 2,
      date: new Date('2026-10-02'),
      summary: '第二天已定',
      dayType: 'normal',
      intensity: 'medium',
      items: { create: [{ orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'C2', name: 'C2', lng: 120.1, lat: 30.2, photos: null }] },
    },
  })

  // 模型若被调用会返回一个「不同的摘要」，用来证明「没有被调用」
  const ctxC = makeCtx(tripC.id, [dayJson(1, [{ poiId: 'S1', itemType: 'spot', slot: 'morning' }], '不该出现')], {
    poiBatches: [[makePoi('S1', '不该出现的点')]],
  })
  const graphC = buildAgentGraph(ctxC)
  await graphC.invoke({
    dayIndex: 1,
    totalDays: 2,
    usedPoiIds: [],
    previousPlaces: [],
    usedNightKinds: [],
    previousDayState: null,
    warnings: [],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    gapDays: [1, 2],
  })
  const daysC = await prisma.tripDay.findMany({ where: { tripId: tripC.id }, orderBy: { dayIndex: 'asc' } })
  check('完全没有缺失时不重排（内容保持原样）', daysC.map((d) => d.summary), ['第一天已定', '第二天已定'])

  // =========================================================================
  console.log('\n--- 【任务8】warnings 跨天累积，不互相覆盖 ---')
  // =========================================================================

  const tripD = await makeTrip(2)
  // 第 1 天故意安排一个「不存在于登记表」的 poiId → 触发 warn「不在候选列表中，已丢弃」
  // 第 2 天正常 → 第 1 天的 warning 不该被第 2 天冲掉
  const batchesD: Poi[][] = [
    [makePoi('S1D', '西湖')],
    [makePoi('S2D', '灵隐寺')],
  ]
  const responsesD = [
    // 第 1 天：先给一个伪造 poiId（触发 warning），再给一个真实点
    JSON.stringify({
      days: [
        {
          dayIndex: 1,
          summary: '第一天',
          items: [
            { poiId: 'GHOST', itemType: 'spot', slot: 'morning' },
            { poiId: 'S1D', itemType: 'spot', slot: 'afternoon' },
          ],
        },
      ],
    }),
    dayJson(2, [{ poiId: 'S2D', itemType: 'spot', slot: 'morning' }]),
  ]
  const ctxD = makeCtx(tripD.id, responsesD, { poiBatches: batchesD })
  const graphD = buildAgentGraph(ctxD)
  await graphD.invoke({
    dayIndex: 1,
    totalDays: 2,
    usedPoiIds: [],
    previousPlaces: [],
    usedNightKinds: [],
    previousDayState: null,
    warnings: [],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    gapDays: [],
  })

  // 直接检查最终状态：模拟 finalize 的读取
  const persistedD = await prisma.tripDay.findMany({ where: { tripId: tripD.id }, orderBy: { dayIndex: 'asc' } })
  check('两天的落库都存在', persistedD.length, 2)

  // 第 1 天产出「不在候选列表中，已丢弃」的提示；第 2 天正常落库。
  // 关键（任务8 第4~6点）：第 1 天的提示必须**跨天保留**——
  // commitDay 若只写当天的 warnings，第 2 天提交时就会把它冲掉。
  const tripDAfter = await prisma.trip.findUnique({ where: { id: tripD.id } })
  const warningsD = JSON.parse(tripDAfter?.genWarnings ?? '[]') as string[]
  check(
    '第 1 天的 warning 跨天保留了下来',
    warningsD.some((w) => w.includes('不在候选列表')),
    true,
  )
  check('两天的落库后状态为 ready', tripDAfter?.status, 'ready')

  // =========================================================================
  console.log('\n--- 【任务8】finalize 判定：全部落库 → ready ---')
  // =========================================================================

  // 让图跑到 finalize（totalDays 设为已落库天数，图会走完 finalize 节点）
  await prisma.trip.update({ where: { id: tripD.id }, data: { days: 2 } })
  const ctxE = makeCtx(tripD.id, [dayJson(1, [{ poiId: 'S1D', itemType: 'spot', slot: 'morning' }])], {
    poiBatches: batchesD,
  })
  const graphE = buildAgentGraph(ctxE)
  await graphE.invoke({
    dayIndex: 1,
    totalDays: 2,
    usedPoiIds: [],
    previousPlaces: [],
    usedNightKinds: [],
    previousDayState: null,
    warnings: ['第 1 天有一条测试提示'],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    gapDays: [1, 2],
  })

  // =========================================================================
  console.log('\n--- 【任务8】缺天判定：finalize 应给出 partial 而不是 ready ---')
  // =========================================================================

  const tripF = await makeTrip(3)
  // 只落库第 1 天；totalDays=3 → finalize 应判 partial
  await prisma.tripDay.create({
    data: {
      tripId: tripF.id,
      dayIndex: 1,
      date: new Date('2026-10-01'),
      summary: '只有第一天',
      dayType: 'normal',
      intensity: 'medium',
      items: { create: [{ orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'F1', name: 'F1', lng: 120.1, lat: 30.2, photos: null }] },
    },
  })
  // 图从第 1 天开始，gapDays=[1]，第 1 天跳过；第 2、3 天模型会失败（返回空）→ 最终缺 2、3 天
  const ctxF = makeCtx(tripF.id, ['{}', '{}', '{}'], { poiBatches: [[makePoi('X1', '不应被用')]] })
  const graphF = buildAgentGraph(ctxF)
  await graphF.invoke({
    dayIndex: 1,
    totalDays: 3,
    usedPoiIds: [],
    previousPlaces: [],
    usedNightKinds: [],
    previousDayState: null,
    warnings: [],
    finished: false,
    pendingDaySummary: null,
    dayRetryCount: 0,
    dayError: null,
    dayFeedback: null,
    pendingDay: null,
    pendingCandidates: null,
    gapDays: [1],
  })

  // finalize 节点会写 Trip.status（真实生产实现就这么做）
  const tripFAfter = await prisma.trip.findUnique({ where: { id: tripF.id } })
  check('缺天时状态为 partial', tripFAfter?.status, 'partial')
  check('partial 时 genError 说明了缺失的天', typeof tripFAfter?.genError === 'string' && tripFAfter.genError.includes('2'), true)

  // ==========================================================================
  console.log('\n--- 【任务8】覆盖已有数据验证：重排同一天是替换而非追加 ---')
  // ==========================================================================

  const tripG = await makeTrip(1)
  const ctxG1 = makeCtx(tripG.id, [dayJson(1, [{ poiId: 'G1', itemType: 'spot', slot: 'morning' }], '第一版')], {
    poiBatches: [[makePoi('G1', '第一版点')]],
  })
  await buildAgentGraph(ctxG1).invoke({
    dayIndex: 1, totalDays: 1, usedPoiIds: [], previousPlaces: [], usedNightKinds: [],
    previousDayState: null, warnings: [], finished: false, pendingDaySummary: null,
    dayRetryCount: 0, dayError: null, dayFeedback: null, pendingDay: null, pendingCandidates: null, gapDays: [],
  })
  const firstVersion = await prisma.tripDay.findMany({ where: { tripId: tripG.id }, include: { items: true } })
  check('首次生成 1 天 1 条', firstVersion.length === 1 && firstVersion[0].items.length === 1, true)

  // 再排同一天（gapDays 为空 → 会重排），应替换而不是累积
  const ctxG2 = makeCtx(tripG.id, [dayJson(1, [{ poiId: 'G2', itemType: 'spot', slot: 'morning' }], '第二版')], {
    poiBatches: [[makePoi('G2', '第二版点')]],
  })
  await buildAgentGraph(ctxG2).invoke({
    dayIndex: 1, totalDays: 1, usedPoiIds: [], previousPlaces: [], usedNightKinds: [],
    previousDayState: null, warnings: [], finished: false, pendingDaySummary: null,
    dayRetryCount: 0, dayError: null, dayFeedback: null, pendingDay: null, pendingCandidates: null, gapDays: [],
  })
  const secondVersion = await prisma.tripDay.findMany({ where: { tripId: tripG.id }, include: { items: true } })
  check('重排后仍只有 1 天（不累积）', secondVersion.length, 1)
  check('重排后只有 1 条（不追加）', secondVersion[0].items.length, 1)
  check('重排后内容是新的', secondVersion[0].items[0].name, '第二版点')
}

try {
  await main()
} finally {
  // 无论成功、失败还是中途抛错，都必须把自己造的测试数据**删干净**——
  // 这是跑在开发库上的自检脚本，留残留会污染用户的真实行程列表。
  // 显式按 TripItem → TripDay → Trip 的顺序删，不依赖级联，避免留下孤儿行。
  if (createdTripIds.length > 0) {
    await prisma.tripItem
      .deleteMany({ where: { tripDay: { tripId: { in: createdTripIds } } } })
      .catch(() => undefined)
    await prisma.tripDay.deleteMany({ where: { tripId: { in: createdTripIds } } }).catch(() => undefined)
    await prisma.trip.deleteMany({ where: { id: { in: createdTripIds } } }).catch(() => undefined)
  }
  if (tempUserId) {
    await prisma.userSetting.deleteMany({ where: { userId: tempUserId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: tempUserId } }).catch(() => undefined)
  }
  await prisma.$disconnect().catch(() => undefined)
}

console.log(`\n生产图编排自检：${pass}/${pass + fail} 通过`)
if (fail > 0) {
  console.log('\n未通过的用例：')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
