// 生成任务的「真实生命周期」锁（见审查报告 A04 / 任务2、任务6、任务7）。
//
// 为什么不能在中间件里做并发控制：
//   HTTP 层只能在「请求开始 → 响应结束」这段里计数。但生成接口是「立刻返回 202、
//   任务在后台跑几十秒到几分钟」——响应一结束，中间件的计数就归零了，
//   用户连点几下就能开好几张图。要管住这件事，锁的粒度必须是**任务本身**，
//   而不是请求。
//
// 为什么用数据库而不是进程内 Map：
//   进程内 Map 只在单进程内有效，重启即失忆，而且无法区分「任务真在跑」还是
//   「上次崩溃留下的僵尸」。数据库是唯一所有实例都能看到、且能跨重启存活的地方。
//   本轮仍然是单实例 MVP，用数据库不是为了「多实例原子性」，
//   而是为了**崩溃可恢复**与**状态可观测**——这两点进程内 Map 永远做不到。
//
// 三个字段分工（Trip 上）：
//   genRunId       谁在跑（null = 空闲）。所有写操作都要带上它做归属校验，
//                  保证「只有持锁的那次运行能改状态、能续心跳、能清理」。
//   genHeartbeatAt 最近一次心跳。只由持锁运行刷新。用于判定僵尸（任务7）。
//   genRunStartedAt 启动时间，仅用于展示与排查。
//
// 两类锁：
//   1. 行程级：同一个 Trip 同时只能有一个任务（genRunId 非 null 且心跳新鲜 → 抢不到）。
//   2. 用户级：同一个用户同时只能有一个任务（该用户名下没有其他「活着的」任务）。
//   用户级必须也做，否则用户可以对两个不同行程各点一次，同时开两张图。

import { randomUUID } from 'node:crypto'
import { prisma } from '../../db'

/**
 * 心跳超时：超过这个时间没刷新，就认为持锁的进程已经死了（任务7）。
 *
 * 取值依据：运行中的任务每 HEARTBEAT_INTERVAL_MS 刷新一次，
 * TTL 是它的若干倍，足以容忍事件循环繁忙、慢 SQL、GC 停顿造成的抖动。
 * 它**不是**「任务最长执行时间」——只要任务活着就会一直续心跳，
 * 跑一小时也不会被判僵尸。
 */
export const HEARTBEAT_TTL_MS = 90 * 1000

/** 心跳刷新间隔。两个超级步之间刷一次，也按时间兜底刷 */
export const HEARTBEAT_INTERVAL_MS = 20 * 1000

export type AcquireResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'trip_busy' | 'user_busy' }

/**
 * 尝试为一个 Trip 领取生成任务锁。
 *
 * 成功返回本次运行的 runId；失败给出原因（调用方据此返回不同的提示文案）。
 *
 * 注意这里**不吞掉 task6 的 review 场景**：等待人工裁决时锁是**继续持有**的
 * （任务2第5点要求「等待确认期间任务占用语义明确」）——因为图确实还挂在
 * interrupt 上、状态还在内存与 checkpoint 里，此时放锁会让第二个任务进来把
 * checkpoint 顶掉。等待期间的「占用」由心跳维持，不会因静默被判僵尸。
 */
export async function acquireRun(tripId: string, userId: string): Promise<AcquireResult> {
  // 先做一次用户级预检，给出更准确的提示文案。
  // 真正的原子性由下面的 updateMany 保证（预检只影响提示，不影响正确性）。
  const userBusy = await findUserActiveRun(userId, tripId)
  if (userBusy) return { ok: false, reason: 'user_busy' }

  const runId = randomUUID()
  const now = new Date()
  const freshAfter = new Date(now.getTime() - HEARTBEAT_TTL_MS)

  // 行程级原子抢锁：只有「没有持锁者」或「持锁者心跳已过期（僵尸）」才放行。
  // 把条件写进 WHERE，由数据库保证判断与写入是同一个原子动作——
  // 并发请求里只有一个能把 genRunId 从 null 变成自己的 runId。
  const result = await prisma.trip.updateMany({
    where: {
      id: tripId,
      userId,
      OR: [
        { genRunId: null },
        { genHeartbeatAt: null },
        { genHeartbeatAt: { lt: freshAfter } },
      ],
    },
    data: {
      genRunId: runId,
      genHeartbeatAt: now,
      genRunStartedAt: now,
    },
  })

  if (result.count === 0) return { ok: false, reason: 'trip_busy' }
  return { ok: true, runId }
}

/**
 * 查该用户名下是否有别的「活着的」任务（心跳未过期）。
 * excludeTripId 用于排除自己——同一个 Trip 的重复请求应由行程级锁报错，
 * 而不是被用户级预检拦下（两者提示文案不同）。
 */
async function findUserActiveRun(userId: string, excludeTripId: string): Promise<boolean> {
  const freshAfter = new Date(Date.now() - HEARTBEAT_TTL_MS)
  const count = await prisma.trip.count({
    where: {
      userId,
      id: { not: excludeTripId },
      genRunId: { not: null },
      genHeartbeatAt: { gt: freshAfter },
    },
  })
  return count > 0
}

/**
 * 刷新心跳。只有持锁的那次运行能刷（runId 不匹配的写入会被 WHERE 挡掉）。
 * 返回 false 说明锁已经不在自己手上（例如被判定僵尸后别人接管了），
 * 调用方应当中止当前任务，避免继续写入污染新任务的数据（任务7第2点）。
 */
export async function heartbeatRun(tripId: string, runId: string): Promise<boolean> {
  const result = await prisma.trip.updateMany({
    where: { id: tripId, genRunId: runId },
    data: { genHeartbeatAt: new Date() },
  })
  return result.count > 0
}

/**
 * 释放锁。只有持锁运行能释放（runId 不匹配则什么都不做）。
 * 覆盖正常完成、失败、异常退出三条路径——都必须在 finally 里调用，
 * 否则会留下「永不被释放」的占用（任务2第5点禁止的情况）。
 */
export async function releaseRun(tripId: string, runId: string): Promise<void> {
  await prisma.trip
    .updateMany({
      where: { id: tripId, genRunId: runId },
      data: { genRunId: null, genHeartbeatAt: null, genRunStartedAt: null },
    })
    .catch(() => undefined)
}

/**
 * 判断锁持有的运行是否还「活着」。用于写入前的守卫：
 * 一个已经失去锁的任务不应该继续覆盖数据库（任务7第2点）。
 */
export async function isRunOwner(tripId: string, runId: string): Promise<boolean> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { genRunId: true },
  })
  return trip?.genRunId === runId
}

/**
 * 清理僵尸锁：把心跳过期且没人接管的行程恢复成可再次生成的状态。
 *
 * 只在「用户重新点生成」时被动触发（见 acquireRun 的 WHERE 条件已经涵盖了
 * 过期接管），不引入后台定时任务——本轮不追求自动恢复进程，只保证
 * 「崩溃后用户重试一定能成功」这一条最基本的可恢复性。
 */
export async function countStaleRuns(): Promise<number> {
  const freshAfter = new Date(Date.now() - HEARTBEAT_TTL_MS)
  return prisma.trip.count({
    where: {
      genRunId: { not: null },
      OR: [{ genHeartbeatAt: null }, { genHeartbeatAt: { lt: freshAfter } }],
    },
  })
}
