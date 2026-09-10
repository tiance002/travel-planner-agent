// 应用入口：装配中间件、挂载路由、兜底错误处理，最后启动监听。

import cors from 'cors'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config'
import { amapRouter } from './routes/amap'
import { authRouter } from './routes/auth'
import { settingsRouter } from './routes/settings'
import { tripsRouter } from './routes/trips'

const app = express()

// 允许跨域。开发期前端跑在 5173、后端跑在 3001，属于不同源。
// 上线后应把 origin 收紧到自己的域名，而不是继续全放开。
app.use(cors())

// 解析 JSON 请求体
app.use(express.json())

// 健康检查，用来确认服务是否活着
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.use('/api/auth', authRouter)
app.use('/api/trips', tripsRouter)
app.use('/api/amap', amapRouter)
app.use('/api/settings', settingsRouter)

// 兜底错误处理。
// 必须放在所有路由之后，且必须是四个参数，Express 才会把它识别为错误处理中间件。
// 这里不把错误堆栈返回给前端，避免泄露内部实现细节。
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server error]', err)
  res.status(500).json({ error: '服务器内部错误' })
})

app.listen(config.port, () => {
  console.log(`后端服务已启动：http://localhost:${config.port}`)
})
