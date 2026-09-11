// 行程路由。
//
// 覆盖行程的创建（草稿）、列表、详情、住宿锚点更新与删除。
// 所有查询都必须带 userId 条件，这是多用户系统里最基本也最容易漏的隔离要求。

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { generateTrip } from '../services/agent'

export const tripsRouter = Router()

// 整个行程模块都要求登录，统一挂上鉴权中间件
tripsRouter.use(requireAuth)

/** 把数据库里的 JSON 字符串字段安全地还原成数组 */
function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
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
        preferences: parseJsonArray(trip.preferences),
        extraNeeds: parseJsonArray(trip.extraNeeds),
        tripDays: trip.tripDays.map((day) => ({
          ...day,
          weather: day.weather ? JSON.parse(day.weather) : null,
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

// 判定「卡住的生成任务」的时间。超过这个时长的 generating 记录视为上次进程重启遗留，
// 允许重新触发，避免用户永远等一个不会完成的进度。
const STALE_GENERATING_MS = 10 * 60 * 1000

// 触发生成时可选的两档语义：
//   continue —— 保留已经排好的天，从第一个空缺的天接着排（默认，失败后重试也走这条）
//   restart  —— 清空已有安排，从第 1 天重新排（用户点「重新生成」时用）
const generateSchema = z.object({
  mode: z.enum(['continue', 'restart']).default('continue'),
})

// 触发生成。立刻返回 202，真正的生成在后台跑，前端轮询 GET /:id 看进度
tripsRouter.post('/:id/generate', async (req, res, next) => {
  try {
    const parsed = generateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: '参数不合法' })
      return
    }
    const mode = parsed.data.mode

    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true, status: true, updatedAt: true },
    })
    if (!trip) {
      res.status(404).json({ error: '行程不存在' })
      return
    }

    if (
      trip.status === 'generating' &&
      Date.now() - trip.updatedAt.getTime() < STALE_GENERATING_MS
    ) {
      res.status(409).json({ error: '这个行程正在生成中，请稍候' })
      return
    }

    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        status: 'generating',
        genProgress: mode === 'restart' ? '正在准备（重新生成）' : '正在准备',
        genError: null,
      },
    })

    // 刻意不 await：生成要跑几十秒到几分钟，让接口先返回。
    // 失败时把原因写进 genError，前端就能直接展示给用户看。
    void generateTrip(trip.id, { mode }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : '生成失败'
      console.error(`[生成 ${trip.id}] 失败：${message}`)
      await prisma.trip
        .update({
          where: { id: trip.id },
          data: { status: 'failed', genProgress: null, genError: message },
        })
        .catch(() => undefined)
    })

    res.status(202).json({ ok: true, status: 'generating', mode })
  } catch (err) {
    next(err)
  }
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
