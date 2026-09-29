import { randomUUID } from 'node:crypto'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { Command } from '@langchain/langgraph'
import path from 'node:path'
import fs from 'node:fs'
import { prisma } from '../../db'
import { poiFromStay } from '../../domain/poi-mapper'
import { parseJsonArray } from '../../utils/json'
import { getWeather, type Poi } from '../amap'
import { getCredentialsForUser } from '../llm'
import { type PlannedDay, optimizeCommute } from './scheduler'
import { nightKindOfText, parseDayTypeBan } from './spot-rules'
import { buildAgentGraph, DayCommitError, estimateTransitTotal, type AgentGraphContext, type ReviewAnswer } from './graph'
import { HEARTBEAT_INTERVAL_MS, heartbeatRun, assertRunOwner, updateOwnedTrip, releaseRun, RunLostError } from './run-lock'
import { parsePendingCommitJournal } from './pending-commit'

export class GraphGenerateError extends Error {}
export class ReviewConflictError extends Error { readonly status = 409 }
export class ReviewInputError extends Error { readonly status = 400 }
export interface ReviewClaim { runId: string; reviewId: string; answer: ReviewAnswer }
interface GenerateOptions { mode?: 'continue' | 'restart' | 'review'; parallelCandidates?: number; runId?: string | null }
interface ResumeOptions { answer?: ReviewAnswer; runId?: string | null; reviewId?: string; parallelCandidates?: number; claim?: ReviewClaim }
interface RuntimeDependencies {
  getCredentials?: typeof getCredentialsForUser
  getWeather?: typeof getWeather
  chatClient?: AgentGraphContext['chatClient']
  toolRunner?: AgentGraphContext['toolRunner']
  optimizeCommute?: typeof optimizeCommute
  estimateTransitTotal?: typeof estimateTransitTotal
  checkpointPath?: string
}

interface PendingCommit {
  kind: 'commit_pending'
  dayIndex: number
  totalDays: number
  day: PlannedDay
  warnings: string[]
}

// 工厂仅封装外部服务依赖；路由、锁、生产图、事务、SQLite checkpoint 都使用真实实现。
export function createGraphRuntime(deps: RuntimeDependencies = {}) {
  let saver: SqliteSaver | null = null
  const checkpointPath = deps.checkpointPath ?? path.resolve(process.env.TRAVEL_TEST_DIR ?? path.resolve(import.meta.dirname, '../../../.debug'), 'langgraph-checkpoints.sqlite')
  function checkpointer() {
    if (!saver) { fs.mkdirSync(path.dirname(checkpointPath), { recursive: true }); saver = SqliteSaver.fromConnString(checkpointPath) }
    return saver
  }
  const config = (tripId: string, runId: string) => ({ configurable: { thread_id: `${tripId}:${runId}` }, recursionLimit: 200 })
  const timer = (tripId: string, runId: string) => {
    const handle = setInterval(() => { void heartbeatRun(tripId, runId).catch(error => console.error('[heartbeat]', error)) }, HEARTBEAT_INTERVAL_MS)
    handle.unref()
    return handle
  }
  async function context(tripId: string, runId: string, reviewMode: boolean, parallelCandidates: number) {
    await assertRunOwner(tripId, runId)
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })
    const credentials = await (deps.getCredentials ?? getCredentialsForUser)(trip.userId)
    if (!credentials) throw new GraphGenerateError('还没有配置模型 API Key，请先填写个人设置')
    const registry = new Map<string, Poi>()
    const anchor = poiFromStay(trip)
    if (anchor) registry.set(anchor.poiId, anchor)
    const report: AgentGraphContext['report'] = text => {
      // 所有迟到进度只能写仍然running的原任务；不得覆盖等待卡片或终态。
      void prisma.trip.updateMany({ where: { id: tripId, genRunId: runId, genRunPhase: 'running', status: 'generating' }, data: { genProgress: text } }).catch(() => undefined)
    }
    let decisions = Promise.resolve()
    const recordDecision = (text: string) => {
      decisions = decisions.then(async () => {
        await prisma.$transaction(async tx => {
          await updateOwnedTrip(tripId, runId, { genHeartbeatAt: new Date() }, tx)
          const row = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: { genDecisions: true } })
          await updateOwnedTrip(tripId, runId, { genDecisions: JSON.stringify([...parseJsonArray(row.genDecisions ?? '[]'), text].slice(-50)) }, tx)
        })
      }).catch(error => { if (!(error instanceof RunLostError)) console.error('[decision]', error) })
    }
    const assertOwner = () => assertRunOwner(tripId, runId)
    const weatherByDate: AgentGraphContext['weatherByDate'] = new Map()
    await assertOwner()
    try { const weather = await (deps.getWeather ?? getWeather)(trip.cityAdcode); for (const cast of weather?.casts ?? []) weatherByDate.set(cast.date, cast) } catch { /* 天气缺失不阻止生成 */ }
    await assertOwner()
    const ctx: AgentGraphContext = {
      tripId, runId, credentials, registry, anchor, weatherByDate, report,
      toolContext: { cityName: trip.cityName, cityAdcode: trip.cityAdcode, registry, report },
      basics: { cityName: trip.cityName, cityAdcode: trip.cityAdcode, startDate: trip.startDate.toISOString().slice(0, 10), days: trip.days, travelers: trip.travelers,
        preferences: parseJsonArray(trip.preferences), extraNeeds: parseJsonArray(trip.extraNeeds), budgetAmount: trip.budgetAmount, budgetScope: trip.budgetScope === 'total' ? 'total' : 'per_person' },
      ban: parseDayTypeBan(parseJsonArray(trip.extraNeeds)), reviewMode, parallelCandidates, maxToolRounds: 14,
      log: line => console.log(`[生成·图 ${tripId}] ${line}`), recordDecision, assertOwner,
      chatClient: deps.chatClient, toolRunner: deps.toolRunner, optimizeCommute: deps.optimizeCommute, estimateTransitTotal: deps.estimateTransitTotal,
      persistDay: (day, date, weather, progress) => persistDay(tripId, runId, day, date, weather, progress),
      persistPendingDay: (day, warnings, totalDays) => persistPendingDay(tripId, runId, day, warnings, totalDays),
    }
    return { trip, ctx, flush: () => decisions }
  }
  async function suspend(tripId: string, runId: string, interrupt: unknown) {
    const value = (interrupt as { value?: Record<string, unknown> }).value
    if (!value) throw new Error('checkpoint 未提供有效裁决内容')
    await updateOwnedTrip(tripId, runId, { genRunPhase: 'waiting', genReviewId: randomUUID(), genReview: JSON.stringify(value),
      genProgress: `待确认：第 ${value.dayIndex} 天${value.kind === 'choose' ? '，请在两个方案中选择' : ''}` })
  }
  async function fail(tripId: string, runId: string, error: unknown, recovering: boolean) {
    if (error instanceof RunLostError) return
    const message = error instanceof Error ? error.message : String(error)
    const current = await prisma.trip.findUnique({ where: { id: tripId }, select: { genRunId: true, genRunPhase: true, genReview: true, genRunConfig: true } })
    if (current?.genRunId !== runId) return
    // Once a model result has reached either journal column, every later
    // error must preserve it.  A missing credential or context lookup cannot
    // turn a safe no-model retry into a fresh model generation.
    const pending = parsePendingCommitJournal(current.genReview, current.genRunConfig)
    if (pending) {
      await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId }, data: {
        status: 'failed', genRunPhase: 'commit_pending',
        genError: `${message}。已保存本次模型结果，请继续生成完成提交，不会再次调用模型`, genProgress: null,
      } })
      return
    }
    if (current.genRunPhase === 'commit_pending' && current.genReview !== null) {
      await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId }, data: {
        status: 'failed', genRunPhase: 'recovery', genError: `${message}。待提交结果损坏，请取消后安全补缺`, genProgress: null,
      } })
      return
    }
    // A journal write can fail before any model result reaches durable
    // storage.  Keep this distinct from the valid pending branch above:
    // callers must not be told that a result can be retried without another
    // model call when there is no payload to replay.
    if (error instanceof DayCommitError) {
      await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId }, data: {
        status: 'failed', genRunPhase: null,
        genError: `${message}。本次模型结果未持久保存，已有日期保留，请人工补缺或重新生成`,
        genProgress: null, genReview: null, genReviewId: null,
      } })
      return
    }
    // resume 失败后 checkpoint 可能已执行部分节点，不假装可以再次自动resume；保留载荷与checkpoint供排查。
    await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId }, data: recovering
      ? { genRunPhase: 'recovery', genError: `确认执行中断：${message}。请取消未确认方案后安全补缺`, genProgress: null }
      : { status: 'failed', genError: message, genProgress: null, genReview: null, genReviewId: null } })
  }
  async function generateTripWithGraph(tripId: string, options: GenerateOptions = {}) {
    const runId = options.runId
    if (!runId) throw new GraphGenerateError('生成必须先领取运行锁')
    const handle = timer(tripId, runId)
    let suspended = false
    let flush = async () => {}
    try {
      const requestedMode = options.mode ?? 'continue'
      const requestedParallel = options.parallelCandidates === 2 ? 2 : 1
      // A commit retry must use the configuration that produced the pending
      // model result.  Callers cannot switch it into restart/review or change
      // candidate fan-out while completing the already-persisted result.
      const before = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, select: { genReview: true, genRunConfig: true } })
      const pendingBefore = parsePendingCommitJournal(before.genReview, before.genRunConfig)
      let savedConfig: { reviewMode?: boolean; parallelCandidates?: number } = {}
      try { savedConfig = JSON.parse(before.genRunConfig ?? '{}') as typeof savedConfig } catch { /* validation below */ }
      const mode = pendingBefore ? (savedConfig.reviewMode ? 'review' : 'continue') : requestedMode
      const parallel = pendingBefore && [1, 2].includes(savedConfig.parallelCandidates ?? 0)
        ? savedConfig.parallelCandidates!
        : requestedParallel
      const runConfig: Record<string, unknown> = { reviewMode: mode === 'review', parallelCandidates: parallel }
      if (pendingBefore) runConfig.pendingCommit = pendingBefore
      await updateOwnedTrip(tripId, runId, { genRunConfig: JSON.stringify(runConfig) })
      const tripSnapshot = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })
      const pendingCommit = parsePendingCommitJournal(tripSnapshot.genReview, tripSnapshot.genRunConfig) ?? pendingBefore
      if (pendingCommit && mode === 'restart') throw new GraphGenerateError('已有待提交的模型结果，请继续生成完成提交或安全取消后再规划')
      let existing = await prisma.tripDay.findMany({ where: { tripId }, orderBy: { dayIndex: 'asc' }, include: { items: true } })
      if (pendingCommit) {
        // The pending day is already the result of a completed model call.  It
        // can be committed with no credentials/weather lookup; only later
        // missing days need to construct a model context.
        const date = new Date(tripSnapshot.startDate)
        date.setDate(date.getDate() + pendingCommit.dayIndex - 1)
        try {
          await persistDay(tripId, runId, pendingCommit.day, date, null, {
            warnings: pendingCommit.warnings,
            totalDays: pendingCommit.totalDays,
          })
        } catch (error) {
          throw new DayCommitError(error instanceof Error ? error.message : String(error))
        }
        existing = await prisma.tripDay.findMany({ where: { tripId }, orderBy: { dayIndex: 'asc' }, include: { items: true } })
      }
      const complete = mode !== 'restart' && Array.from({ length: tripSnapshot.days }, (_, i) => i + 1)
        .every(dayIndex => existing.some(day => day.dayIndex === dayIndex))
      if (complete) {
        await updateOwnedTrip(tripId, runId, {
          status: 'ready', genProgress: null, genError: null, genReview: null, genReviewId: null,
        })
        return
      }
      if (mode === 'restart') {
        await prisma.$transaction(async tx => {
          // A restart must never delete a saved day.  Even an unconfirmed day
          // may contain user edits or a future check-in, and deleting it here
          // makes a later model failure irreversible.  The HTTP route rejects
          // the common case early; this transaction is the race-safe guard for
          // a day created between that preflight and graph startup.
          const savedDays = await tx.tripDay.count({ where: { tripId } })
          if (savedDays > 0) {
            throw new GraphGenerateError('已有保存的行程日期，请使用继续补缺或新建行程后重新规划；原行程未修改')
          }
          await updateOwnedTrip(tripId, runId, { genDayIndex: null, genWarnings: null }, tx)
        })
      }
      const built = await context(tripId, runId, mode === 'review', parallel)
      const { trip, ctx } = built
      flush = built.flush
      existing = await prisma.tripDay.findMany({ where: { tripId }, orderBy: { dayIndex: 'asc' }, include: { items: true } })
      const missing = Array.from({ length: trip.days }, (_, i) => i + 1).filter(i => !existing.some(d => d.dayIndex === i))
      const startDay = missing[0] ?? trip.days + 1
      const prev = existing.find(d => d.dayIndex === startDay - 1)
      const graph = buildAgentGraph(ctx, checkpointer())
      const latestWarnings = pendingCommit
        ? (await prisma.trip.findUnique({ where: { id: tripId }, select: { genWarnings: true } }))?.genWarnings
        : trip.genWarnings
      const result = await graph.invoke({ dayIndex: startDay, totalDays: trip.days,
        usedPoiIds: existing.flatMap(d => d.items.map(i => i.poiId).filter((id): id is string => !!id)),
        previousPlaces: existing.flatMap(d => d.items.map(i => i.name)),
        usedNightKinds: existing.flatMap(d => d.items.map(i => nightKindOfText(i.name, i.tag)).filter((k): k is NonNullable<typeof k> => !!k)),
        previousDayState: prev ? { dayType: prev.dayType, intensity: prev.intensity } : null,
        warnings: mode === 'restart' ? [] : parseJsonArray(latestWarnings ?? '[]'), finished: false,
        pendingDaySummary: null, dayRetryCount: 0, dayError: null, dayFeedback: null, pendingDay: null, pendingCandidates: null,
        gapDays: existing.map(d => d.dayIndex),
      }, config(tripId, runId))
      const interrupts = (result as { __interrupt__?: unknown[] }).__interrupt__; if (interrupts?.length) { await flush(); await suspend(tripId, runId, interrupts[0]); suspended = true }
    } catch (error) { await fail(tripId, runId, error, false); throw error }
    finally { clearInterval(handle); await flush(); if (!suspended) await releaseRun(tripId, runId) }
  }
  async function prepareTripReview(tripId: string, options: ResumeOptions): Promise<ReviewClaim> {
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })
    const runId = options.runId
    if (!runId || trip.genRunId !== runId || trip.genRunPhase !== 'waiting' || !trip.genReview || !trip.genReviewId) throw new ReviewConflictError('当前没有可裁决的待确认内容，或需要先取消未确认方案')
    if (options.reviewId && trip.genReviewId !== options.reviewId) throw new ReviewConflictError('待确认方案已变化，请刷新后重新选择')
    const value = JSON.parse(trip.genReview) as { kind?: string }
    const answer = options.answer
    if (!answer || !(answer.decision === 'reject' || (value.kind === 'confirm' && answer.decision === 'approve') ||
      (value.kind === 'choose' && answer.decision === 'choose' && (answer.choice === 'A' || answer.choice === 'B')))) throw new ReviewInputError('裁决类型与当前待确认方案不一致')
    if (!trip.genRunConfig) throw new ReviewConflictError('缺少原任务配置，请取消未确认方案后安全补缺')
    const reviewId = trip.genReviewId
    const result = await prisma.trip.updateMany({ where: { id: tripId, genRunId: runId, genRunPhase: 'waiting', genReviewId: reviewId },
      // `reviewing` is a single-use dispatch token.  The resume function
      // atomically changes it to running before starting a graph, so a second
      // caller holding the same claim cannot execute the checkpoint twice.
      data: { genRunPhase: 'reviewing', genHeartbeatAt: new Date() } })
    if (!result.count) throw new ReviewConflictError('该方案已被其他请求裁决')
    return { runId, reviewId, answer }
  }
  async function resumeTripReview(tripId: string, options: ResumeOptions = {}) {
    // 未取得执行权之前不启动心跳、不进入finally、不修改锁。
    const claim = options.claim ?? await prepareTripReview(tripId, options)
    const { runId } = claim
    // A caller may pass a previously prepared claim directly.  Consume it
    // exactly once; duplicate callers get a conflict and cannot release or
    // interfere with the first resume's run lock.
    const started = await prisma.trip.updateMany({
      where: { id: tripId, genRunId: runId, genRunPhase: 'reviewing', genReviewId: claim.reviewId },
      data: { genRunPhase: 'running', genHeartbeatAt: new Date() },
    })
    if (!started.count) throw new ReviewConflictError('该裁决已在执行或已失效')
    const handle = timer(tripId, runId)
    let suspended = false
    let recovery = false
    let flush = async () => {}
    try {
      const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })
      if (trip.genRunPhase !== 'running' || trip.genReviewId !== claim.reviewId) throw new RunLostError()
      const saved = JSON.parse(trip.genRunConfig ?? '{}') as { reviewMode?: boolean; parallelCandidates?: number }
      if (typeof saved.reviewMode !== 'boolean' || ![1, 2].includes(saved.parallelCandidates ?? 0)) throw new Error('原任务配置无效')
      const built = await context(tripId, runId, saved.reviewMode, saved.parallelCandidates!)
      flush = built.flush
      const graph = buildAgentGraph(built.ctx, checkpointer())
      const snapshot = await graph.getState(config(tripId, runId))
      if (!snapshot.tasks?.some(task => task.interrupts?.length)) throw new Error('持久化 checkpoint 缺失或未挂起，需人工安全补缺')
      const result = await graph.invoke(new Command({ resume: claim.answer }), config(tripId, runId))
      const interrupts = (result as { __interrupt__?: unknown[] }).__interrupt__; if (interrupts?.length) { await flush(); await suspend(tripId, runId, interrupts[0]); suspended = true }
    } catch (error) {
      recovery = !(error instanceof RunLostError)
      await fail(tripId, runId, error, true)
      // A durable commit journal is safe to hand back immediately.  Keep
      // genuine checkpoint/review failures in manual recovery instead.
      if (recovery) {
        const after = await prisma.trip.findUnique({ where: { id: tripId }, select: { genRunId: true, genRunPhase: true, genReview: true, genRunConfig: true } })
        if (after?.genRunId === runId && after.genRunPhase === 'commit_pending' &&
          parsePendingCommitJournal(after.genReview, after.genRunConfig)) recovery = false
        // A journal failure has no safe payload to preserve.  `fail` clears
        // the phase and review fields, so release this owner just like the
        // generate path; only checkpoint/review failures stay manual recovery.
        else if (error instanceof DayCommitError && after?.genRunId === runId && after.genRunPhase === null) recovery = false
      }
      throw error
    }
    finally { clearInterval(handle); await flush(); if (!suspended && !recovery) await releaseRun(tripId, runId) }
  }
  return { generateTripWithGraph, prepareTripReview, resumeTripReview, close: () => { saver?.db.close(); saver = null } }
}

async function persistDay(tripId: string, runId: string, day: PlannedDay, date: Date, weather: unknown,
  progress?: { warnings: string[]; totalDays: number }): Promise<void> {
  await prisma.$transaction(async tx => {
    // 先条件写获得 SQLite 写事务并验证所有权，再读取配置；迟到任务
    // 不能在读取后、内容提交前插入新的 owner。
    await updateOwnedTrip(tripId, runId, { genRunPhase: 'running' }, tx)
    const current = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: { genRunConfig: true } })
    let runConfig: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(current.genRunConfig ?? '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) runConfig = { ...(parsed as Record<string, unknown>) }
    } catch { /* malformed historical config is preserved below */ }
    if (runConfig) delete runConfig.pendingCommit
    await updateOwnedTrip(tripId, runId, { genDayIndex: day.dayIndex, genProgress: `第 ${day.dayIndex}/${progress?.totalDays ?? '?'} 天已完成`,
      genRunPhase: 'running', genReview: null, genReviewId: null,
      genWarnings: progress?.warnings?.length ? JSON.stringify(progress.warnings) : null,
      ...(runConfig ? { genRunConfig: JSON.stringify(runConfig) } : {}) }, tx)
    // 已落库日期由事实决定，checkpoint 重放也不得覆盖原条目/打卡。
    if (await tx.tripDay.findUnique({ where: { tripId_dayIndex: { tripId, dayIndex: day.dayIndex } } })) return
    await tx.tripDay.create({ data: { tripId, dayIndex: day.dayIndex, date, summary: day.summary || null,
      weather: weather ? JSON.stringify(weather) : null, dayType: day.dayType, intensity: day.intensity,
      items: { create: day.items.map(item => ({ orderIndex: item.orderIndex, slot: item.slot, itemType: item.itemType,
        poiId: item.poiId, name: item.name, lng: item.lng, lat: item.lat, address: item.address || null, tel: item.tel || null,
        rating: item.rating, cost: item.cost, tag: item.tag || null, typecode: item.typecode || null, openTimeText: item.openTimeText || null,
        note: item.note || null, photos: item.photos.length ? JSON.stringify(item.photos) : null })) },
    } })
  }, { timeout: 15_000 })
}

async function persistPendingDay(tripId: string, runId: string, day: PlannedDay, warnings: string[], totalDays: number): Promise<void> {
  const payload: PendingCommit = { kind: 'commit_pending', dayIndex: day.dayIndex, totalDays, day, warnings }
  await prisma.$transaction(async tx => {
    await updateOwnedTrip(tripId, runId, { genRunPhase: 'running' }, tx)
    const current = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: { genRunConfig: true } })
    let runConfig: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(current.genRunConfig ?? '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) runConfig = { ...(parsed as Record<string, unknown>) }
    } catch { /* replace only the invalid transient config with a valid journal */ }
    runConfig.pendingCommit = payload
    await updateOwnedTrip(tripId, runId, {
      genRunPhase: 'commit_pending',
      genReviewId: randomUUID(),
      genReview: JSON.stringify(payload),
      genRunConfig: JSON.stringify(runConfig),
    }, tx)
  })
}
const runtime = createGraphRuntime()
export const generateTripWithGraph = runtime.generateTripWithGraph
export const prepareTripReview = runtime.prepareTripReview
export const resumeTripReview = runtime.resumeTripReview
