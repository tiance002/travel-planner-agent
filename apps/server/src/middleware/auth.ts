// 鉴权中间件：从请求头里取出登录凭证，校验通过后把用户信息挂到 req 上，
// 后续的路由处理函数就能直接通过 req.user 知道「当前是谁在请求」。

import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type TokenPayload } from '../utils/jwt'

// 扩展 Express 的 Request 类型，让 req.user 有明确的类型提示
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization

  // 约定使用 Bearer 方案：Authorization: Bearer <token>
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录' })
    return
  }

  const payload = verifyToken(header.slice(7))
  if (!payload) {
    res.status(401).json({ error: '登录已过期，请重新登录' })
    return
  }

  req.user = payload
  next()
}
