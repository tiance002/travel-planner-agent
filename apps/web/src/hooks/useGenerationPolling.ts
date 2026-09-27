// 生成进度的轮询 hook。
//
// 背景（见审查报告 A13 / 3.2）：
//
//   TripDetail 原来的写法是「effect 里 setTimeout(loadTrip)，effect 依赖
//   [trip.status, trip.genDayIndex]」。问题在于：定时器只会在依赖变化时重新设置，
//   而一次 loadTrip 如果拿回来的还是 generating、genDayIndex 也没变，
//   依赖数组就没变、effect 不重跑、定时器不会再设一个——
//   轮询就此停摆，用户看着进度条一动不动，直到手动刷新页面。
//
//   正确做法是让**轮询自己驱动自己**：每次请求结束（无论结果如何）都重新排下一次，
//   只要「还在生成中」这个条件仍然成立。依赖只保留 tripId，
//   其余判断都在循环内部读最新状态——这样外部状态怎么变都不会打断循环。
//
// 为什么用自循环 setTimeout 而不是 setInterval：
//   setInterval 会按固定频率发请求，但前一个请求还在飞的时候下一个又发了，
//   慢网络下会堆积请求、乱序更新；自循环是「上一次结束后再等 N 毫秒」，
//   天然不会并发，也不会因为请求慢而雪崩。

import { useEffect, useRef } from 'react'

export interface GenerationPollingOptions<T> {
  /** 当前行程 id。为 null/undefined 时不启动轮询 */
  tripId: string | null | undefined
  /** 立刻判断「当前是否处于生成中」。返回 true 才会启动下一轮 */
  isGenerating: () => boolean
  /** 拉取一次最新数据（通常是 loadTrip）。返回最新数据，供判断是否终态 */
  fetch: () => Promise<T | null>
  /** 从返回数据里取 status，用于决定「是否继续轮询」与「是否刚完成」 */
  getStatus: (data: T) => string | undefined
  /** 轮询间隔（毫秒），默认 2500 */
  intervalMs?: number
  /** 首次进入生成中时回调一次；状态变为终态（ready/partial/failed）时再回调一次 */
  onStatusChange?: (status: string, data: T) => void
  /** 是否启用。默认 true */
  enabled?: boolean
}

/**
 * 生成进度轮询。
 *
 * 生命周期与「行程是否在生成中」解耦：只要还在生成，就持续拉取；
 * 一旦拉到终态，自动停表并回调一次。组件卸载或 tripId 变化时清理定时器。
 */
export function useGenerationPolling<T>(options: GenerationPollingOptions<T>): void {
  const {
    tripId,
    isGenerating,
    fetch,
    getStatus,
    intervalMs = 2500,
    onStatusChange,
    enabled = true,
  } = options

  // 用 ref 持有最新的回调与判定函数，避免把它们放进依赖数组——
  // 否则每次 render 生成的新函数都会重启整个轮询循环（这才是原来的老问题）。
  const isGeneratingRef = useRef(isGenerating)
  const fetchRef = useRef(fetch)
  const getStatusRef = useRef(getStatus)
  const onStatusChangeRef = useRef(onStatusChange)
  isGeneratingRef.current = isGenerating
  fetchRef.current = fetch
  getStatusRef.current = getStatus
  onStatusChangeRef.current = onStatusChange

  useEffect(() => {
    if (!enabled || !tripId) return

    let cancelled = false
    let timer: number | null = null
    let lastStatus: string | null = null

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    const tick = async () => {
      if (cancelled) return

      const data = await fetchRef.current().catch(() => null)
      if (cancelled) return

      const status = data ? getStatusRef.current(data) : undefined

      // 首次拿到状态、以及状态发生迁移时通知外部（比如「生成完成」的提示）
      if (data && status && status !== lastStatus) {
        lastStatus = status
        onStatusChangeRef.current?.(status, data)
      }

      // 关键：无论这次请求结果如何，只要「还在生成中」就重新排下一次。
      // 这就是修复点——循环由自己驱动，不被外部状态变化的时机绑架。
      if (isGeneratingRef.current()) {
        timer = window.setTimeout(tick, intervalMs)
      }
    }

    // 进入时若已经处于生成中，立刻开始循环；否则等状态变化触发重新挂载
    if (isGeneratingRef.current()) {
      timer = window.setTimeout(tick, intervalMs)
    }

    return () => {
      cancelled = true
      clearTimer()
    }
    // 只依赖 tripId 与间隔：回调都走 ref，重建循环的唯一理由就是换了行程
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, intervalMs, enabled])
}
