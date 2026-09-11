// 行程路由。
//
// 覆盖行程的创建（草稿）、列表、详情、住宿锚点更新与删除。
// 所有查询都必须带 userId 条件，这是多用户系统里最基本也最容易漏的隔离要求。

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { generateTrip } from '../services/agent'
import { findAlternatives } from '../services/agent/alternatives'
import { parseDayTypeBan } from '../services/agent/spot-rules'
import { searchPoiById, type Poi } from '../services/amap'

export const tripsRouter = Router()

// 整个行程模块都要求登录，统一挂上鉴权中间件
tripsRouter.use(requireAuth)

/** 把数据库里的 JSON 字符串字段安全地还原成字符串数组 */
function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** 还原行程条目里的照片列表 */
function parsePhotos(value: string | null): string[] {
  return value ? parseJsonArray(value) : []
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

/** 把数据库里的条目还原成 POI 形状，供距离与路径计算使用 */
function toPoiShape(item: {
  poiId: string | null
  name: string
  lng: number | null
  lat: number | null
  address: string | null
  tel: string | null
  rating: string | null
  cost: string | null
  tag: string | null
  typecode: string | null
  openTimeText: string | null
  photos: string | null
}): Poi | null {
  if (!item.poiId || item.lng === null || item.lat === null) return null
  return {
    poiId: item.poiId,
    name: item.name,
    lng: item.lng,
    lat: item.lat,
    address: item.address ?? '',
    type: '',
    typecode: item.typecode ?? '',
    cityName: '',
    district: '',
    adcode: '',
    rating: item.rating === null ? null : Number(item.rating),
    cost: item.cost === null ? null : Number(item.cost),
    tag: item.tag ?? '',
    keytag: '',
    openTimeToday: item.openTimeText ?? '',
    openTimeWeek: '',
    tel: item.tel ?? '',
    photos: [],
    distance: null,
  }
}

// 查询某个条目的替换候选。返回的是列表而不是单个结果，由用户自己挑
tripsRouter.get('/:tripId/items/:itemId/alternatives', async (req, res, next) => {
  try {
    const item = await loadItemWithDay(req.params.tripId, req.params.itemId, req.user!.userId)
    if (!item) {
      res.status(404).json({ error: '行程条目不存在' })
      return
    }

    const target = toPoiShape(item)
    if (!target) {
      res.status(400).json({ error: '这个条目缺少坐标信息，无法替换' })
      return
    }

    // 前一个点与后一个点。住宿锚点不算「上一个点」——它是起点，不是游玩地点，
    // 但仍参与通勤判断：换完之后从住宿出发不能更绕
    const ordered = item.tripDay.items
    const position = ordered.findIndex((entry) => entry.id === item.id)
    const prevItem = position > 0 ? ordered[position - 1] : null
    const nextItem = position >= 0 && position < ordered.length - 1 ? ordered[position + 1] : null

    // 整趟行程已用过的 poiId。跨天去重：不能把一个已经在别的天出现过的地点换进来
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.tripId, userId: req.user!.userId },
      select: { extraNeeds: true },
    })
    const usedRows = await prisma.tripItem.findMany({
      where: { tripDay: { tripId: req.params.tripId } },
      select: { poiId: true },
    })
    const usedPoiIds = new Set(
      usedRows.map((row) => row.poiId).filter((id): id is string => Boolean(id)),
    )

    const candidates = await findAlternatives({
      target,
      previous: prevItem ? toPoiShape(prevItem) : null,
      next: nextItem ? toPoiShape(nextItem) : null,
      slot: item.slot,
      usedPoiIds,
      ban: parseDayTypeBan(trip?.extraNeeds ? parseJsonArray(trip.extraNeeds) : []),
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
