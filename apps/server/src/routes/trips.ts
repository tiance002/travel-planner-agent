// 行程路由。
//
// 覆盖行程的创建（草稿）、列表、详情、住宿锚点更新与删除。
// 所有查询都必须带 userId 条件，这是多用户系统里最基本也最容易漏的隔离要求。

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'

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
