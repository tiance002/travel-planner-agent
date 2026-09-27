// 轻量内存限流与并发背压中间件。
//
// 背景（见审查报告 A04 / 9.3）：
//   公开注册后，登录/注册、高德代理、模型测试、生成接口都会成为滥用入口：
//     - 登录/注册：可以被拿来撞库、批量注册；
//     - 高德代理：会被当成免费的公共代理刷掉我们自己的配额；
//     - 模型测试：可以被当作通用网络代理或成本攻击入口；
//     - 生成接口：单用户并发刷新会同时跑多张图，打爆模型与高德。
//
// 实现取向：
//   这是一个**单进程内存**实现，够开发期与单实例部署用，语义清晰、无外部依赖。
//   多实例部署时应换成 Redis（报告 9.1 已给出方向），届时只需替换 countStore 与
//   并发计数的存储实现，中间件签名保持不变。
//
// 两点工程细节：
//   1. 用固定窗口计数（fixed window）+ 定期清扫，避免 Map 无限增长；
//   2. 成功/失败都计数（不做「只计失败」），因为攻击流量通常全是失败请求。

import type { Request, RequestHandler } from 'express'

/** 一个限流桶：窗口起点 + 窗口内计数 */
interface Bucket {
  resetAt: number
  count: number
}

const buckets = new Map<string, Bucket>()

/** 清扫间隔与最长窗口：过期桶不会长期滞留 */
let lastSweep = 0
const SWEEP_INTERVAL_MS = 60 * 1000

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/**
 * 取客户端标识（见审查报告 A04 / 任务3）。
 *
 * 关键安全修正：**不再直接读 X-Forwarded-For**。
 *
 * 原实现是「优先取 XFF 的第一段，取不到才用 req.ip」，这等于把限流身份键
 * 交给客户端自己决定——攻击者只要每次请求换一个 XFF 值，就永远落在不同的
 * 限流桶里，限流形同虚设。
 *
 * 正确做法：只信 `req.ip`。它的可信度由 app.set('trust proxy', ...) 决定：
 *   - 未配置 trust proxy（默认）：req.ip 是 TCP 对端地址，客户端伪造头部无效；
 *   - 配置了可信代理：Express 会按信任链从右往左解析 XFF，只采信可信代理
 *     追加的那一段，客户端自己塞进去的前缀会被正确忽略。
 *
 * 也就是说「支不支持反代」这件事收敛到了 index.ts 的一行配置里，
 * 这里只消费已经可信的结论，不再自己做头解析。
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/** 限流的身份键：登录用户按 userId，未登录按 IP */
export function rateKey(req: Request, prefix: string): string {
  const userId = req.user?.userId
  return userId ? `${prefix}:u:${userId}` : `${prefix}:ip:${clientIp(req)}`
}

export interface RateLimitOptions {
  /** 窗口内允许的最大请求数 */
  limit: number
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 桶名前缀，用于隔离不同路由的计数 */
  prefix: string
  /** 超出限制时的提示文案 */
  message?: string
}

/**
 * 固定窗口限流中间件。
 *
 * 用法：`router.post('/login', rateLimit({ prefix:'auth', limit:20, windowMs:60_000 }), handler)`
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { limit, windowMs, prefix } = options
  const message = options.message ?? '操作过于频繁，请稍后再试'

  return (req, res, next) => {
    const now = Date.now()
    sweep(now)

    const key = rateKey(req, prefix)
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 })
      next()
      return
    }

    bucket.count += 1
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: `${message}（约 ${retryAfter} 秒后可重试）` })
      return
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// 并发背压：限制同一用户同时进行的「重任务」数量
// ---------------------------------------------------------------------------

const inflightByKey = new Map<string, number>()

export interface ConcurrencyOptions {
  /** 同一用户最多同时进行几个 */
  max: number
  /** 键名前缀 */
  prefix: string
  message?: string
}

/**
 * 并发背压中间件。
 *
 * 与限流不同，它关心的是「同时有多少个任务在跑」。用于生成接口这类
 * 一次要跑几十秒、且用户可能连点刷新触发的场景：用户级并发 1 是报告建议的默认值。
 *
 * 中间件在响应结束时（finish/close）释放名额，异常路径也不会泄漏。
 */
export function concurrencyGuard(options: ConcurrencyOptions): RequestHandler {
  const { max, prefix } = options
  const message = options.message ?? '你还有任务正在进行中，请等它完成后再试'

  return (req, res, next) => {
    const key = rateKey(req, prefix)
    const current = inflightByKey.get(key) ?? 0

    if (current >= max) {
      res.status(429).json({ error: message })
      return
    }

    inflightByKey.set(key, current + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      const left = (inflightByKey.get(key) ?? 1) - 1
      if (left <= 0) inflightByKey.delete(key)
      else inflightByKey.set(key, left)
    }

    res.on('finish', release)
    res.on('close', release)
    next()
  }
}

/** 清空全部限流与并发状态，仅用于测试 */
export function resetRateLimits(): void {
  buckets.clear()
  inflightByKey.clear()
  lastSweep = 0
}
