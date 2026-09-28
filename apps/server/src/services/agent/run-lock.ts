import { randomUUID } from 'node:crypto'
import { prisma } from '../../db'
import type { Prisma } from '../../generated/prisma/client'
import { isPendingCommitShape } from './pending-commit'

export const HEARTBEAT_TTL_MS = 90_000
export const HEARTBEAT_INTERVAL_MS = 20_000
export class RunLostError extends Error {
  constructor() { super('任务已失去运行权，请查看当前行程状态') }
}
export type AcquireResult = { ok: true; runId: string } | { ok: false; reason: 'trip_busy' | 'user_busy' }

// UNIQUE 是用户级互斥的最终防线。事务第一条是写操作，SQLite 在读取前串行化写事务。
export async function acquireRun(tripId: string, userId: string): Promise<AcquireResult> {
  const runId = randomUUID()
  const now = new Date()
  const stale = new Date(now.getTime() - HEARTBEAT_TTL_MS)
  try {
    return await prisma.$transaction(async tx => {
      // A pending automatic commit contains a complete, already-reviewed day.
      // If its worker dies, release only the owner columns and keep the typed
      // journal/phase so the same trip can retry the database commit without
      // spending another model call.  Corrupt pending payloads are downgraded
      // to recovery below instead of being silently treated as resumable.
      await tx.trip.updateMany({
        where: { userId, genRunId: { not: null }, genRunPhase: 'commit_pending', genReview: { not: null },
          OR: [{ genHeartbeatAt: null }, { genHeartbeatAt: { lt: stale } }] },
        data: { genRunId: null, genActiveUserId: null, genHeartbeatAt: null, genRunStartedAt: null },
      })
      const pendingRows = await tx.trip.findMany({
        where: { userId, genRunId: null, genRunPhase: 'commit_pending', genReview: { not: null } },
        select: { id: true, genReview: true },
      })
      const corruptPendingIds = pendingRows.filter(row => {
        try { return !isPendingCommitShape(JSON.parse(row.genReview!)) } catch { return true }
      }).map(row => row.id)
      if (corruptPendingIds.length) {
        await tx.trip.updateMany({
          where: { id: { in: corruptPendingIds }, userId, genRunPhase: 'commit_pending', genRunId: null },
          data: { genRunPhase: 'recovery', genError: '待提交结果损坏，请取消后安全补缺', genReviewId: null },
        })
      }
      // A review resume briefly uses `reviewing` and then `running` while the
      // checkpoint is being continued.  If the process dies in either phase,
      // the review payload is still the only safe source of truth.  Move that
      // stale lock to manual recovery, but keep genReview/checkpoint intact.
      // Clearing only the ownership columns lets another trip of the same user
      // run while preventing this trip from being silently regenerated.
      await tx.trip.updateMany({
        where: { userId, genRunId: { not: null }, genReview: { not: null },
          AND: [{ OR: [{ genRunPhase: null }, { genRunPhase: { notIn: ['waiting', 'recovery', 'commit_pending'] } }] },
            { OR: [{ genHeartbeatAt: null }, { genHeartbeatAt: { lt: stale } }] }] },
        data: {
          genRunId: null,
          genActiveUserId: null,
          genRunPhase: 'recovery',
          genHeartbeatAt: null,
          genRunStartedAt: null,
          genError: '裁决恢复进程已中断，请取消未确认方案后安全补缺',
        },
      })
      // A stale run without a pending review can be safely abandoned.  This
      // is the only path that clears the old run automatically.
      await tx.trip.updateMany({
        where: { userId, genRunId: { not: null }, genReview: null,
          AND: [{ OR: [{ genRunPhase: null }, { genRunPhase: { notIn: ['waiting', 'recovery'] } }] },
            { OR: [{ genHeartbeatAt: null }, { genHeartbeatAt: { lt: stale } }] }] },
        data: { genRunId: null, genActiveUserId: null, genRunPhase: null, genHeartbeatAt: null, genRunStartedAt: null },
      })
      // A failed automatic commit leaves a model result in genReview with a
      // commit_pending phase.  Valid payloads were made reclaimable above;
      // this branch claims that exact pending value and never starts a model.
      const target = await tx.trip.findUnique({ where: { id: tripId }, select: { genRunId: true, genRunPhase: true, genReview: true } })
      let pendingCommit = false
      if (target?.genRunId === null && target.genRunPhase === 'commit_pending' && target.genReview) {
        try { pendingCommit = isPendingCommitShape(JSON.parse(target.genReview)) } catch { pendingCommit = false }
      }
      if (pendingCommit) {
        const pendingResult = await tx.trip.updateMany({
          where: { id: tripId, userId, genRunId: null, genRunPhase: 'commit_pending' },
          data: { genRunId: runId, genActiveUserId: userId, genRunPhase: 'running', genHeartbeatAt: now, genRunStartedAt: now },
        })
        if (pendingResult.count) return { ok: true as const, runId }
      }
      const result = await tx.trip.updateMany({
        where: { id: tripId, userId, genRunId: null, genReview: null },
        data: { genRunId: runId, genActiveUserId: userId, genRunPhase: 'running', genHeartbeatAt: now, genRunStartedAt: now },
      })
      return result.count ? { ok: true as const, runId } : { ok: false as const, reason: 'trip_busy' as const }
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { ok: false, reason: 'user_busy' }
    throw error
  }
}
export async function heartbeatRun(tripId: string, runId: string): Promise<boolean> {
  const result = await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId }, data: { genHeartbeatAt: new Date() } })
  return result.count > 0
}
export async function releaseRun(tripId: string, runId: string): Promise<void> {
  // Keep a durable automatic-commit handoff available after the worker exits.
  // The payload is internal and only reclaimable by acquireRun for this same
  // trip/user; all ordinary runs still clear their phase as before.
  const current = await prisma.trip.findUnique({ where: { id: tripId }, select: { genRunPhase: true, genReview: true } })
  let phase: string | null = null
  if (current?.genRunPhase === 'commit_pending' && current.genReview) {
    try {
      phase = isPendingCommitShape(JSON.parse(current.genReview)) ? 'commit_pending' : 'recovery'
    } catch { phase = 'recovery' }
  }
  await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId },
    data: { genRunId: null, genActiveUserId: null, genRunPhase: phase, genHeartbeatAt: null, genRunStartedAt: null } })
}
export async function isRunOwner(tripId: string, runId: string): Promise<boolean> {
  return (await prisma.trip.findUnique({ where: { id: tripId }, select: { genRunId: true } }))?.genRunId === runId
}
export async function assertRunOwner(tripId: string, runId: string): Promise<void> {
  if (!await isRunOwner(tripId, runId)) throw new RunLostError()
}
// 在一条SQL中检查归属并写入。事务内首先执行条件写，防止后续业务写被接管穿插。
export async function updateOwnedTrip(tripId: string, runId: string, data: Prisma.TripUpdateManyMutationInput, tx: Prisma.TransactionClient = prisma) {
  const result = await tx.trip.updateMany({ where: { id: tripId, genRunId: runId }, data })
  if (!result.count) throw new RunLostError()
}
export async function countStaleRuns(): Promise<number> {
  return prisma.trip.count({ where: { genRunId: { not: null },
    AND: [{ OR: [{ genRunPhase: null }, { genRunPhase: { notIn: ['waiting', 'recovery'] } }] },
      { OR: [{ genHeartbeatAt: null }, { genHeartbeatAt: { lt: new Date(Date.now() - HEARTBEAT_TTL_MS) } }] }] } })
}
// 只取消静止的 waiting/recovery，保留已落库日期和打卡。新生成使用新thread，不删除checkpoint。
export async function cancelSuspendedRun(tripId: string, userId: string): Promise<boolean> {
  const result = await prisma.trip.updateMany({
    where: { id: tripId, userId, OR: [
      { genRunPhase: { in: ['waiting', 'recovery'] } },
      // A stopped automatic commit has no model work left.  Explicit cancel
      // may discard only its uncommitted candidate; saved days/check-ins stay.
      { genRunPhase: 'commit_pending', genRunId: null },
    ] },
    data: { genRunId: null, genActiveUserId: null, genRunPhase: null, genReview: null, genReviewId: null,
      genRunConfig: null, genHeartbeatAt: null, genRunStartedAt: null, status: 'partial',
      genProgress: null, genError: '已取消未确认方案，可从已保存的日期安全补缺' },
  })
  return result.count > 0
}
