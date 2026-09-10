// Prisma 客户端单例。
//
// Prisma 7 起不再内置数据库驱动，必须通过 driver adapter 连接。
// SQLite 这里用 libSQL adapter：它靠平台预编译包提供原生能力，
// 不需要 node-gyp 编译，避免了 better-sqlite3 在 Windows 上的构建问题。
//
// 开发模式下 tsx watch 会热重载，如果每次重载都 new 一个客户端，
// 数据库连接会迅速堆满，因此用 globalThis 缓存一个实例。

import 'dotenv/config'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/prisma/client'

// 连接串格式为 file:./prisma/dev.db，相对路径以运行目录 apps/server 为基准。
// 注意：prisma.config.ts 中的同名变量以配置文件所在目录为基准，两者指向同一个文件。
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('缺少环境变量 DATABASE_URL，请检查 apps/server/.env 是否已正确配置')
}

const adapter = new PrismaLibSql({ url: databaseUrl })

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
