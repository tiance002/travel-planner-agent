// 行程路由。
// P1 阶段只提供列表查询，目的是验证「登录 → 带凭证 → 拿到私有数据」这条链路是否打通。
// 新建行程、生成行程等能力在后续阶段补齐。

import { Router } from 'express'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'

export const tripsRouter = Router()

// 整个行程模块都要求登录，统一挂上鉴权中间件
tripsRouter.use(requireAuth)

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
