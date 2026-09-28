import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'

assert.equal(process.env.TRAVEL_TEST_ISOLATED, '1', 'requires an isolated test database')
process.env.JWT_SECRET = 'replan-check-fixture'
process.env.VAULT_MASTER_KEY = '0'.repeat(64)
process.env.AMAP_WEB_SERVICE_KEY = ''
process.env.AMAP_JS_KEY = ''

const { prisma } = await import('../src/db')
const { createTripsRouter } = await import('../src/routes/trips')
const { signToken } = await import('../src/utils/jwt')

const user = await prisma.user.create({ data: { username: `replan-${crypto.randomUUID()}`, passwordHash: 'x' } })
const source = await prisma.trip.create({
  data: {
    userId: user.id,
    title: '原行程',
    cityName: '杭州',
    cityAdcode: '330100',
    startDate: new Date('2026-10-01'),
    days: 2,
    travelers: 2,
    preferences: '["博物馆"]',
    extraNeeds: '["少走路"]',
    budgetAmount: 1000,
    budgetScope: 'total',
    stayResolved: true,
    stayPoiId: 'hotel-1',
    stayName: '西湖边酒店',
    stayLng: 120.15,
    stayLat: 30.28,
    status: 'ready',
  },
})
const day = await prisma.tripDay.create({
  data: {
    tripId: source.id,
    dayIndex: 1,
    date: new Date('2026-10-01'),
    summary: '保留的一天',
    items: {
      create: [{ orderIndex: 0, slot: 'morning', itemType: 'spot', poiId: 'spot-1', name: '已打卡景点', checkedAt: new Date('2026-10-02') }],
    },
  },
})

const app = express()
app.use(express.json())
app.use('/api/trips', createTripsRouter({
  generateTripWithGraph: async () => {},
  prepareTripReview: async () => { throw new Error('not used') },
  resumeTripReview: async () => {},
} as never))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))

try {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const authorization = { Authorization: `Bearer ${signToken({ userId: user.id, username: user.username })}` }

  const restart = await fetch(`${base}/api/trips/${source.id}/generate`, {
    method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'restart' }),
  })
  assert.equal(restart.status, 409)
  const originalBeforeCopy = await prisma.tripItem.findUniqueOrThrow({ where: { id: (await prisma.tripDay.findUniqueOrThrow({ where: { id: day.id }, include: { items: true } })).items[0].id } })

  const copyResponse = await fetch(`${base}/api/trips/${source.id}/replan-copy`, {
    method: 'POST', headers: authorization,
  })
  assert.equal(copyResponse.status, 201)
  const copiedPayload = await copyResponse.json() as { trip: { id: string; title: string; status: string; cityName: string; preferences: string; genRunId: string | null } }
  assert.notEqual(copiedPayload.trip.id, source.id)
  assert.equal(copiedPayload.trip.status, 'draft')
  assert.equal(copiedPayload.trip.cityName, source.cityName)
  assert.equal(copiedPayload.trip.preferences, source.preferences)
  assert.equal(copiedPayload.trip.genRunId, null)
  assert.match(copiedPayload.trip.title, /重新规划/)
  assert.equal(await prisma.tripDay.count({ where: { tripId: copiedPayload.trip.id } }), 0)

  const originalAfter = await prisma.tripItem.findUniqueOrThrow({ where: { id: originalBeforeCopy.id } })
  assert.equal(originalAfter.checkedAt?.toISOString(), originalBeforeCopy.checkedAt?.toISOString())
  assert.equal(await prisma.tripDay.count({ where: { tripId: source.id } }), 1)
  console.log('✓ restart is non-destructive and replan-copy preserves the original checked itinerary')
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
  await prisma.$disconnect().catch(() => undefined)
}
