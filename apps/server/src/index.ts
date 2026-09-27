// 应用入口：装配中间件、挂载路由、兜底错误处理，最后启动监听。

import cors from 'cors'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import path from 'node:path'
import { config } from './config'
import { amapRouter } from './routes/amap'
import { authRouter } from './routes/auth'
import { settingsRouter } from './routes/settings'
import { tripsRouter } from './routes/trips'

const app = express()

// 可信反向代理（见审查报告 A04 / 任务3）。
//
// 限流的身份键依赖客户端 IP，而 Express 只在「你知道自己在反代后面」时
// 才应该解析 X-Forwarded-For。默认（不设置 trust proxy）情况下 req.ip
// 取的是 TCP 对端地址——客户端伪造 XFF 完全无效，这是最安全的默认值。
//
// 部署在 nginx/网关后面时，由运维设置 TRUSTED_PROXIES（如 '1' 或具体网段），
// 这时 req.ip 才会按信任链计算。**绝不使用 `trust proxy = true`**：
// 那等于告诉 Express「所有代理都可信」，客户端只要自己加一个 XFF 头，
// 就能伪装成任意 IP 绕过限流。
if (config.trustedProxies) {
  app.set('trust proxy', config.trustedProxies)
}

// 允许跨域。开发期前端跑在 5173、后端跑在 3001，属于不同源。
// 生产环境把 origin 收紧到自己的域名，而不是继续全放开（见审查报告 A04）。
// ALLOWED_ORIGINS 用逗号分隔配置；未配置时回退到开发期的宽松策略。
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(
  cors(
    allowedOrigins.length > 0
      ? { origin: allowedOrigins, credentials: true }
      : { origin: true },
  ),
)

// 解析 JSON 请求体。
//
// 头像上传路由自带更严格的 512KB 上限（见 auth.ts 的 avatarBodyLimit），
// 所以这里跳过该路径——否则全局 1MB 会先把请求读进来，
// 路由级更小的限制就形同虚设（报告 A14）。
const AVATAR_UPLOAD_PATH = '/api/auth/avatar/upload'
app.use((req, res, next) => {
  if (req.path === AVATAR_UPLOAD_PATH) {
    next()
    return
  }
  express.json({ limit: '1mb' })(req, res, next)
})

// 头像等用户上传文件的静态服务。URL 以 /uploads 开头，直接映射到磁盘目录
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')))

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

  // 保留错误对象上显式声明的状态码（见审查报告 A15）。
  // body-parser 的 413（请求体过大）、413/400 等都会带 status/statusCode，
  // 一律压成 500 会让前端把这些可解释的错误误报成「服务器内部错误」，
  // 也会让「图片太大」这类提示无从展示。只对被显式声明的码放行。
  const status = resolveErrorStatus(err)
  const message =
    status !== 500 && err instanceof Error && err.message ? err.message : '服务器内部错误'
  res.status(status).json({ error: message })
})

/** 从错误对象上取显式声明的 HTTP 状态码；没有或非法时回退 500 */
function resolveErrorStatus(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 500
  const candidate =
    (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode
  const status = typeof candidate === 'number' ? candidate : Number(candidate)
  // 只接受 4xx/5xx 的合法 HTTP 状态码
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  return 500
}

app.listen(config.port, () => {
  console.log(`后端服务已启动：http://localhost:${config.port}`)
})
