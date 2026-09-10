// Prisma CLI 配置（Prisma 7 起新增）。
//
// Prisma 7 把数据库连接串从 schema.prisma 移到了这里：schema 只描述数据模型，
// 连接信息由本文件提供。运行时则改用 driver adapter（见 src/db.ts）。
//
// 本文件由 prisma 命令自动加载，运行目录需为 apps/server。

import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  // 数据模型文件位置（相对于本文件所在目录）
  schema: 'prisma/schema.prisma',

  // 迁移文件存放目录
  migrations: {
    path: 'prisma/migrations',
  },

  // 数据库连接串，从 .env 的 DATABASE_URL 读取
  datasource: {
    url: env('DATABASE_URL'),
  },
})
