import assert from 'node:assert/strict'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { prisma } from '../src/db'
import { acquireRun, cancelSuspendedRun, HEARTBEAT_TTL_MS, releaseRun } from '../src/services/agent/run-lock'
import { createGraphRuntime, ReviewConflictError } from '../src/services/agent/graph-run'
import { createTripsRouter } from '../src/routes/trips'
import { signToken } from '../src/utils/jwt'
import type { Poi } from '../src/services/amap'
import type { ToolLoopOptions, ToolLoopResult } from '../src/services/agent/model-client'
import type { ToolResult } from '../src/services/agent/tools'
import type { AgentGraphContext } from '../src/services/agent/graph'

// Run only through tools/test-isolated.mjs, never against the development DB.
assert.equal(process.env.TRAVEL_TEST_ISOLATED, '1', 'requires an isolated test database')

let pass = 0
let fail = 0
const failures: string[] = []
const users: string[] = []
const runtimes: Array<{ close: () => void }> = []
const servers: Server[] = []

function ok(name: string): void {
  pass += 1
  console.log(`  ✓ ${name}`)
}

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected)
    ok(name)
  } catch (error) {
    fail += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.log(`  ✗ ${name}`)
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(name: string, predicate: () => Promise<boolean> | boolean, attempts = 4_000): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`等待超时：${name}`)
}

function makePoi(poiId: string, name = poiId, opts: Partial<Poi> = {}): Poi {
  return {
    poiId,
    name,
    lng: 120.15,
    lat: 30.28,
    address: '杭州市西湖区',
    type: '风景名胜;公园广场;公园',
    typecode: '110101',
    cityName: '杭州',
    district: '西湖区',
    adcode: '330100',
    rating: 4.7,
    cost: null,
    tag: '',
    keytag: '',
    openTimeToday: '00:00-24:00',
    openTimeWeek: '00:00-24:00',
    tel: '',
    photos: [],
    distance: null,
    ...opts,
  }
}

const credentials = {
  provider: 'mock',
  baseUrl: 'https://mock.invalid/v1',
  modelName: 'mock',
  apiKey: 'test-key',
}

interface MockOptions {
  tag: string
  gate?: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }
  gateCall?: number
  throwOnCall?: (call: number, dayIndex: number) => Error | undefined
  warnings?: (dayIndex: number) => string[]
  onPrompt?: (prompt: string, call: number) => void
}

/**
 * This is a model stub for the production graph, rather than a replacement graph.
 * It calls the injected executeTool, whose real registration path writes POIs into
 * the graph registry and returns the same JSON-shaped result as the production tool.
 */
function makeMockDeps(options: MockOptions): {
  chatClient: NonNullable<AgentGraphContext['chatClient']>
  toolRunner: NonNullable<AgentGraphContext['toolRunner']>
  optimizeCommute: NonNullable<AgentGraphContext['optimizeCommute']>
  estimateTransitTotal: NonNullable<AgentGraphContext['estimateTransitTotal']>
  calls: () => number
  prompts: string[]
} {
  let calls = 0
  const prompts: string[] = []
  const chatClient = async (args: ToolLoopOptions): Promise<ToolLoopResult> => {
    calls += 1
    prompts.push(args.userPrompt)
    options.onPrompt?.(args.userPrompt, calls)
    const day = Number(/第\s*(\d+)\s*天/.exec(args.userPrompt)?.[1] ?? 1)
    if (options.gate && calls === (options.gateCall ?? 1)) {
      options.gate.entered.resolve(undefined)
      await options.gate.release.promise
    }
    const thrown = options.throwOnCall?.(calls, day)
    if (thrown) throw thrown
    const poiId = `${options.tag}-d${day}-c${calls}`
    const result = await args.executeTool(
      'search_poi',
      JSON.stringify({ poiId, name: `${options.tag} 第${day}天地点${calls}` }),
    )
    assert.equal(result.ok, true)
    return {
      content: JSON.stringify({
        dayStyle: 'normal',
        summary: `${options.tag} 第${day}天方案${calls}`,
        items: [{ poiId, itemType: 'spot', slot: 'morning', note: '测试地点' }],
      }),
      messages: [],
      rounds: 1,
      toolCallCount: 1,
      finishReason: 'stop',
    }
  }

  const toolRunner: NonNullable<AgentGraphContext['toolRunner']> = async (
    name: string,
    rawArgs: string,
    context: { registry: Map<string, Poi> },
  ): Promise<ToolResult> => {
    if (name === 'search_poi' || name === 'search_nearby') {
      const parsed = JSON.parse(rawArgs) as { poiId?: string; name?: string }
      const poi = makePoi(parsed.poiId ?? `${options.tag}-fallback`, parsed.name ?? '测试地点')
      context.registry.set(poi.poiId, poi)
      return { ok: true, data: [{ poiId: poi.poiId, name: poi.name, rating: poi.rating }] }
    }
    if (name === 'get_route') return { ok: true, data: { minutes: 12, distance: 2_000 } }
    if (name === 'get_city_center') return { ok: true, data: { lng: 120.15, lat: 30.28 } }
    if (name === 'get_weather') return { ok: true, data: { casts: [] } }
    return { ok: false, error: `unexpected tool ${name}` }
  }

  const optimizeCommute: NonNullable<AgentGraphContext['optimizeCommute']> = async (days) => {
    const dayIndex = days[0]?.dayIndex ?? 1
    return options.warnings?.(dayIndex) ?? []
  }
  const estimateTransitTotal: NonNullable<AgentGraphContext['estimateTransitTotal']> = async () => 12
  return { chatClient, toolRunner, optimizeCommute, estimateTransitTotal, calls: () => calls, prompts }
}

async function makeUser(label: string): Promise<{ id: string; username: string; token: string }> {
  const username = `lifecycle-${label}-${randomUUID()}`
  const user = await prisma.user.create({ data: { username, passwordHash: 'test' } })
  users.push(user.id)
  return { ...user, token: signToken({ userId: user.id, username }) }
}

async function makeTrip(userId: string, days = 1, label = 'trip', extra: Record<string, unknown> = {}) {
  return prisma.trip.create({
    data: {
      userId,
      title: `${label}-${randomUUID()}`,
      cityName: '杭州',
      cityAdcode: '330100',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      days,
      travelers: 1,
      stayResolved: true,
      stayPoiId: 'HOTEL',
      stayName: '测试酒店',
      stayLng: 120.15,
      stayLat: 30.28,
      ...extra,
    },
  })
}

function makeRuntime(options: MockOptions & { checkpointPath?: string }) {
  const deps = makeMockDeps(options)
  const checkpointPath = options.checkpointPath ?? path.join(process.env.TRAVEL_TEST_DIR ?? process.cwd(), `lifecycle-${randomUUID()}.sqlite`)
  const runtime = createGraphRuntime({
    checkpointPath,
    getCredentials: async () => credentials,
    getWeather: async (_adcode: string) => ({ city: '杭州', adcode: '330100', reportTime: '', casts: [] }),
    chatClient: deps.chatClient,
    toolRunner: deps.toolRunner,
    optimizeCommute: deps.optimizeCommute,
    estimateTransitTotal: deps.estimateTransitTotal,
  })
  runtimes.push(runtime)
  return { runtime, checkpointPath, ...deps }
}

type RestartChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

async function spawnRestartChild(input: { tripId: string; runId: string; reviewId: string; checkpointPath: string }): Promise<RestartChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      '--lifecycle-child-restart',
    ], {
      env: {
        ...process.env,
        LIFECYCLE_CHILD_TRIP_ID: input.tripId,
        LIFECYCLE_CHILD_RUN_ID: input.runId,
        LIFECYCLE_CHILD_REVIEW_ID: input.reviewId,
        LIFECYCLE_CHILD_CHECKPOINT: input.checkpointPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function markOwnedGenerating(tripId: string, userId: string): Promise<string> {
  const acquired = await acquireRun(tripId, userId)
  if (!acquired.ok) throw new Error(`抢锁失败：${acquired.reason}`)
  const marked = await prisma.trip.updateMany({
    where: { id: tripId, genRunId: acquired.runId, genRunPhase: 'running' },
    data: { status: 'generating', genProgress: '正在准备', genError: null, genReview: null },
  })
  assert.equal(marked.count, 1)
  return acquired.runId
}

async function serve(runtime: ReturnType<typeof createGraphRuntime>, token: string) {
  const app = express()
  app.use(express.json())
  app.use('/api/trips', createTripsRouter(runtime))
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 500
    res.status(Number.isInteger(status) && status >= 400 ? status : 500).json({ error: error instanceof Error ? error.message : String(error) })
  })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { server, request }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function seedDay(
  tripId: string,
  dayIndex: number,
  summary: string,
  options: { dayType?: string; intensity?: string; checked?: boolean; poiId?: string } = {},
): Promise<void> {
  const poiId = options.poiId ?? `seed-${tripId.slice(0, 6)}-${dayIndex}`
  await prisma.tripDay.create({
    data: {
      tripId,
      dayIndex,
      date: new Date(`2026-10-${String(dayIndex).padStart(2, '0')}T00:00:00.000Z`),
      summary,
      dayType: options.dayType ?? 'normal',
      intensity: options.intensity ?? 'medium',
      items: {
        create: [{
          orderIndex: 1,
          slot: 'morning',
          itemType: 'spot',
          poiId,
          name: `${summary} 地点`,
          lng: 120.1,
          lat: 30.2,
          photos: null,
          checkedAt: options.checked ? new Date('2026-10-01T08:00:00.000Z') : null,
        }],
      },
    },
  })
}

async function testAtomicDifferentTrips(): Promise<void> {
  console.log('\n--- P0：同用户不同 Trip 原子互斥 ---')
  const user = await makeUser('atomic')
  const a = await makeTrip(user.id, 1, 'atomic-a')
  const b = await makeTrip(user.id, 1, 'atomic-b')
  const results = await Promise.all([acquireRun(a.id, user.id), acquireRun(b.id, user.id)])
  check('同用户两个 Trip 只有一个取得运行权', results.filter((result) => result.ok).length, 1)
  for (const [index, result] of results.entries()) if (result.ok) await releaseRun(index === 0 ? a.id : b.id, result.runId)
}

async function testEightHttpGenerations(): Promise<void> {
  console.log('\n--- P0：同一 Trip 八路真实 HTTP 生成 ---')
  const user = await makeUser('eight')
  const trip = await makeTrip(user.id, 1, 'eight')
  const gate = { entered: deferred(), release: deferred() }
  const { runtime, calls } = makeRuntime({ tag: 'eight', gate })
  const http = await serve(runtime, user.token)
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => http.request(`/api/trips/${trip.id}/generate`, {
      method: 'POST', body: JSON.stringify({ mode: 'continue', parallel: false }),
    })))
    await gate.entered.promise
    check('八路请求只有一个 202', responses.filter((response) => response.status === 202).length, 1)
    check('八路请求其余均为 409', responses.filter((response) => response.status === 409).length, 7)
    check('只启动一次真实模型调用', calls(), 1)
  } finally {
    gate.release.resolve()
    await waitFor('八路后台生成收尾', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunId: true } }))?.genRunId === null)
    await closeServer(http.server)
  }
}

async function testUserCrossTripHttp(): Promise<void> {
  console.log('\n--- P0：同用户两个 Trip 真实 HTTP 并发 ---')
  const user = await makeUser('cross')
  const a = await makeTrip(user.id, 1, 'cross-a')
  const b = await makeTrip(user.id, 1, 'cross-b')
  const gate = { entered: deferred(), release: deferred() }
  const { runtime, calls } = makeRuntime({ tag: 'cross', gate })
  const http = await serve(runtime, user.token)
  try {
    const responses = await Promise.all([
      http.request(`/api/trips/${a.id}/generate`, { method: 'POST', body: JSON.stringify({}) }),
      http.request(`/api/trips/${b.id}/generate`, { method: 'POST', body: JSON.stringify({}) }),
    ])
    await gate.entered.promise
    check('同用户不同 Trip 只有一个 202', responses.filter((response) => response.status === 202).length, 1)
    check('同用户不同 Trip 另一个 409', responses.filter((response) => response.status === 409).length, 1)
    check('同用户不同 Trip 只有一个模型调用', calls(), 1)
  } finally {
    gate.release.resolve()
    await waitFor('跨 Trip 后台生成收尾', async () => (await prisma.trip.count({ where: { userId: user.id, genRunId: { not: null } } })) === 0)
    await closeServer(http.server)
  }
}

async function testWaitingHeartbeatAndTtl(): Promise<void> {
  console.log('\n--- P0：真实 interrupt 等待裁决不被 TTL 接管 ---')
  const user = await makeUser('waiting')
  const trip = await makeTrip(user.id, 1, 'waiting')
  const { runtime } = makeRuntime({ tag: 'waiting' })
  const http = await serve(runtime, user.token)
  try {
    const response = await http.request(`/api/trips/${trip.id}/generate`, {
      method: 'POST', body: JSON.stringify({ mode: 'review', parallel: false }),
    })
    check('review 生成返回 202', response.status, 202)
    await waitFor('进入真实 waiting interrupt', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunPhase: true, genReview: true } }))?.genRunPhase === 'waiting')
    const reviewBefore = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genReviewId: true, genRunId: true } })
    await prisma.trip.update({ where: { id: trip.id }, data: { genHeartbeatAt: new Date(Date.now() - HEARTBEAT_TTL_MS * 2) } })
    const ordinary = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({}) })
    check('waiting 即使心跳过期，普通生成仍为 409', ordinary.status, 409)
    const reviewAfter = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genReviewId: true, genRunId: true, genRunPhase: true } })
    check('TTL 检查不清除待裁决载荷', [reviewAfter.genReview, reviewAfter.genReviewId, reviewAfter.genRunId, reviewAfter.genRunPhase], [reviewBefore.genReview, reviewBefore.genReviewId, reviewBefore.genRunId, 'waiting'])
    const cancel = await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
    check('waiting 可通过安全取消释放', cancel.status, 200)
  } finally {
    await closeServer(http.server)
  }
}

async function testConcurrentApproveKeepsLock(): Promise<void> {
  console.log('\n--- P0：两个 approve 并发，一个 202、一个 409，失败者不释放锁 ---')
  const user = await makeUser('approve')
  const trip = await makeTrip(user.id, 2, 'approve')
  const resumeGate = { entered: deferred(), release: deferred() }
  const { runtime } = makeRuntime({
    tag: 'approve',
    gate: resumeGate,
    gateCall: 2,
  })
  const http = await serve(runtime, user.token)
  try {
    const start = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'review' }) })
    check('双 approve 前的生成返回 202', start.status, 202)
    await waitFor('approve 初始 review', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReview: true } }))?.genReview !== null)
    const pending = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
    const responses = await Promise.all([
      http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reviewId: pending.genReviewId }) }),
      http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reviewId: pending.genReviewId }) }),
    ])
    check('并发 approve 只有一个 202', responses.filter((response) => response.status === 202).length, 1)
    check('并发 approve 失败者为 409', responses.filter((response) => response.status === 409).length, 1)
    await resumeGate.entered.promise
    const owner = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genRunPhase: true } })
    check('失败裁决请求没有释放赢家锁', owner.genRunId !== null && owner.genRunPhase === 'running', true)
    resumeGate.release.resolve()
    await waitFor('approve 后台进入下一张卡或终态', async () => {
      const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReview: true, status: true } })
      return row?.genReview !== null || ['ready', 'partial', 'recovery', 'failed'].includes(row?.status ?? '')
    })
    if ((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunPhase: true } })).genRunPhase) {
      await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
    }
  } finally {
    resumeGate.release.resolve()
    await closeServer(http.server)
  }
}

async function testChooseRace(): Promise<void> {
  console.log('\n--- P0：choose A/B 并发只落库一个方案 ---')
  const user = await makeUser('choose')
  const trip = await makeTrip(user.id, 1, 'choose')
  const { runtime } = makeRuntime({ tag: 'choose' })
  const http = await serve(runtime, user.token)
  try {
    const start = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'review', parallel: true }) })
    check('并行候选生成返回 202', start.status, 202)
    await waitFor('choose review', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReview: true } }))?.genReview !== null)
    const pending = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
    const responses = await Promise.all([
      http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'choose', choice: 'A', parallel: false, reviewId: pending.genReviewId }) }),
      http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'choose', choice: 'B', parallel: true, reviewId: pending.genReviewId }) }),
    ])
    check('并发 choose 只有一个 202', responses.filter((response) => response.status === 202).length, 1)
    check('并发 choose 另一个为 409', responses.filter((response) => response.status === 409).length, 1)
    await waitFor('choose 方案最终落库', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))?.status === 'ready')
    const days = await prisma.tripDay.findMany({ where: { tripId: trip.id }, include: { items: true } })
    check('choose 只有一个日期落库', days.length, 1)
    check('choose 只产生一个条目', days[0]?.items.length, 1)
    check('客户端 parallel 开关不改变已持久化的原任务模式', JSON.parse((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunConfig: true } })).genRunConfig ?? '{}').parallelCandidates, 2)
  } finally {
    await closeServer(http.server)
  }
}

async function testDirectConcurrentResume(): Promise<void> {
  console.log('\n--- P0：直接并发 resume 也只能有一个执行者 ---')
  const user = await makeUser('direct-resume')
  const trip = await makeTrip(user.id, 2, 'direct-resume')
  const gate = { entered: deferred(), release: deferred() }
  const { runtime } = makeRuntime({ tag: 'direct-resume', gate, gateCall: 2 })
  const runId = await markOwnedGenerating(trip.id, user.id)
  await runtime.generateTripWithGraph(trip.id, { mode: 'review', runId })
  const pending = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
  const answer = { decision: 'approve' as const }
  const calls = [
    runtime.resumeTripReview(trip.id, { answer, runId, reviewId: pending.genReviewId! }),
    runtime.resumeTripReview(trip.id, { answer, runId, reviewId: pending.genReviewId! }),
  ]
  await gate.entered.promise
  const owner = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genRunPhase: true, genReview: true } })
  check('direct 并发 resume 的赢家在模型阻塞时仍持有锁', [owner.genRunId, owner.genRunPhase, owner.genReview === null], [runId, 'running', true])
  gate.release.resolve()
  const results = await Promise.allSettled(calls)
  check('direct 并发 resume 一个成功一个冲突', [results.filter((result) => result.status === 'fulfilled').length, results.filter((result) => result.status === 'rejected').length], [1, 1])
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  check('direct 失败 resume 明确为 409 冲突', rejected?.reason instanceof ReviewConflictError || (rejected?.reason as { status?: unknown } | undefined)?.status === 409, true)
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunPhase: true, genReview: true } })
  check('direct 失败 resume 没有释放赢家在第二张卡的锁', [after.genRunPhase, after.genReview !== null], ['waiting', true])
  await cancelSuspendedRun(trip.id, user.id)
}

async function testPreparedClaimConcurrentResume(): Promise<void> {
  console.log('\n--- P0：同一个 prepared claim 并发 resume 只有一个执行者 ---')
  const user = await makeUser('prepared-claim')
  const trip = await makeTrip(user.id, 2, 'prepared-claim')
  const gate = { entered: deferred(), release: deferred() }
  const { runtime } = makeRuntime({ tag: 'prepared-claim', gate, gateCall: 2 })
  const runId = await markOwnedGenerating(trip.id, user.id)
  await runtime.generateTripWithGraph(trip.id, { mode: 'review', runId })
  const pending = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
  const claim = await runtime.prepareTripReview(trip.id, {
    runId,
    reviewId: pending.genReviewId!,
    answer: { decision: 'approve' },
  })
  const resumes = [
    runtime.resumeTripReview(trip.id, { claim }),
    runtime.resumeTripReview(trip.id, { claim }),
  ]
  await gate.entered.promise
  const owner = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genRunPhase: true } })
  check('同一 prepared claim 的赢家阻塞时仍持有运行锁', [owner.genRunId, owner.genRunPhase], [runId, 'running'])
  gate.release.resolve()
  const results = await Promise.allSettled(resumes)
  check('同一 prepared claim 并发 resume 一胜一负', [
    results.filter(result => result.status === 'fulfilled').length,
    results.filter(result => result.status === 'rejected').length,
  ], [1, 1])
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  check('prepared claim 败者是明确裁决冲突', rejected?.reason instanceof ReviewConflictError || (rejected?.reason as { status?: unknown } | undefined)?.status === 409, true)
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genRunPhase: true, genReview: true } })
  check('prepared claim 败者没有释放赢家后续卡锁', [after.genRunId, after.genRunPhase, after.genReview !== null], [runId, 'waiting', true])
  await cancelSuspendedRun(trip.id, user.id)
}

async function testInvalidReviewKinds(): Promise<void> {
  console.log('\n--- P0：非法裁决 kind 返回 400 且不推进状态 ---')
  const user = await makeUser('invalid')
  const trip = await makeTrip(user.id, 1, 'invalid')
  const { runtime } = makeRuntime({ tag: 'invalid' })
  const http = await serve(runtime, user.token)
  try {
    await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'review' }) })
    await waitFor('非法 confirm review', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReview: true } }))?.genReview !== null)
    const before = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genReviewId: true, genRunPhase: true, genDayIndex: true } })
    const wrongChoose = await http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'choose', choice: 'A', reviewId: before.genReviewId }) })
    check('confirm 任务收到 choose 返回 400', wrongChoose.status, 400)
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genReviewId: true, genRunPhase: true, genDayIndex: true } })
    check('非法 choose 不改变 review/phase/day', after, before)
    const cancel = await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
    check('非法裁决后仍可取消 pending', cancel.status, 200)
  } finally {
    await closeServer(http.server)
  }
}

async function testMarkGeneratingFailureReleasesClaim(): Promise<void> {
  console.log('\n--- P0：状态推进异常不能留下半领取锁 ---')
  const user = await makeUser('mark-failure')
  const trip = await makeTrip(user.id, 1, 'mark-failure')
  const { runtime } = makeRuntime({ tag: 'mark-failure' })
  const trigger = `lifecycle_fail_status_${randomUUID().replaceAll('-', '')}`
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE OF status ON "Trip" WHEN NEW.id = '${trip.id}' BEGIN SELECT RAISE(ABORT, 'forced status transition failure'); END`)
  const http = await serve(runtime, user.token)
  try {
    const response = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({}) })
    check('状态推进异常返回服务器错误', response.status, 500)
    const row = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genActiveUserId: true, genRunPhase: true, status: true } })
    check('状态推进异常后不留下半领取锁', [row.genRunId, row.genActiveUserId, row.genRunPhase, row.status], [null, null, null, 'draft'])
  } finally {
    await closeServer(http.server)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`)
  }
}

async function testStaleAIsolatedFromB(): Promise<void> {
  console.log('\n--- P0：旧 A 失锁后迟到模型/进度/决策不能覆盖 B ---')
  const user = await makeUser('stale')
  const trip = await makeTrip(user.id, 1, 'stale')
  const aGate = { entered: deferred(), release: deferred() }
  const a = makeRuntime({ tag: 'old-a', gate: aGate })
  const b = makeRuntime({ tag: 'new-b' })
  const aRun = await markOwnedGenerating(trip.id, user.id)
  const aPromise = a.runtime.generateTripWithGraph(trip.id, { mode: 'continue', runId: aRun }).catch((error: unknown) => error)
  await aGate.entered.promise
  await releaseRun(trip.id, aRun)
  const bRun = await markOwnedGenerating(trip.id, user.id)
  const bResult = await b.runtime.generateTripWithGraph(trip.id, { mode: 'continue', runId: bRun }).catch((error: unknown) => error)
  check('B 实际生成完成且未抛错', bResult instanceof Error, false)
  aGate.release.resolve()
  const aResult = await aPromise
  check('失锁 A 迟到结果被 RunLostError 拒绝', aResult instanceof Error && aResult.message.includes('失去运行权'), true)
  const row = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genProgress: true, genReview: true, genDecisions: true } })
  const day = await prisma.tripDay.findUniqueOrThrow({ where: { tripId_dayIndex: { tripId: trip.id, dayIndex: 1 } }, include: { items: true } })
  check('B 的 ready 状态仍在', row.status, 'ready')
  check('A 不再持有或清除 B 的锁', row.genRunId, null)
  check('A 不能清空 B 的终态进度/裁决', [row.genProgress, row.genReview], [null, null])
  check('只保留 B 的条目', day.items[0]?.name.startsWith('new-b'), true)
  const decisions = JSON.parse(row.genDecisions ?? '[]') as string[]
  check('迟到 A 未写入决策', decisions.every((value) => !value.includes('old-a')), true)
}

async function testCheckpointReopen(): Promise<void> {
  console.log('\n--- P1：close/new runtime 重新打开 SQLite checkpoint 后可恢复裁决 ---')
  const user = await makeUser('restart')
  const trip = await makeTrip(user.id, 1, 'restart')
  const checkpointPath = path.join(process.env.TRAVEL_TEST_DIR ?? process.cwd(), `restart-${randomUUID()}.sqlite`)
  const first = makeRuntime({ tag: 'restart-a', checkpointPath })
  const runId = await markOwnedGenerating(trip.id, user.id)
  const firstRun = first.runtime.generateTripWithGraph(trip.id, { mode: 'review', runId }).catch((error: unknown) => error)
  await waitFor('重启前 waiting checkpoint', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunPhase: true, genReviewId: true } }))?.genRunPhase === 'waiting')
  const waiting = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genReviewId: true, genReview: true } })
  check('重启前已持久化 review 与 runId', waiting.genRunId === runId && waiting.genReviewId !== null && waiting.genReview !== null, true)
  first.runtime.close()
  await firstRun
  const second = makeRuntime({ tag: 'restart-b', checkpointPath })
  const claim = await second.runtime.prepareTripReview(trip.id, {
    runId,
    reviewId: waiting.genReviewId!,
    answer: { decision: 'approve' },
  })
  await second.runtime.resumeTripReview(trip.id, { claim })
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genReview: true } })
  check('新 runtime 从旧 checkpoint 恢复并完成', [after.status, after.genRunId, after.genReview], ['ready', null, null])
  check('重启恢复只落库一天', await prisma.tripDay.count({ where: { tripId: trip.id } }), 1)
}

async function testCheckpointReopenInChildProcess(): Promise<void> {
  console.log('\n--- P1：独立子进程关闭/重启真实 SQLite checkpoint 后恢复 review ---')
  const user = await makeUser('restart-child')
  const trip = await makeTrip(user.id, 1, 'restart-child')
  const checkpointPath = path.join(process.env.TRAVEL_TEST_DIR ?? process.cwd(), `restart-child-${randomUUID()}.sqlite`)
  const first = makeRuntime({ tag: 'restart-child-a', checkpointPath })
  const runId = await markOwnedGenerating(trip.id, user.id)
  const firstRun = first.runtime.generateTripWithGraph(trip.id, { mode: 'review', runId }).catch((error: unknown) => error)
  await waitFor('子进程重启前 waiting checkpoint', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunPhase: true, genReviewId: true } }))?.genRunPhase === 'waiting')
  const waiting = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genReviewId: true, genReview: true } })
  await firstRun
  first.runtime.close()
  const child = await spawnRestartChild({ tripId: trip.id, runId, reviewId: waiting.genReviewId!, checkpointPath })
  if (child.code !== 0) console.log(`  child stdout: ${child.stdout.trim()}\n  child stderr: ${child.stderr.trim()}`)
  check('独立子进程真实恢复退出码为 0', [child.code, child.signal], [0, null])
  if (child.code === 0) {
    await waitFor('独立子进程恢复完成', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true } }))?.status === 'ready')
  }
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genReview: true } })
  check('独立子进程恢复后终态释放锁/清 review', [after.status, after.genRunId, after.genReview], ['ready', null, null])
  check('独立子进程恢复只落库一天', await prisma.tripDay.count({ where: { tripId: trip.id } }), 1)
}

async function testStaleGeneratingTakeover(): Promise<void> {
  console.log('\n--- P1：过期 generating 任务从真实 HTTP 入口接管并完成 ---')
  const user = await makeUser('stale-generating')
  const trip = await makeTrip(user.id, 1, 'stale-generating')
  const oldRun = randomUUID()
  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'generating',
      genRunId: oldRun,
      genActiveUserId: user.id,
      genRunPhase: 'running',
      genHeartbeatAt: new Date(Date.now() - HEARTBEAT_TTL_MS * 2),
      genProgress: '旧进程已崩溃',
    },
  })
  const { runtime, calls } = makeRuntime({ tag: 'takeover' })
  const http = await serve(runtime, user.token)
  try {
    const response = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('过期 generating 真实 POST 返回 202', response.status, 202)
    await waitFor('接管任务完成', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))?.status === 'ready')
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, status: true } })
    check('接管完成后释放新锁', [after.status, after.genRunId], ['ready', null])
    check('接管只启动一次实际模型', calls(), 1)
  } finally {
    await closeServer(http.server)
  }
}

async function testCompleteTripContinueDoesNotRegenerate(): Promise<void> {
  console.log('\n--- P1：全部日期已落库且未解析住宿时真实 HTTP continue 不生成第 N+1 天 ---')
  const user = await makeUser('complete')
  const trip = await makeTrip(user.id, 2, 'complete', {
    stayResolved: false,
    stayPoiId: null,
    stayName: null,
    stayLng: null,
    stayLat: null,
  })
  await seedDay(trip.id, 1, '原第1天', { checked: true })
  await seedDay(trip.id, 2, '原第2天')
  await prisma.trip.update({ where: { id: trip.id }, data: { status: 'partial', genDayIndex: 2, genProgress: '旧进度' } })
  const { runtime, calls } = makeRuntime({ tag: 'complete' })
  const http = await serve(runtime, user.token)
  try {
    const response = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('完整行程 continue 返回 202', response.status, 202)
    await waitFor('完整行程 finalize', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true } }))?.status === 'ready')
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: { orderBy: { dayIndex: 'asc' }, include: { items: true } } } })
    check('完整行程没有第 N+1 天', after.tripDays.map((day) => day.dayIndex), [1, 2])
    check('完整行程原内容保持不变', after.tripDays.map((day) => day.summary), ['原第1天', '原第2天'])
    check('完整行程 ready 且锁释放', [after.status, after.genRunId], ['ready', null])
    check('完整行程不调用模型', calls(), 0)
    check('完整行程 continue 不解析住宿也不调用模型', after.stayResolved, false)
    check('已有打卡记录保留', after.tripDays[0]?.items[0]?.checkedAt !== null, true)
  } finally {
    await closeServer(http.server)
  }
}

async function testGapAndCheckinPreservation(): Promise<void> {
  console.log('\n--- P1：1/3/4/5 已有且含打卡时只补第2天并传导前一天状态 ---')
  const user = await makeUser('gap')
  const trip = await makeTrip(user.id, 5, 'gap')
  await seedDay(trip.id, 1, '已确认第1天', { dayType: 'night_hike', intensity: 'heavy', checked: true, poiId: 'OLD-1' })
  await seedDay(trip.id, 3, '已确认第3天', { checked: true, poiId: 'OLD-3' })
  await seedDay(trip.id, 4, '已确认第4天', { poiId: 'OLD-4' })
  await seedDay(trip.id, 5, '已确认第5天', { poiId: 'OLD-5' })
  const { runtime, calls, prompts } = makeRuntime({ tag: 'gap' })
  const runId = await markOwnedGenerating(trip.id, user.id)
  await runtime.generateTripWithGraph(trip.id, { mode: 'continue', runId })
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: { orderBy: { dayIndex: 'asc' }, include: { items: true } } } })
  check('缺日补齐后仍只有 5 天', after.tripDays.length, 5)
  check('只补第2天且后续原样保留', after.tripDays.map((day) => day.summary), ['已确认第1天', 'gap 第2天方案1', '已确认第3天', '已确认第4天', '已确认第5天'])
  check('第2天模型收到前一天重体力状态', prompts[0]?.includes('前一天安排了夜爬看日出') || prompts[0]?.includes('前一天体力消耗较大'), true)
  check('缺日补齐只调用一次模型', calls(), 1)
  check('第1天打卡保留', after.tripDays[0]?.items[0]?.checkedAt !== null, true)
  check('第3天打卡保留', after.tripDays[2]?.items[0]?.checkedAt !== null, true)
}

async function testGapSkipPropagatesLaterDayState(): Promise<void> {
  console.log('\n--- P1：跨天 skip 后下一缺日使用被跳过日期的状态 ---')
  const user = await makeUser('gap-skip-state')
  const trip = await makeTrip(user.id, 5, 'gap-skip-state')
  await seedDay(trip.id, 1, '已确认第1天', { dayType: 'normal', intensity: 'light', poiId: 'SKIP-1' })
  await seedDay(trip.id, 3, '已确认第3天夜爬', { dayType: 'night_hike', intensity: 'heavy', checked: true, poiId: 'SKIP-3' })
  await seedDay(trip.id, 5, '已确认第5天', { poiId: 'SKIP-5' })
  const { runtime, calls, prompts } = makeRuntime({ tag: 'gap-skip-state' })
  const runId = await markOwnedGenerating(trip.id, user.id)
  await runtime.generateTripWithGraph(trip.id, { mode: 'continue', runId })
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: { orderBy: { dayIndex: 'asc' } } } })
  check('两处缺日补齐后为完整五天', after.tripDays.map((day) => day.dayIndex), [1, 2, 3, 4, 5])
  check('第4天模型收到被 skip 的第3天夜爬状态', prompts[1]?.includes('前一天安排了夜爬看日出'), true)
  check('两处缺日只调用两次模型', calls(), 2)
  check('被 skip 日期的打卡保留', (await prisma.tripItem.findFirst({ where: { tripDay: { tripId: trip.id, dayIndex: 3 } } }))?.checkedAt !== null, true)
}

async function testReplanCopyAndRestartSafety(): Promise<void> {
  console.log('\n--- P1：replan-copy 新草稿与 restart 均保护原行程/打卡 ---')
  const user = await makeUser('replan-copy')
  const source = await makeTrip(user.id, 1, '原行程')
  await seedDay(source.id, 1, '原行程第1天', { checked: true, poiId: 'REPLAN-OLD' })
  const before = await prisma.trip.findUniqueOrThrow({ where: { id: source.id }, include: { tripDays: { include: { items: true } } } })
  const { runtime } = makeRuntime({ tag: 'replan-copy' })
  const http = await serve(runtime, user.token)
  try {
    const copiedResponse = await http.request(`/api/trips/${source.id}/replan-copy`, { method: 'POST', body: '{}' })
    check('replan-copy 返回 201', copiedResponse.status, 201)
    const copiedBody = await copiedResponse.json() as { trip?: { id?: string; status?: string; title?: string } }
    const copiedId = copiedBody.trip?.id
    check('replan-copy 创建独立 draft', typeof copiedId === 'string' && copiedId !== source.id && copiedBody.trip?.status === 'draft', true)
    check('replan-copy 标题明确为重新规划', copiedBody.trip?.title?.includes('重新规划'), true)
    const restart = await http.request(`/api/trips/${source.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'restart' }) })
    check('已有日期的 restart 返回 409', restart.status, 409)
    const untouched = await prisma.trip.findUniqueOrThrow({ where: { id: source.id }, include: { tripDays: { include: { items: true } } } })
    check('restart 被拒绝后原日期和打卡完全保留', [untouched.tripDays[0]?.summary, untouched.tripDays[0]?.items[0]?.checkedAt !== null], [before.tripDays[0]?.summary, true])
    if (copiedId) {
      const copiedGenerate = await http.request(`/api/trips/${copiedId}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
      check('副本可以独立进入生成', copiedGenerate.status, 202)
      await waitFor('副本生成完成', async () => (await prisma.trip.findUnique({ where: { id: copiedId }, select: { status: true } }))?.status === 'ready')
      const sourceAfter = await prisma.trip.findUniqueOrThrow({ where: { id: source.id }, include: { tripDays: { include: { items: true } } } })
      check('副本生成不修改原行程', [sourceAfter.tripDays.length, sourceAfter.tripDays[0]?.summary, sourceAfter.tripDays[0]?.items[0]?.checkedAt !== null], [1, before.tripDays[0]?.summary, true])
    }
  } finally {
    await closeServer(http.server)
  }
}

async function testAllFailuresPartialThenFillClearsMissingWarning(): Promise<void> {
  console.log('\n--- P1：模型全失败→partial，补缺后清除旧 missing warning ---')
  const user = await makeUser('partial-retry')
  const trip = await makeTrip(user.id, 2, 'partial-retry')
  let failing = true
  const { runtime, calls } = makeRuntime({
    tag: 'partial-retry',
    throwOnCall: () => failing ? new Error('mock model unavailable') : undefined,
  })
  const http = await serve(runtime, user.token)
  try {
    const first = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('全失败首轮返回 202', first.status, 202)
    await waitFor('全失败进入 partial', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true } }))?.status === 'partial')
    const partial = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genWarnings: true, genError: true } })
    check('全失败终态保存缺失日期提示', partial.genError?.includes('未能生成'), true)
    failing = false
    const retry = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('partial 补缺 HTTP 请求返回 202', retry.status, 202)
    await waitFor('partial 补缺完成', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))?.status === 'ready')
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: true } })
    const warnings = JSON.parse(after.genWarnings ?? '[]') as string[]
    check('partial 补缺后两天均落库', after.tripDays.length, 2)
    check('partial 补缺后旧缺失 warning 不残留', warnings.some((warning) => warning.includes('缺失的天')), false)
    check('全失败再补缺的模型调用次数有明确证据', calls(), 8)
  } finally {
    await closeServer(http.server)
  }
}

async function testWarningsFiveDays(): Promise<void> {
  console.log('\n--- P1：五天 warnings 图状态与数据库保序去重一致 ---')
  const user = await makeUser('warnings')
  const trip = await makeTrip(user.id, 5, 'warnings')
  const { runtime, checkpointPath, calls } = makeRuntime({
    tag: 'warnings',
    warnings: (day) => [`warning-${day}`, 'shared-warning', `warning-${day}`],
  })
  const runId = await markOwnedGenerating(trip.id, user.id)
  await runtime.generateTripWithGraph(trip.id, { mode: 'continue', runId })
  const row = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genWarnings: true } })
  const warnings = JSON.parse(row.genWarnings ?? '[]') as string[]
  const expected = ['warning-1', 'shared-warning', 'warning-2', 'warning-3', 'warning-4', 'warning-5']
  const saver = SqliteSaver.fromConnString(checkpointPath)
  const tuple = await saver.getTuple({ configurable: { thread_id: `${trip.id}:${runId}` } })
  const graphWarnings = (tuple?.checkpoint.channel_values as { warnings?: unknown } | undefined)?.warnings
  saver.db.close()
  check('五天全部完成', row.status, 'ready')
  check('warnings 保留首次出现顺序并去重', warnings, expected)
  check('warnings 数量不膨胀', new Set(warnings).size, warnings.length)
  check('warnings 图状态真实 checkpoint 保留 6 条', graphWarnings, expected)
  check('warnings 图/DB 结果一致', JSON.stringify(graphWarnings), JSON.stringify(warnings))
  check('五天模型调用次数明确为 5', calls(), 5)
}

async function testCommitFailureDoesNotReinvokeBeforeRetry(): Promise<void> {
  console.log('\n--- P1：多天第2天提交失败保留 journal/config/warnings，HTTP 重试不重调模型 ---')
  const user = await makeUser('commit-failure')
  const trip = await makeTrip(user.id, 2, 'commit-failure')
  const first = makeRuntime({
    tag: 'commit-failure',
    warnings: (day) => [`warning-${day}`, 'shared-warning', `warning-${day}`],
  })
  const trigger = `lifecycle_fail_day_${randomUUID().replaceAll('-', '')}`
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE OF genDayIndex ON "Trip" WHEN NEW.id = '${trip.id}' AND NEW.genDayIndex = 2 BEGIN SELECT RAISE(ABORT, 'forced day 2 commit failure'); END`)
  let triggerActive = true
  const http = await serve(first.runtime, user.token)
  try {
    // Keep the trigger installed until the asynchronous production task has
    // reached failed and released its run. Dropping it earlier would race the
    // real HTTP background dispatch and could turn this into a false pass.
    const start = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('提交故障首个 HTTP 请求返回 202', start.status, 202)
    await waitFor('HTTP 后台提交失败并保留 pending journal', async () => {
      const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true, genRunPhase: true, genReview: true } })
      return row?.status === 'failed' && row.genRunId === null && row.genRunPhase === 'commit_pending' && row.genReview !== null
    })
    const failed = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: {
      status: true,
      genProgress: true,
      genRunId: true,
      genActiveUserId: true,
      genRunPhase: true,
      genReview: true,
      genReviewId: true,
      genRunConfig: true,
      genWarnings: true,
    } })
    const pending = JSON.parse(failed.genReview ?? '{}') as Record<string, unknown>
    const config = JSON.parse(failed.genRunConfig ?? '{}') as Record<string, unknown>
    check('第2天提交失败后第1天已落库', await prisma.tripDay.findMany({ where: { tripId: trip.id }, orderBy: { dayIndex: 'asc' }, select: { dayIndex: true, summary: true } }), [{ dayIndex: 1, summary: 'commit-failure 第1天方案1' }])
    check('第2天失败没有错误进度覆盖', [failed.status, failed.genProgress], ['failed', null])
    check('pending journal 锁已释放且 phase 正确', [failed.genRunId, failed.genActiveUserId, failed.genRunPhase, failed.genReviewId !== null], [null, null, 'commit_pending', true])
    check('pending journal 保存已生成的第2天候选', [pending.kind, pending.dayIndex, (pending.day as { summary?: unknown } | undefined)?.summary], ['commit_pending', 2, 'commit-failure 第2天方案2'])
    check('pending journal 保存跨天 warnings', pending.warnings, ['warning-1', 'shared-warning', 'warning-2'])
    check('genRunConfig 保存同一 pendingCommit 与原模式', [config.reviewMode, config.parallelCandidates, JSON.stringify(config.pendingCommit)], [false, 1, JSON.stringify(pending)])
    check('第2天提交失败时 DB warnings 保留第1天', JSON.parse(failed.genWarnings ?? '[]'), ['warning-1', 'shared-warning'])
    check('提交失败首轮模型调用为两天各一次', first.calls(), 2)

    // Keep the trigger for a second real HTTP retry.  This catches the
    // implementation that only restores status/genRunId while dropping the
    // journal or changing the original candidate/configuration.
    const retryWhileFailing = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue', parallel: true }) })
    check('重复提交故障的 HTTP 重试返回 202', retryWhileFailing.status, 202)
    await waitFor('重复提交故障再次保留 journal', async () => {
      const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true, genRunPhase: true, genReview: true } })
      return row?.status === 'failed' && row.genRunId === null && row.genRunPhase === 'commit_pending' && row.genReview !== null
    })
    const failedAgain = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genRunConfig: true, genWarnings: true } })
    check('重复提交故障不重调第2天模型', first.calls(), 2)
    check('重复提交故障保留同一 journal/config/warnings', [failedAgain.genReview, failedAgain.genRunConfig, failedAgain.genWarnings], [failed.genReview, failed.genRunConfig, failed.genWarnings])

    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`)
    triggerActive = false
    const retry = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue', parallel: true }) })
    check('解除故障后的 HTTP 重试返回 202', retry.status, 202)
    await waitFor('HTTP 重试完成并清理 pending journal', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true } }))?.status === 'ready')
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: { orderBy: { dayIndex: 'asc' } } } })
    const finalConfig = JSON.parse(after.genRunConfig ?? '{}') as Record<string, unknown>
    check('跨 HTTP 重试不重复调用模型', first.calls(), 2)
    check('HTTP 重试最终按原候选补齐两天', after.tripDays.map(day => [day.dayIndex, day.summary]), [[1, 'commit-failure 第1天方案1'], [2, 'commit-failure 第2天方案2']])
    check('成功提交后清理 pending journal/review', [after.genReview, finalConfig.pendingCommit], [null, undefined])
    check('成功提交后 warnings 保留原顺序去重结果', JSON.parse(after.genWarnings ?? '[]'), ['warning-1', 'shared-warning', 'warning-2'])
  } finally {
    if (triggerActive) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`)
    await closeServer(http.server)
  }
}

async function testInteractiveCommitFailureJournalsChosenCandidate(): Promise<void> {
  console.log('\n--- P1：approve 提交失败保存具体候选，HTTP 重试不换方案/不重调模型 ---')
  const user = await makeUser('interactive-commit-failure')
  const trip = await makeTrip(user.id, 1, 'interactive-commit-failure')
  const first = makeRuntime({
    tag: 'interactive-commit-failure',
    warnings: () => ['interactive-warning'],
  })
  const trigger = `lifecycle_fail_interactive_day_${randomUUID().replaceAll('-', '')}`
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE OF genDayIndex ON "Trip" WHEN NEW.id = '${trip.id}' AND NEW.genDayIndex = 1 BEGIN SELECT RAISE(ABORT, 'forced interactive day commit failure'); END`)
  let triggerActive = true
  const http = await serve(first.runtime, user.token)
  try {
    const start = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'review' }) })
    check('approve 提交故障前的 review 返回 202', start.status, 202)
    await waitFor('interactive commit 初始 review', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunPhase: true, genReview: true } }))?.genRunPhase === 'waiting')
    const waiting = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genRunId: true, genReviewId: true, genReview: true, genRunConfig: true } })
    const checkpoint = SqliteSaver.fromConnString(first.checkpointPath)
    const beforeTuple = await checkpoint.getTuple({ configurable: { thread_id: `${trip.id}:${waiting.genRunId}` } })
    const pendingDay = (beforeTuple?.checkpoint.channel_values as { pendingDay?: { day?: { summary?: string } } } | undefined)?.pendingDay?.day
    checkpoint.db.close()
    check('review checkpoint 保存了待确认的具体候选', typeof pendingDay?.summary === 'string' && pendingDay.summary.length > 0, true)

    const approved = await http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reviewId: waiting.genReviewId }) })
    check('approve 提交故障请求返回 202', approved.status, 202)
    await waitFor('interactive commit 故障进入 failed', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))?.status === 'failed')
    const failed = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: {
      status: true,
      genRunId: true,
      genActiveUserId: true,
      genRunPhase: true,
      genReview: true,
      genReviewId: true,
      genRunConfig: true,
      genWarnings: true,
    } })
    const pending = JSON.parse(failed.genReview ?? '{}') as Record<string, unknown>
    const config = JSON.parse(failed.genRunConfig ?? '{}') as Record<string, unknown>
    const pendingDayPayload = pending.day as { summary?: unknown } | undefined
    check('approve 提交失败已释放锁并保持 commit_pending', [failed.status, failed.genRunId, failed.genActiveUserId, failed.genRunPhase, failed.genReviewId !== null], ['failed', null, null, 'commit_pending', true])
    check('approve 提交 journal 保留用户确认的具体候选', [pending.kind, pending.dayIndex, pendingDayPayload?.summary], ['commit_pending', 1, pendingDay?.summary])
    check('approve 提交 journal 保留 warnings', pending.warnings, ['interactive-warning'])
    check('approve 提交 journal 与原任务配置一致', [config.reviewMode, config.parallelCandidates, JSON.stringify(config.pendingCommit)], [true, 1, JSON.stringify(pending)])
    check('approve 提交失败未提前落库/未写 warnings', [await prisma.tripDay.count({ where: { tripId: trip.id } }), failed.genWarnings], [0, null])
    check('approve 提交故障只调用一次模型', first.calls(), 1)

    const retryWhileFailing = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue', parallel: true }) })
    check('approve 提交故障重复 HTTP 重试返回 202', retryWhileFailing.status, 202)
    await waitFor('approve 提交故障再次失败', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true, genRunId: true } }))?.status === 'failed')
    const failedAgain = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReview: true, genRunConfig: true, genWarnings: true } })
    check('approve 提交故障重试不重调模型', first.calls(), 1)
    check('approve 提交故障重试不换候选/配置/journal', [failedAgain.genReview, failedAgain.genRunConfig, failedAgain.genWarnings], [failed.genReview, failed.genRunConfig, failed.genWarnings])

    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`)
    triggerActive = false
    const retry = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue', parallel: true }) })
    check('解除 approve 提交故障后的 HTTP 重试返回 202', retry.status, 202)
    await waitFor('approve journal 重试最终完成', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))?.status === 'ready')
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: true } })
    const finalConfig = JSON.parse(after.genRunConfig ?? '{}') as Record<string, unknown>
    check('approve journal 重试不重调模型且只落库一日', [first.calls(), after.tripDays.length], [1, 1])
    check('approve journal 重试落库原确认候选', after.tripDays[0]?.summary, pendingDay?.summary)
    check('approve journal 成功提交后清理 pending', [after.genReview, finalConfig.pendingCommit], [null, undefined])
  } finally {
    if (triggerActive) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`)
    await closeServer(http.server)
  }
}

async function testMalformedCommitPendingIsRecoveryOnly(): Promise<void> {
  console.log('\n--- P0：kind 正确但缺 day 的 commit_pending journal 只能 recovery/cancel，不得自动模型 ---')
  const user = await makeUser('malformed-commit-pending')
  const trip = await makeTrip(user.id, 2, 'malformed-commit-pending')
  await seedDay(trip.id, 1, '已保存第1天', { checked: true, poiId: 'MALFORMED-OLD-1' })
  const malformed = {
    kind: 'commit_pending',
    dayIndex: 2,
    totalDays: 2,
    warnings: ['已有警告'],
    // deliberately missing `day`: the discriminator alone is not safe to resume
  }
  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'failed',
      genRunId: null,
      genActiveUserId: null,
      genRunPhase: 'commit_pending',
      genReviewId: randomUUID(),
      genReview: JSON.stringify(malformed),
      genRunConfig: JSON.stringify({ reviewMode: false, parallelCandidates: 1, pendingCommit: malformed }),
      genWarnings: JSON.stringify(['已有警告']),
    },
  })
  const { runtime, calls } = makeRuntime({ tag: 'malformed-commit-pending' })
  const http = await serve(runtime, user.token)
  try {
    const response = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'continue' }) })
    check('损坏 commit_pending journal 的 HTTP 生成返回 409', response.status, 409)
    if (response.status === 202) {
      await waitFor('损坏 journal 误启动任务收尾', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunId: true } }))?.genRunId === null)
    }
    const recovered = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genActiveUserId: true, genRunPhase: true, genReview: true, genWarnings: true } })
    check('损坏 commit_pending journal 转 recovery 且无锁', [recovered.status, recovered.genRunId, recovered.genActiveUserId, recovered.genRunPhase], ['failed', null, null, 'recovery'])
    check('损坏 journal 不触发模型且原 warnings 保留', [calls(), recovered.genWarnings], [0, JSON.stringify(['已有警告'])])
    const cancelled = await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
    check('损坏 journal recovery 可取消', cancelled.status, 200)
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripDays: { include: { items: true } } } })
    check('取消损坏 journal 保留已有日期/打卡', [after.status, after.tripDays.map(day => day.summary), after.tripDays[0]?.items[0]?.checkedAt !== null], ['partial', ['已保存第1天'], true])
  } finally {
    await closeServer(http.server)
  }
}

async function testReviewIdRequiredAndStaleIdRejected(): Promise<void> {
  console.log('\n--- P1：reviewId 必填且旧卡 id 不能裁决新卡 ---')
  const user = await makeUser('review-id')
  const trip = await makeTrip(user.id, 2, 'review-id')
  const { runtime } = makeRuntime({ tag: 'review-id' })
  const http = await serve(runtime, user.token)
  try {
    await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({ mode: 'review' }) })
    await waitFor('reviewId 第一张卡', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReviewId: true } }))?.genReviewId !== null)
    const first = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
    const approved = await http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reviewId: first.genReviewId }) })
    check('第一张卡合法裁决返回 202', approved.status, 202)
    await waitFor('reviewId 第二张卡', async () => {
      const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReviewId: true, genRunPhase: true } })
      return row?.genRunPhase === 'waiting' && row.genReviewId !== first.genReviewId
    })
    const second = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true, genReview: true, genRunPhase: true } })
    const missing = await http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
    check('新卡缺 reviewId 返回 400', missing.status, 400)
    const stale = await http.request(`/api/trips/${trip.id}/review-confirm`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reviewId: first.genReviewId }) })
    check('旧卡 reviewId 裁决新卡返回 409', stale.status, 409)
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true, genReview: true, genRunPhase: true } })
    check('旧/缺 id 都不推进新卡', after, second)
    await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
  } finally {
    await closeServer(http.server)
  }
}

async function testRecoveryCanBeCancelled(): Promise<void> {
  console.log('\n--- P1：裁决恢复异常进入 recovery 后可安全取消 ---')
  const user = await makeUser('recovery')
  const trip = await makeTrip(user.id, 1, 'recovery')
  const { runtime } = makeRuntime({ tag: 'recovery' })
  const runId = await markOwnedGenerating(trip.id, user.id)
  const running = runtime.generateTripWithGraph(trip.id, { mode: 'review', runId }).catch(() => undefined)
  await waitFor('recovery 初始 waiting', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genReviewId: true, genRunPhase: true } }))?.genRunPhase === 'waiting')
  const pending = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { genReviewId: true } })
  // Simulate a process/schema failure after the claim but before graph resume.
  await prisma.trip.update({ where: { id: trip.id }, data: { genRunConfig: '{bad-config' } })
  const claim = await runtime.prepareTripReview(trip.id, { runId, reviewId: pending.genReviewId!, answer: { decision: 'approve' } })
  await runtime.resumeTripReview(trip.id, { claim }).catch(() => undefined)
  await running
  await waitFor('恢复失败进入 recovery', async () => (await prisma.trip.findUnique({ where: { id: trip.id }, select: { genRunPhase: true } }))?.genRunPhase === 'recovery')
  const cancelled = await cancelSuspendedRun(trip.id, user.id)
  check('recovery 可安全取消', cancelled, true)
  const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genReview: true, genError: true } })
  check('取消 recovery 保留可补缺终态', [after.status, after.genRunId, after.genReview, after.genError?.includes('安全补缺')], ['partial', null, null, true])
}

async function testCrashedRunningReviewBecomesRecoverable(): Promise<void> {
  console.log('\n--- P1：崩溃残留 running+review 过期后可进入 recovery/cancel ---')
  const user = await makeUser('crashed-review')
  const trip = await makeTrip(user.id, 1, 'crashed-review')
  const staleRun = randomUUID()
  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'generating',
      genRunId: staleRun,
      genActiveUserId: user.id,
      genRunPhase: 'running',
      genHeartbeatAt: new Date(Date.now() - HEARTBEAT_TTL_MS * 2),
      genReviewId: randomUUID(),
      genReview: JSON.stringify({ kind: 'confirm', dayIndex: 1, summary: '崩溃前待确认方案' }),
      genRunConfig: JSON.stringify({ reviewMode: true, parallelCandidates: 1 }),
    },
  })
  const { runtime } = makeRuntime({ tag: 'crashed-review' })
  const http = await serve(runtime, user.token)
  try {
    const ordinary = await http.request(`/api/trips/${trip.id}/generate`, { method: 'POST', body: JSON.stringify({}) })
    check('残留待确认任务不会被普通生成接管', ordinary.status, 409)
    const cancel = await http.request(`/api/trips/${trip.id}/cancel-generation`, { method: 'POST', body: '{}' })
    check('过期 running+review 可恢复后安全取消', cancel.status, 200)
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { status: true, genRunId: true, genRunPhase: true, genReview: true } })
    check('崩溃残留取消后不僵死', [after.status, after.genRunId, after.genRunPhase, after.genReview], ['partial', null, null, null])
  } finally {
    await closeServer(http.server)
  }
}

async function runRestartChild(): Promise<void> {
  const tripId = process.env.LIFECYCLE_CHILD_TRIP_ID
  const runId = process.env.LIFECYCLE_CHILD_RUN_ID
  const reviewId = process.env.LIFECYCLE_CHILD_REVIEW_ID
  const checkpointPath = process.env.LIFECYCLE_CHILD_CHECKPOINT
  if (!tripId || !runId || !reviewId || !checkpointPath) throw new Error('lifecycle child 缺少重启参数')
  const { runtime } = makeRuntime({ tag: 'restart-child-b', checkpointPath })
  try {
    await runtime.resumeTripReview(tripId, {
      runId,
      reviewId,
      answer: { decision: 'approve' },
    })
  } finally {
    runtime.close()
    await prisma.$disconnect()
  }
}

async function run(): Promise<void> {
  try {
    await testAtomicDifferentTrips()
    await testEightHttpGenerations()
    await testUserCrossTripHttp()
    await testWaitingHeartbeatAndTtl()
    await testConcurrentApproveKeepsLock()
    await testDirectConcurrentResume()
    await testPreparedClaimConcurrentResume()
    await testChooseRace()
    await testInvalidReviewKinds()
    await testMarkGeneratingFailureReleasesClaim()
    await testStaleAIsolatedFromB()
    await testCheckpointReopen()
    await testCheckpointReopenInChildProcess()
    await testStaleGeneratingTakeover()
    await testCompleteTripContinueDoesNotRegenerate()
    await testGapAndCheckinPreservation()
    await testGapSkipPropagatesLaterDayState()
    await testReplanCopyAndRestartSafety()
    await testAllFailuresPartialThenFillClearsMissingWarning()
    await testWarningsFiveDays()
    await testCommitFailureDoesNotReinvokeBeforeRetry()
    await testInteractiveCommitFailureJournalsChosenCandidate()
    await testMalformedCommitPendingIsRecoveryOnly()
    await testReviewIdRequiredAndStaleIdRejected()
    await testRecoveryCanBeCancelled()
    await testCrashedRunningReviewBecomesRecoverable()
  } finally {
    for (const server of servers.splice(0)) {
      try { await closeServer(server) } catch { /* already closed */ }
    }
    for (const runtime of runtimes.splice(0)) {
      try { runtime.close() } catch { /* a test may have closed it */ }
    }
    for (const userId of users.splice(0)) {
      try { await prisma.user.delete({ where: { id: userId } }) } catch { /* cascade cleanup */ }
    }
    await prisma.$disconnect()
  }

  console.log(`\n生命周期真实链路自检：${pass}/${pass + fail} 通过`)
  if (fail > 0) {
    console.log('\n未通过的用例：')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv.includes('--lifecycle-child-restart')) await runRestartChild()
else await run()
