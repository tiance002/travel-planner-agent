// Prisma 客户端单例。
// 开发模式下 tsx watch 会热重载，如果每次重载都 new 一个客户端，
// 数据库连接数会迅速堆满，因此用 globalThis 缓存一个实例。

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
