// 行程路由。
//
// 覆盖行程的创建（草稿）、列表、详情、住宿锚点更新与删除。
// 所有查询都必须带 userId 条件，这是多用户系统里最基本也最容易漏的隔离要求。

import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { poiFromStay, poiFromTripItem } from '../domain/poi-mapper'
import { generateTripWithGraph, prepareTripReview, resumeTripReview } from '../services/agent/graph-run'
import { acquireRun, releaseRun, cancelSuspendedRun } from '../services/agent/run-lock'
import { findAlternatives } from '../services/agent/alternatives'
import { nightKindOfText, parseDayTypeBan, type NightKind } from '../services/agent/spot-rules'
import { searchPoiById } from '../services/amap'
import { parseJsonArray, parseJsonObject } from '../utils/json'

export function createTripsRouter(runtime = { generateTripWithGraph, prepareTripReview, resumeTripReview }) {
const tripsRouter = Router()

// 整个行程模块都要求登录，统一挂上鉴权中间件
tripsRouter.use(requireAuth)

/** 还原行程条目里的照片列表 */
function parsePhotos(value: string | null): string[] {
  return parseJsonArray(value)
}

/** 还原某一天的天气数据。脏数据（不是对象）按「未知」处理，而不是抛错整页 500 */
function parseWeather(value: string | null): unknown {
  return parseJsonObject(value)
}

// ---------------------------------------------------------------------------
// 创建行程草稿
// ---------------------------------------------------------------------------

const createTripSchema = z.object({
  // 标题可以不填，后端用「城市 + 出发日期」自动生成
  title: z.string().trim().max(60).optional(),
  cityName: z.string().trim().min(1, '请填写目的地城市'),
  cityAdcode: z.string().regex(/^\d{6}$/, '城市编码格式不正确'),
  // 接受 ISO 日期字符串，交给 Date 解析
  startDate: z.string().min(1, '请选择出发日期'),
  days: z.number().int().min(1, '行程至少 1 天').max(15, '第一版最多支持 15 天'),
  travelers: z.number().int().min(1, '团队人数至少 1 人').max(50, '团队人数过多'),
  preferences: z.array(z.string()).max(20).default([]),
  extraNeeds: z.array(z.string()).max(20).default([]),
  budgetAmount: z.number().nonnegative().nullable().optional(),
  budgetScope: z.enum(['per_person', 'total']).default('per_person'),
})

tripsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = createTripSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const data = parsed.data
    const startDate = new Date(data.startDate)
    if (Number.isNaN(startDate.getTime())) {
      res.status(400).json({ error: '出发日期格式不正确' })
      return
    }

    const trip = await prisma.trip.create({
      data: {
        userId: req.user!.userId,
        title: data.title?.trim() || `${data.cityName} ${data.days} 日行程`,
        cityName: data.cityName,
        cityAdcode: data.cityAdcode,
        startDate,
        days: data.days,
        travelers: data.travelers,
        preferences: JSON.stringify(data.preferences),
        extraNeeds: JSON.stringify(data.extraNeeds),
        budgetAmount: data.budgetAmount ?? null,
        budgetScope: data.budgetScope,
        status: 'draft',
      },
    })

    res.status(201).json({ trip })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 列表与详情
// ---------------------------------------------------------------------------

// 获取当前用户的行程列表。
// 注意 where 条件必须带上 userId，否则会把别人的行程也查出来。
tripsRouter.get('/', async (req, res, next) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        cityName: true,
        startDate: true,
        days: true,
        travelers: true,
        status: true,
        stayResolved: true,
        stayName: true,
        createdAt: true,
      },
    })

    res.json({ trips })
  } catch (err) {
    next(err)
  }
})

// 获取单个行程的完整内容，包含每日安排与条目
tripsRouter.get('/:id', async (req, res, next) => {
  try {
    // 用 findFirst 而不是 findUnique：把归属判断直接写进查询条件，
    // 别人的行程 id 即使被猜到，也查不出任何东西
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        tripDays: {
          orderBy: { dayIndex: 'asc' },
          include: { items: { orderBy: { orderIndex: 'asc' } } },
        },
      },
    })

    if (!trip) {
      res.status(404).json({ error: '行程不存在' })
      return
    }

    res.json({
      trip: {
        ...trip,
        completedDayCount: trip.tripDays.filter(d => d.dayIndex >= 1 && d.dayIndex <= trip.days).length,
        missingDayIndexes: Array.from({ length: trip.days }, (_, i) => i + 1).filter(i => !trip.tripDays.some(d => d.dayIndex === i)),
        preferences: parseJsonArray(trip.preferences),
        extraNeeds: parseJsonArray(trip.extraNeeds),
        // 生成过程中的规则修正提示（报告 A09）。非生成的 trip 该字段为 null，前端按空处理
        genWarnings: trip.genWarnings ? parseJsonArray(trip.genWarnings) : [],
        tripDays: trip.tripDays.map((day) => ({
          ...day,
          weather: parseWeather(day.weather),
          items: day.items.map((item) => ({
            ...item,
            photos: parsePhotos(item.photos),
          })),
        })),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 住宿锚点
// ---------------------------------------------------------------------------

const staySchema = z.object({
  // 是否已确定住宿。为 false 时表示用户「还没定」，坐标可留空
  stayResolved: z.boolean(),
  stayPoiId: z.string().nullable().optional(),
  stayName: z.string().max(80).nullable().optional(),
  stayLng: z.number().nullable().optional(),
  stayLat: z.number().nullable().optional(),
})

// 更新住宿锚点。新建行程的第二步完成后调用它写入结果
tripsRouter.patch('/:id/stay', async (req, res, next) => {
  try {
    const parsed = staySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const existing = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true },
    })
    if (!existing) {
      res.status(404).json({ error: '行程不存在' })
      return
    }

    const data = parsed.data
    const trip = await prisma.trip.update({
      where: { id: existing.id },
      data: {
        stayResolved: data.stayResolved,
        stayPoiId: data.stayPoiId ?? null,
        stayName: data.stayName ?? null,
        stayLng: data.stayLng ?? null,
        stayLat: data.stayLat ?? null,
      },
    })

    res.json({ trip })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// AI 生成行程
// ---------------------------------------------------------------------------

// 生成任务是否失去活性由 run-lock.ts 的心跳和运行阶段共同判定。
// waiting/recovery 保留人工裁决或恢复载荷；running 的过期心跳才允许安全接管。

// 触发生成时可选的语义：
//   continue —— 保留已经排好的天，从第一个空缺的天接着排（默认，失败后重试也走这条）
//   restart  —— 只允许空草稿从第 1 天开始；已有日期时返回 409，需先复制为新草稿
const generateSchema = z.object({
  mode: z.enum(['continue', 'restart', 'review']).default('continue'),
  /**
   * 并行择优开关（V4，图版专属）。勾上时每天并行生成 2 套方案再择优，
   * 模型消耗与耗时约翻倍——这个提醒由前端展示，后端只负责照做。
   */
  parallel: z.boolean().default(false),
})

/**
 * 原子抢锁：把 Trip 从「空闲」推进到「generating」。
 *
 * 见审查报告 A02 与任务2。原来的写法是「先 findFirst 读状态 → 判断 → 再 update」，
 * 两个并发请求会在第一次读时都看到可生成状态，于是都往下走、
 * 各自启动一轮生成——同一个 Trip 跑两张图，落库互相覆盖、模型额度双倍消耗。
 *
 * 这里改用**带条件的单条 updateMany**：把状态判断直接写进 WHERE，
 * 由数据库保证「读」与「写」是同一个原子动作。返回是否抢到。
 *
 * 与 run-lock.ts 的关系（任务2/任务7 的重要修正）：
 *   本函数只负责「状态机」这一层（draft/failed/ready/partial → generating）。
 *   真正防止「同一个任务跑两遍」的**运行锁**是 run-lock.ts 的 acquireRun——
 *   它管的是「后台任务是否还在跑」，生命周期覆盖整个生成而不是一个 HTTP 请求。
 *   两者配合：先抢运行锁（防重复任务），再推进状态机（防前端显示错乱）。
 *
 * 注意：STALE_GENERATING_MS 已经**不再用于夺取任务所有权**（任务7 明确禁止
 * 「依靠固定超时直接夺取任务所有权」）。僵尸判定改由心跳完成，见 run-lock.ts。
 */
async function markGenerating(
  tripId: string,
  runId: string,
  data: { genProgress: string; genError: null },
): Promise<boolean> {
  const result = await prisma.trip.updateMany({
    where: {
      id: tripId,
      // 不是 generating 的状态都可以推进（draft/failed/ready/partial）
      genRunId: runId,
      genRunPhase: 'running',
    },
    // 新一轮生成清空上一轮失败原因；警告由真实图状态和事务提交重新派生。
    data: { status: 'generating', ...data },
  })
  return result.count > 0
}

// Create a clean draft for a new plan while keeping the original Trip,
// TripDay, and check-in rows untouched.  This is the safe replacement for a
// destructive restart once an existing itinerary has been saved.
tripsRouter.post('/:id/replan-copy', async (req: Request<{ id: string }>, res, next) => {
  try {
    const source = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: {
        userId: true,
        title: true,
        cityName: true,
        cityAdcode: true,
        startDate: true,
        days: true,
        travelers: true,
        preferences: true,
        extraNeeds: true,
        budgetAmount: true,
        budgetScope: true,
        stayResolved: true,
        stayPoiId: true,
        stayName: true,
        stayLng: true,
        stayLat: true,
      },
    })
    if (!source) {
      res.status(404).json({ error: '行程不存在' })
      return
    }
    const title = `${source.title}（重新规划）`.slice(0, 60)
    const trip = await prisma.trip.create({ data: { ...source, title, status: 'draft' } })
    res.status(201).json({ trip })
  } catch (error) {
    next(error)
  }
})

// 触发生成。立刻返回 202，真正的生成在后台跑，前端轮询 GET /:id 看进度
tripsRouter.post(
  '/:id/generate',
  // 显式标注 req 的 params 类型：Express 5 在多 handler 情况下无法从路径字符串
  // 推断出 `:id`，会让 req.params.id 退化成 `string | string[]`。这里手动收窄。
  async (req: Request<{ id: string }>, res, next) => {
    try {
      const parsed = generateSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: '参数不合法' })
        return
      }
      const mode = parsed.data.mode

      const trip = await prisma.trip.findFirst({
        where: { id: req.params.id, userId: req.user!.userId },
        select: { id: true, status: true, userId: true, genReview: true },
      })
      if (!trip) {
        res.status(404).json({ error: '行程不存在' })
        return
      }

      // Restart is intentionally limited to an empty draft.  A saved day is
      // user data even when it has no check-in yet; refusing here prevents an
      // accidental delete and tells the caller how to preserve it.  The graph
      // repeats this check inside its write transaction for the race where a
      // day is saved after this preflight.
      if (mode === 'restart' && (trip.genReview !== null || await prisma.tripDay.count({ where: { tripId: trip.id } }) > 0)) {
        res.status(409).json({ error: '已有保存的行程日期，请使用继续补缺或新建行程后重新规划；原行程未修改' })
        return
      }

      // 第一步：抢运行锁（任务2）。
      // 这是真正的并发控制——它看的是「后台还有没有任务在跑」，而不是
      // 「此刻有没有 HTTP 请求进来」。响应早就返回了，但锁要等任务结束才放。
      let acquiredRunId: string | null = null
      const releaseAcquired = async () => {
        const runId = acquiredRunId
        acquiredRunId = null
        if (runId) await releaseRun(trip.id, runId)
      }
      try {
        const acquired = await acquireRun(trip.id, trip.userId)
        if (!acquired.ok) {
          res.status(409).json({
            error:
              acquired.reason === 'user_busy'
                ? '你还有一个行程正在生成中，请等它完成后再试'
                : '这个行程正在生成中，请稍候',
          })
          return
        }
        acquiredRunId = acquired.runId

        // 第二步：推进状态机。若状态机因竞态没推进成功（例如刚刚被别的路径改过），
        // 要把刚抢到的锁放掉，避免留下没人用却占着的锁。
        const marked = await markGenerating(trip.id, acquired.runId, {
          genProgress: mode === 'restart' ? '正在准备（重新生成）' : '正在准备',
          genError: null,
        })
        if (!marked) {
          await releaseAcquired()
          res.status(409).json({ error: '这个行程正在生成中，请稍候' })
          return
        }

        // 刻意不 await：生成要跑几十秒到几分钟，让接口先返回。
        // 生成函数完成调用交接后，生命周期由 graph-run 自己收尾。
        const parallelCandidates = parsed.data.parallel ? 2 : 1
        const task = runtime.generateTripWithGraph(trip.id, {
          mode,
          parallelCandidates,
          runId: acquired.runId,
        })
        acquiredRunId = null
        void task.catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : '生成失败'
          console.error(`[生成 ${trip.id}] 失败：${message}`)
          // 生命周期只由持锁的 graph-run 负责；这里仅记录，避免迟到回调
          // 覆盖后续任务的状态。
        })

        res.status(202).json({ ok: true, status: 'generating', mode })
      } catch (error) {
        // acquire succeeded but mark/dispatch failed before ownership was handed
        // to graph-run: release the exact token.  A failed release is surfaced
        // to the normal error handler so a database outage is observable; the
        // conditional release itself remains safe for a later TTL takeover.
        await releaseAcquired().catch(releaseError => {
          console.error(`[生成 ${trip.id}] 领取后收尾失败`, releaseError)
          throw releaseError
        })
        throw error
      }
    } catch (err) {
      next(err)
    }
  },
)

/**
 * 逐天裁决请求体（见审查报告 A03 / 3.1）。
 *
 * 用 discriminatedUnion 而不是「一个对象 + 可选字段」，理由有两个：
 *   1. 语义上这是三种互斥的裁决，用联合类型让「choose 必须带 choice」
 *      成为类型层面的事实，而不是运行时要记得检查的约定；
 *   2. 原来的实现把 safeParse 失败**静默降级成 approve**——参数写错
 *      （比如 choice 传了 'C'、decision 拼错）反而会直接批准方案，
 *      这是最危险的一种「报错方式」：用户以为在驳回，系统却替他确认了。
 *      现在校验失败一律 400，绝不替用户做决定。
 */
const reviewConfirmSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    // Each card is single-use.  The client must echo its id so a delayed
    // click cannot be applied to a newer review on the same run.
    reviewId: z.string().uuid(),
    parallel: z.boolean().default(false),
  }),
  z.object({
    decision: z.literal('choose'),
    reviewId: z.string().uuid(),
    // choose 必须明确指定采用哪个方案，缺了就不是一个合法的裁决
    choice: z.enum(['A', 'B']),
    parallel: z.boolean().default(false),
  }),
  z.object({
    decision: z.literal('reject'),
    reviewId: z.string().uuid(),
    // 驳回可以不带意见（用默认文案让模型换一批地点），但带了必须长度合规
    feedback: z.string().trim().max(500).optional(),
    parallel: z.boolean().default(false),
  }),
])

// 逐天人工确认（V3，仅图版 review 模式）：用户在「待确认」后点了「确认采用」，
// 用 Command(resume) 让图从 interrupt 处继续排下一天。
tripsRouter.post('/:id/review-confirm', async (req, res, next) => {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true, status: true, genRunId: true, genReview: true, genReviewId: true },
    })
    if (!trip) {
      res.status(404).json({ error: '行程不存在' })
      return
    }

    // 参数校验必须在状态校验之前：这是「非法请求不得推进业务流程」的第一道门
    const parsedConfirm = reviewConfirmSchema.safeParse(req.body ?? {})
    if (!parsedConfirm.success) {
      res.status(400).json({
        error: parsedConfirm.error.issues[0]?.message ?? '裁决参数不合法，请重新选择',
      })
      return
    }
    const confirmBody = parsedConfirm.data

    if (trip.status !== 'generating') {
      res.status(409).json({ error: '行程当前不在生成中，无需确认' })
      return
    }

    // 必须**确实有**待确认内容才允许裁决（任务6）。
    // 否则重复点击会一路走到 resume：虽然 resumeTripReview 内部还有原子领取，
    // 但在路由层就挡掉能给出更明确的语义——「没有待确认内容」与「裁决成功」是两回事。
    if (!trip.genReview) {
      res.status(409).json({ error: '当前没有待确认的内容，可能已被处理' })
      return
    }

    // 与 generate 一样，后台恢复，接口立刻返回。
    // answer 携带用户的裁决：approve（确认采用）/ choose（选 A/B）/ reject（驳回，可附意见）。
    // parallel 由前端一并传回：确认后继续排的后续天，保持同样的并行设置。
    // runId 沿用挂起任务的运行锁：等待期间锁没释放，恢复的正是同一个任务。
    const claim = await runtime.prepareTripReview(trip.id, {
      answer: {
        decision: confirmBody.decision,
        choice: confirmBody.decision === 'choose' ? confirmBody.choice : undefined,
        feedback: confirmBody.decision === 'reject' ? confirmBody.feedback : undefined,
      },
      runId: trip.genRunId,
      reviewId: confirmBody.reviewId,
    })
    void runtime.resumeTripReview(trip.id, {
      claim,
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : '确认失败'
      console.error(`[生成 ${trip.id}] 确认失败：${message}`)
      // 不在HTTP回调释放任务锁；恢复错误保留checkpoint并标记人工恢复。
    })

    res.status(202).json({ ok: true, status: 'reviewing', decision: confirmBody.decision })
  } catch (err) {
    if (err instanceof Error && 'status' in err) res.status(Number(err.status)).json({ error: err.message })
    else next(err)
  }
})

tripsRouter.post('/:id/cancel-generation', async (req, res, next) => {
  try {
    if (!await cancelSuspendedRun(req.params.id, req.user!.userId)) {
      res.status(409).json({ error: '仅可取消等待确认或需人工恢复的任务；执行中的任务请稍候' })
      return
    }
    res.json({ ok: true })
  } catch (error) { next(error) }
})

// ---------------------------------------------------------------------------
// 打卡
// ---------------------------------------------------------------------------

/**
 * 打卡与取消打卡共用的一段前置校验：
 * 按 TripItem → TripDay → Trip 的链路查条目，并把 userId 写进查询条件，
 * 确保用户只能操作自己的行程条目。返回行程 id 与条目本身。
 */
async function loadOwnedItem(tripId: string, itemId: string, userId: string) {
  return prisma.tripItem.findFirst({
    where: {
      id: itemId,
      // Prisma 的关系过滤不能直接写 tripDay.userId，要穿过 TripDay 关联到 Trip 上判断归属
      tripDay: { tripId, trip: { userId } },
    },
    select: { id: true, checkedAt: true },
  })
}

// 到点打卡。重复打卡无害：第二次会覆盖时间，但正常入口不会触发（按钮已变为「取消打卡」）
tripsRouter.post('/:tripId/items/:itemId/checkin', async (req, res, next) => {
  try {
    const item = await loadOwnedItem(req.params.tripId, req.params.itemId, req.user!.userId)
    if (!item) {
      res.status(404).json({ error: '行程条目不存在' })
      return
    }

    await prisma.tripItem.update({
      where: { id: item.id },
      data: { checkedAt: new Date() },
    })
    res.json({ ok: true, checkedAt: new Date().toISOString() })
  } catch (err) {
    next(err)
  }
})

// 取消打卡。把 checkedAt 置回 null 即可，不删除条目
tripsRouter.delete('/:tripId/items/:itemId/checkin', async (req, res, next) => {
  try {
    const item = await loadOwnedItem(req.params.tripId, req.params.itemId, req.user!.userId)
    if (!item) {
      res.status(404).json({ error: '行程条目不存在' })
      return
    }

    await prisma.tripItem.update({
      where: { id: item.id },
      data: { checkedAt: null },
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 换一个：查看替换候选、执行替换
// ---------------------------------------------------------------------------

/**
 * 把某个 TripItem 连同它所在的一整天一起读出来，用于替换。
 *
 * 需要整天数据的原因：判断候选是否合适，必须知道目标点的前一个点和后一个点
 * （换完之后不能把通勤搞超时），而这两个点只有拿到整天的序列才知道。
 */
async function loadItemWithDay(tripId: string, itemId: string, userId: string) {
  const item = await prisma.tripItem.findFirst({
    where: { id: itemId, tripDay: { tripId, trip: { userId } } },
    include: {
      tripDay: {
        include: { items: { orderBy: { orderIndex: 'asc' } } },
      },
    },
  })
  return item
}

// 查询某个条目的替换候选。返回的是列表而不是单个结果，由用户自己挑
tripsRouter.get('/:tripId/items/:itemId/alternatives', async (req, res, next) => {
  try {
    const item = await loadItemWithDay(req.params.tripId, req.params.itemId, req.user!.userId)
    if (!item) {
      res.status(404).json({ error: '行程条目不存在' })
      return
    }

    // POI 还原统一走 domain/poi-mapper（报告 5.3），不再在路由里手写一份
    const target = poiFromTripItem(item)
    if (!target) {
      res.status(400).json({ error: '这个条目缺少坐标信息，无法替换' })
      return
    }

    // 前一个点与后一个点。
    //
    // 首尾两站要用住宿锚点补位，这是必须的：
    //   - 第一站的「上一站」就是住处（用户从酒店出门），传 null 等于告诉
    //     候选筛选「这站没有前置约束」，于是会推荐出离家很远的地方；
    //   - 最后一站的「下一站」也是住处（要回酒店），漏掉就只优化了去程、
    //     没管返程。
    // 顺序上用的是当天条目的序号，住宿不占序号——它只是端点，不是游玩点。
    const ordered = item.tripDay.items
    const position = ordered.findIndex((entry) => entry.id === item.id)
    const prevItem = position > 0 ? ordered[position - 1] : null
    const nextItem = position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : null

    // 整趟行程已用过的 poiId。跨天去重：不能把一个已经在别的天出现过的地点换进来
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.tripId, userId: req.user!.userId },
      select: {
        extraNeeds: true,
        stayResolved: true,
        stayPoiId: true,
        stayName: true,
        stayLng: true,
        stayLat: true,
      },
    })

    // 住宿锚点还原成 POI 形状，只为了喂给通勤计算，所以除坐标外的字段可以留空
    const stayPoi = trip ? poiFromStay(trip) : null

    const usedRows = await prisma.tripItem.findMany({
      where: { tripDay: { tripId: req.params.tripId } },
      select: { poiId: true, name: true, tag: true },
    })
    const usedPoiIds = new Set(
      usedRows.map((row) => row.poiId).filter((id): id is string => Boolean(id)),
    )

    // 夜生活去重：整趟只安排一次酒吧、一次小吃街。
    // **要排除目标自己**——用户想「把这家酒吧换一家酒吧」是合理诉求，
    // 若把目标自己算进去，bar 就被自己封掉了，一个酒吧候选都搜不出来。
    const forbiddenNightKinds = new Set<NightKind>()
    for (const row of usedRows) {
      if (row.poiId && row.poiId === item.poiId) continue
      const kind = nightKindOfText(row.name, row.tag)
      if (kind) forbiddenNightKinds.add(kind)
    }

    const candidates = await findAlternatives({
      target,
      previous: prevItem ? poiFromTripItem(prevItem) : stayPoi,
      next: nextItem ? poiFromTripItem(nextItem) : stayPoi,
      slot: item.slot,
      usedPoiIds,
      ban: parseDayTypeBan(trip?.extraNeeds ? parseJsonArray(trip.extraNeeds) : []),
      forbiddenNightKinds,
    })

    res.json({ candidates, currentPoiId: item.poiId })
  } catch (err) {
    next(err)
  }
})

const replaceSchema = z.object({ poiId: z.string().min(1) })

// 执行替换。只换这一个条目，不重排整天的顺序——
// 用户的心智是「我只想换掉 A」，把 B 和 C 的顺序也一起改了会让人困惑
tripsRouter.patch('/:tripId/items/:itemId/replace', async (req, res, next) => {
  try {
    const parsed = replaceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: '参数不合法' })
      return
    }

    const item = await loadItemWithDay(req.params.tripId, req.params.itemId, req.user!.userId)
    if (!item) {
      res.status(404).json({ error: '行程条目不存在' })
      return
    }

    // 从高德重新取一次这个 POI。刻意不信任前端传来的名称与坐标——
    // 坐标只能来自高德，这是整个项目的硬约定
    const fresh = await searchPoiById(parsed.data.poiId)
    if (!fresh) {
      res.status(404).json({ error: '找不到这个地点，请重新查询候选' })
      return
    }

    const updated = await prisma.tripItem.update({
      where: { id: item.id },
      data: {
        poiId: fresh.poiId,
        name: fresh.name,
        lng: fresh.lng,
        lat: fresh.lat,
        address: fresh.address || null,
        tel: fresh.tel || null,
        rating: fresh.rating === null ? null : String(fresh.rating),
        cost: fresh.cost === null ? null : String(fresh.cost),
        tag: fresh.tag || fresh.keytag || null,
        typecode: fresh.typecode || null,
        openTimeText: fresh.openTimeToday || null,
        // 照片一并换掉，否则会残留上一个地点的图
        photos: fresh.photos.length > 0 ? JSON.stringify(fresh.photos.slice(0, 3)) : null,
        // 打卡状态清零：换成了新地方，之前的打卡记录就不再有效
        checkedAt: null,
      },
    })

    res.json({
      item: {
        ...updated,
        photos: parsePhotos(updated.photos),
        checkedAt: updated.checkedAt ? updated.checkedAt.toISOString() : null,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

// 删除行程。关联的每日安排与条目由数据库级联删除
tripsRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true },
    })
    if (!existing) {
      res.status(404).json({ error: '行程不存在' })
      return
    }

    await prisma.trip.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
return tripsRouter
}
export const tripsRouter = createTripsRouter()
