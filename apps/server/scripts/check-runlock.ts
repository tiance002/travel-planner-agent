// 生成任务运行锁的自检（见审查报告任务2、任务6、任务7、任务9）。
//
// 为什么必须测：并发与僵尸判定是「平时看不出来、出事就丢数据」的一类逻辑。
// 这里直接用**真实数据库**跑真实的 run-lock 实现——不 mock 数据库，
// 因为原子性正是被测对象（mock 掉就测不到了）。
//
// 数据隔离：用带随机后缀的临时用户建行程，跑完删除，不碰已有数据。
//
// 用法：在 apps/server 目录 `npx tsx scripts/check-runlock.ts`

import { prisma } from '../src/db'
import {
  acquireRun,
  heartbeatRun,
  releaseRun,
  isRunOwner,
  countStaleRuns,
  HEARTBEAT_TTL_MS,
} from '../src/services/agent/run-lock'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name}`)
  }
}

const suffix = Math.random().toString(36).slice(2, 10)
const createdTripIds: string[] = []
let tempUserId = ''

/** 建一个临时行程，登记以便最后清理。返回 { id } 以便调用处统一用 `.id` */
async function makeTrip(days = 3, status = 'draft'): Promise<{ id: string }> {
  const trip = await prisma.trip.create({
    data: {
      userId: tempUserId,
      title: `自检行程-${suffix}-${createdTripIds.length}`,
      cityName: '杭州',
      cityAdcode: '330100',
      startDate: new Date('2026-10-01'),
      days,
      travelers: 2,
      status,
    },
  })
  createdTripIds.push(trip.id)
  return { id: trip.id }
}

async function main() {
  const user = await prisma.user.create({
    data: {
      username: `runlock-${suffix}`,
      passwordHash: 'x',
    },
  })
  tempUserId = user.id

  // -------------------------------------------------------------------------
  console.log('\n--- 行程级锁：同一 Trip 只能有一个运行 ---')
  // -------------------------------------------------------------------------

  const tripA = await makeTrip()

  const first = await acquireRun(tripA.id, tempUserId)
  check('首次领取成功', first.ok, true)

  const second = await acquireRun(tripA.id, tempUserId)
  check('同一 Trip 第二次领取失败', second.ok, false)
  if (!second.ok) check('失败原因标识为行程占用', second.reason, 'trip_busy')

  // -------------------------------------------------------------------------
  console.log('\n--- 用户级锁：同一用户不能对两个 Trip 同时生成 ---')
  // -------------------------------------------------------------------------

  const tripB = await makeTrip()
  const other = await acquireRun(tripB.id, tempUserId)
  check('同一用户的另一个 Trip 领取失败', other.ok, false)
  if (!other.ok) check('失败原因标识为用户占用', other.reason, 'user_busy')

  // -------------------------------------------------------------------------
  console.log('\n--- 心跳与释放：只有持锁者能操作 ---')
  // -------------------------------------------------------------------------

  if (first.ok) {
    check('持锁者心跳续约成功', await heartbeatRun(tripA.id, first.runId), true)
    check('非持锁者心跳失败', await heartbeatRun(tripA.id, 'not-the-owner'), false)
    check('持锁者确认为所有者', await isRunOwner(tripA.id, first.runId), true)
    check('非持锁者不是所有者', await isRunOwner(tripA.id, 'not-the-owner'), false)

    // 非持锁者不能释放
    await releaseRun(tripA.id, 'not-the-owner')
    check('非持锁者释放无效（锁仍在）', await isRunOwner(tripA.id, first.runId), true)

    // 持锁者释放后，别人可以重新领取
    await releaseRun(tripA.id, first.runId)
    check('持锁者释放后不再是所有者', await isRunOwner(tripA.id, first.runId), false)
    const reacquire = await acquireRun(tripA.id, tempUserId)
    check('释放后可以重新领取', reacquire.ok, true)
    if (reacquire.ok) await releaseRun(tripA.id, reacquire.runId)
  }

  // -------------------------------------------------------------------------
  console.log('\n--- 僵尸判定：靠心跳而不是固定超时（任务7）---')
  // -------------------------------------------------------------------------

  // 构造一个「看起来在生成、但心跳已经过期」的行程 = 进程崩溃遗留
  const zombieTrip = await makeTrip()
  const stale = new Date(Date.now() - HEARTBEAT_TTL_MS - 60_000)
  await prisma.trip.update({
    where: { id: zombieTrip.id },
    data: {
      status: 'generating',
      genRunId: 'dead-run',
      genHeartbeatAt: stale,
      genRunStartedAt: stale,
      // updatedAt 故意保持「刚刚」——旧实现正是靠 updatedAt 判僵尸，这里要证明它错了
      updatedAt: new Date(),
    },
  })

  // 注意：该用户此时没有其他活跃任务，所以能走到行程级抢锁。
  // 僵尸锁（心跳过期）应可被接管。
  const takeover = await acquireRun(zombieTrip.id, tempUserId)
  check('心跳过期的僵尸锁可被接管', takeover.ok, true)
  if (takeover.ok) await releaseRun(zombieTrip.id, takeover.runId)

  // 反向用例：心跳新鲜的任务**不可**被接管，即便 updatedAt 很旧
  const aliveTrip = await makeTrip()
  const aliveRun = await acquireRun(aliveTrip.id, tempUserId)
  if (aliveRun.ok) {
    // 把 updatedAt 强行改旧，模拟「任务跑了很久、没有用户交互」
    await prisma.trip.update({
      where: { id: aliveTrip.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) },
    })
    const steal = await acquireRun(aliveTrip.id, tempUserId)
    check('心跳新鲜的任务不可被接管（尽管 updatedAt 很旧）', steal.ok, false)
    await releaseRun(aliveTrip.id, aliveRun.runId)
  }

  // -------------------------------------------------------------------------
  console.log('\n--- 等待人工裁决：长时间挂起仍是「活着」---')
  // -------------------------------------------------------------------------

  // 模拟：任务处于 waiting-review（genReview 有值）、心跳持续被刷新。
  // 即使挂起很久（比如用户去开会了两小时），也不应被判僵尸。
  const reviewTrip = await makeTrip()
  const reviewRun = await acquireRun(reviewTrip.id, tempUserId)
  if (reviewRun.ok) {
    await prisma.trip.update({
      where: { id: reviewTrip.id },
      data: {
        status: 'generating',
        genReview: JSON.stringify({ kind: 'confirm', dayIndex: 1, summary: '等确认' }),
      },
    })
    // 模拟心跳持续刷新（图挂在 interrupt 上时，heartbeat 定时器仍在跑）
    await heartbeatRun(reviewTrip.id, reviewRun.runId)
    // 把 updatedAt 改得很旧，代表「用户很久没操作」
    await prisma.trip.update({
      where: { id: reviewTrip.id },
      data: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })
    const stealWaiting = await acquireRun(reviewTrip.id, tempUserId)
    check('等待裁决两小时的任务不可被接管（有新鲜心跳）', stealWaiting.ok, false)
    await releaseRun(reviewTrip.id, reviewRun.runId)
  }

  // -------------------------------------------------------------------------
  console.log('\n--- 并发领取：N 个并发请求只有一个成功 ---')
  // -------------------------------------------------------------------------

  const raceTrip = await makeTrip()
  const results = await Promise.all(
    Array.from({ length: 8 }).map(() => acquireRun(raceTrip.id, tempUserId)),
  )
  const winners = results.filter((r) => r.ok)
  check('8 个并发领取只成功 1 个', winners.length, 1)
  if (winners[0]?.ok) await releaseRun(raceTrip.id, winners[0].runId)

  // -------------------------------------------------------------------------
  console.log('\n--- 僵尸计数：可观测性 ---')
  // -------------------------------------------------------------------------

  const zombieCount = await countStaleRuns()
  check('僵尸计数为非负整数', Number.isInteger(zombieCount) && zombieCount >= 0, true)
}

try {
  await main()
} finally {
  // 清理：删行程（TripDay/TripItem 级联）与临时用户
  if (createdTripIds.length > 0) {
    await prisma.trip.deleteMany({ where: { id: { in: createdTripIds } } }).catch(() => undefined)
  }
  if (tempUserId) {
    await prisma.user.delete({ where: { id: tempUserId } }).catch(() => undefined)
  }
  await prisma.$disconnect().catch(() => undefined)
}

console.log(`\n运行锁自检：${pass}/${pass + fail} 通过`)
if (fail > 0) {
  console.log('\n未通过的用例：')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
