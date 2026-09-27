// 生成进度的轮询 hook。
//
// 背景（见审查报告 A13 / 3.2 与任务4）：
//
//   TripDetail 原来的写法是「effect 里 setTimeout(loadTrip)，effect 依赖
//   [trip.status, trip.genDayIndex]」。问题在于：定时器只会在依赖变化时重新设置，
//   而一次 loadTrip 如果拿回来的还是 generating、genDayIndex 也没变，
//   依赖数组就没变、effect 不重跑、定时器不会再设一个——
//   轮询就此停摆，用户看着进度条一动不动，直到手动刷新页面。
//
//   改用「自循环 setTimeout」之后，还有第二个更隐蔽的坑（任务4 第1~2点）：
//   如果「要不要开始轮询」这个判断是在 effect 启动的那一刻用**组件里的状态**做的，
//   那么「首次打开一个正在生成的行程」时，数据还没加载回来（trip 为 null），
//   判断为 false，循环根本不会启动——而 effect 的依赖只有 tripId、不会再触发，
//   于是首屏就是死的。
//
// 本实现的两条关键设计：
//   1. **不预判，先拉一次**：进入 effect 后总是先拉一次最新数据，
//      用**拉回来的结果**决定要不要继续。这样「初始状态为 null、随后异步拿到
//      generating」这个场景天然被覆盖——第一次拉取就会看到 generating 并启动循环。
//   2. **续不续由服务端状态说话**：只要 `getStatus(data)` 属于「进行中」就继续排下一次，
//      与组件里的任何本地状态无关。这不依赖 tripRef 的时序，也不怕 React 的批处理。
//
// 为什么用自循环 setTimeout 而不是 setInterval：
//   setInterval 会按固定频率发请求，但前一个请求还在飞的时候下一个又发了，
//   慢网络下会堆积请求、乱序更新；自循环是「上一次结束后再等 N 毫秒」，
//   天然不会并发，也不会因为请求慢而雪崩。

import { useEffect, useRef } from 'react'

export interface GenerationPollingOptions<T> {
  /** 当前行程 id。为 null/undefined 时不启动轮询 */
  tripId: string | null | undefined
  /**
   * 拉取一次最新数据（通常是 loadTrip）。返回最新数据，供判断是否继续。
   * 返回 null 表示这次拉取失败——此时仍会按 intervalMs 重试（任务4 第4点：
   * 网络偶发失败要能自行恢复）。
   */
  fetch: () => Promise<T | null>
  /** 从返回数据里取 status，用于决定「是否继续轮询」与「是否刚到达终态」 */
  getStatus: (data: T) => string | undefined
  /** 判断某个状态是否属于「仍在进行中」。默认覆盖 generating */
  isOngoing?: (status: string) => boolean
  /** 轮询间隔（毫秒），默认 2500 */
  intervalMs?: number
  /** 首次拿到数据时回调一次；之后每次状态发生迁移再回调一次 */
  onStatusChange?: (status: string, data: T) => void
  /** 是否启用。默认 true */
  enabled?: boolean
}

/** 默认的「进行中」判定：目前只有 generating 需要轮询 */
function defaultIsOngoing(status: string): boolean {
  return status === 'generating'
}

/**
 * 生成进度轮询。
 *
 * 生命周期与「行程是否在生成中」解耦：进入时先拉一次，只要拉回来的状态仍在进行中，
 * 就持续拉取；一旦拉到终态（ready/partial/failed）或数据里已不是进行中，自动停表。
 * 组件卸载或 tripId 变化时清理定时器，绝不泄漏。
 */
export function useGenerationPolling<T>(options: GenerationPollingOptions<T>): void {
  const {
    tripId,
    fetch,
    getStatus,
    isOngoing = defaultIsOngoing,
    intervalMs = 2500,
    onStatusChange,
    enabled = true,
  } = options

  // 用 ref 持有最新的回调，避免把它们放进依赖数组——
  // 否则每次 render 生成的新函数都会重启整个轮询循环（这才是原来的老问题）。
  const fetchRef = useRef(fetch)
  const getStatusRef = useRef(getStatus)
  const isOngoingRef = useRef(isOngoing)
  const onStatusChangeRef = useRef(onStatusChange)
  fetchRef.current = fetch
  getStatusRef.current = getStatus
  isOngoingRef.current = isOngoing
  onStatusChangeRef.current = onStatusChange

  useEffect(() => {
    if (!enabled || !tripId) return

    let cancelled = false
    let timer: number | null = null
    // 记录上一次已知状态，用于只在「状态发生变化」时回调通知
    let lastStatus: string | null = null

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    const tick = async () => {
      if (cancelled) return

      // 拉一次最新数据。失败（返回 null / 抛错）不终止循环——
      // 网络抖动不该让用户永远停在加载态（任务4 第4点）。
      const data = await fetchRef.current().catch(() => null)
      if (cancelled) return

      if (data) {
        const status = getStatusRef.current(data)
        // 首次拿到状态、以及状态发生迁移时通知外部（比如「生成完成」的提示）
        if (status && status !== lastStatus) {
          lastStatus = status
          onStatusChangeRef.current?.(status, data)
        }

        // 到达终态：停表。不满足「进行中」就不再排下一次。
        if (!status || !isOngoingRef.current(status)) {
          return
        }
      }
      // 注意：data 为 null（请求失败）时**继续**轮询，靠下一次重试自愈。

      // 仍然进行中：排下一次。循环由自己驱动，不看任何外部状态。
      timer = window.setTimeout(tick, intervalMs)
    }

    // 进入时立刻拉一次——关键修复点（任务4）：
    // 不再用「组件里的状态」预判要不要开始，而是无条件先拉一次，
    // 让服务端返回的真实状态来决定。这样「首次打开生成中的行程」一定被覆盖。
    timer = window.setTimeout(tick, 0)

    return () => {
      cancelled = true
      clearTimer()
    }
    // 只依赖 tripId 与间隔：回调都走 ref，重建循环的唯一理由就是换了行程
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, intervalMs, enabled])
}
