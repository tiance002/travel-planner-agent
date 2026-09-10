// 进程内 TTL（存活时间）缓存。
//
// 为什么需要它：高德开放平台对个人开发者有每日调用配额，
// 而且同一个城市、同一家酒店、同一条路线在短时间内会被反复查询。
// 缓存能显著减少配额消耗，也让页面响应更快。
//
// 使用范围：只缓存「读」接口（POI / 天气 / 路径 / 地理编码），不缓存任何用户数据。
// 局限：缓存放在进程内存里，服务重启即清空；将来多实例部署时应换成 Redis。

interface CacheEntry {
  /** 缓存的值 */
  value: unknown
  /** 过期时间戳（毫秒） */
  expireAt: number
}

const store = new Map<string, CacheEntry>()

/** 正在进行中的加载任务，用于合并同一时刻的重复请求 */
const inflight = new Map<string, Promise<unknown>>()

/** 读取缓存，未命中或已过期返回 undefined */
export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (entry.expireAt <= Date.now()) {
    store.delete(key)
    return undefined
  }
  return entry.value as T
}

/** 写入缓存。ttlMs 为存活毫秒数 */
export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expireAt: Date.now() + ttlMs })
}

/**
 * 带缓存的读取封装。
 *
 * 除了命中缓存，它还做了「并发去重」：如果同一个 key 在极短时间内
 * 被多个请求同时命中，只会真正调用一次 loader，其余请求共享同一个 Promise。
 * 这在页面初次加载时同时拉多个 POI 的场景下能省下不少配额。
 */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key)
  if (hit !== undefined) return hit

  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>

  const task = (async () => {
    try {
      const value = await loader()
      cacheSet(key, value, ttlMs)
      return value
    } finally {
      // 无论成功失败都要清掉，否则失败后会被永久占位
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

/** 清空全部缓存，仅用于测试与手动刷新 */
export function cacheClear(): void {
  store.clear()
  inflight.clear()
}

/** 常用存活时间（毫秒） */
export const TTL = {
  /** 地理编码结果几乎不变，可以存久一些 */
  geocode: 24 * 60 * 60 * 1000,
  /** POI 基础信息变化慢，但评分与营业时间会变，10 分钟较稳妥 */
  poi: 10 * 60 * 1000,
  /** 天气预报会滚动更新，30 分钟 */
  weather: 30 * 60 * 1000,
  /** 路况会导致耗时变化，但同一趟规划内不必重复取，5 分钟 */
  direction: 5 * 60 * 1000,
} as const
