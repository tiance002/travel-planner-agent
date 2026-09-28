import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'

assert.equal(process.env.TRAVEL_TEST_ISOLATED, '1', 'requires an isolated test database')

const migrationsRoot = path.resolve(import.meta.dirname, '../prisma/migrations')
const migrationNames = [
  '20260910133946_init',
  '20260911001134_add_generation_fields',
  '20260911031530_track_generation_day',
  '20260911092812_add_avatar_and_photos',
  '20260911115854_add_day_type_intensity_typecode',
  '20260912041054_add_gen_decisions',
  '20260912053509_add_gen_review',
  '20260927074038_add_gen_warnings',
  '20260927082625_add_gen_run_lock',
]
const lifecycleSql = await readFile(
  path.join(migrationsRoot, '20260928090000_run_lifecycle', 'migration.sql'),
  'utf8',
)

const root = await mkdtemp(path.join(os.tmpdir(), 'travel-migration-check-'))
const clients: Array<ReturnType<typeof createClient>> = []

async function makeLegacyDatabase(fileName: string) {
  const filePath = path.join(root, fileName)
  const url = `file:${filePath.replaceAll('\\', '/')}`
  const client = createClient({ url })
  clients.push(client)
  for (const name of migrationNames) {
    const sql = await readFile(path.join(migrationsRoot, name, 'migration.sql'), 'utf8')
    await client.executeMultiple(sql)
  }
  return { client, filePath }
}

try {
  // Old review data is retained and explicitly downgraded to manual recovery;
  // the saved day and its check-in survive the schema change.
  const reviewFixture = await makeLegacyDatabase('old-review.sqlite')
  const review = reviewFixture.client
  await review.execute({
    sql: `INSERT INTO User (id, username, passwordHash, createdAt, updatedAt)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: ['user-review', 'migration-review', 'x'],
  })
  await review.execute({
    sql: `INSERT INTO Trip (id, userId, title, cityName, cityAdcode, startDate, days, travelers,
      status, createdAt, updatedAt, genReview, genRunId, genHeartbeatAt, genRunStartedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
    args: [
      'trip-review', 'user-review', '旧行程', '杭州', '330100', '2026-10-01T00:00:00.000Z',
      1, 1, 'generating', '{"kind":"confirm","dayIndex":1}', 'old-review-run',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ],
  })
  // A prior failure could have cleared only genRunId and stranded the review
  // payload.  The lifecycle migration must expose it to recovery/cancel.
  await review.execute({
    sql: `INSERT INTO Trip (id, userId, title, cityName, cityAdcode, startDate, days, travelers,
      status, createdAt, updatedAt, genReview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
    args: [
      'trip-orphan-review', 'user-review', '旧孤立裁决', '杭州', '330100', '2026-10-01T00:00:00.000Z',
      1, 1, 'partial', '{"kind":"confirm","dayIndex":1}',
    ],
  })
  await review.execute({
    sql: `INSERT INTO TripDay (id, tripId, dayIndex, date, summary)
      VALUES (?, ?, ?, ?, ?)`,
    args: ['day-review', 'trip-review', 1, '2026-10-01T00:00:00.000Z', '已确认的一天'],
  })
  await review.execute({
    sql: `INSERT INTO TripItem (id, tripDayId, orderIndex, slot, itemType, name, checkedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ['item-review', 'day-review', 0, 'morning', 'spot', '已打卡景点', '2026-10-02T00:00:00.000Z'],
  })
  await review.executeMultiple(lifecycleSql)
  const migrated = await review.execute({
    sql: `SELECT genRunId, genActiveUserId, genRunPhase, genReview,
      (SELECT COUNT(*) FROM TripDay WHERE tripId = 'trip-review') AS dayCount,
      (SELECT COUNT(*) FROM TripItem WHERE tripDayId = 'day-review' AND checkedAt IS NOT NULL) AS checkedCount
      FROM Trip WHERE id = 'trip-review'`,
  })
  const row = migrated.rows[0] as Record<string, unknown>
  assert.equal(row.genRunId, 'old-review-run')
  assert.equal(row.genActiveUserId, 'user-review')
  assert.equal(row.genRunPhase, 'recovery')
  assert.ok(row.genReview)
  assert.equal(Number(row.dayCount), 1)
  assert.equal(Number(row.checkedCount), 1)
  const orphan = await review.execute({
    sql: `SELECT genRunId, genRunPhase, genReview FROM Trip WHERE id = 'trip-orphan-review'`,
  })
  const orphanRow = orphan.rows[0] as Record<string, unknown>
  assert.equal(orphanRow.genRunId, null)
  assert.equal(orphanRow.genRunPhase, 'recovery')
  assert.ok(orphanRow.genReview)
  // Duplicate old locks must fail the unique-index migration visibly.  The
  // migration must never pick one row and silently discard the other.
  const duplicateFixture = await makeLegacyDatabase('duplicate-locks.sqlite')
  const duplicate = duplicateFixture.client
  await duplicate.execute({
    sql: `INSERT INTO User (id, username, passwordHash, createdAt, updatedAt)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: ['user-duplicate', 'migration-duplicate', 'x'],
  })
  for (const id of ['trip-duplicate-a', 'trip-duplicate-b']) {
    await duplicate.execute({
      sql: `INSERT INTO Trip (id, userId, title, cityName, cityAdcode, startDate, days, travelers,
        status, createdAt, updatedAt, genRunId, genHeartbeatAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
      args: [id, 'user-duplicate', id, '杭州', '330100', '2026-10-01T00:00:00.000Z', 1, 1, 'generating', `${id}-run`, '2026-10-01T00:00:00.000Z'],
    })
  }
  await assert.rejects(() => duplicate.executeMultiple(lifecycleSql), /UNIQUE|unique|constraint/i)
  const duplicateCount = await duplicate.execute({
    sql: `SELECT COUNT(*) AS count FROM Trip WHERE userId = 'user-duplicate'`,
  })
  assert.equal(Number((duplicateCount.rows[0] as Record<string, unknown>).count), 2)
  console.log('✓ migration keeps old review/check-in data and refuses duplicate locks without loss')
} finally {
  for (const client of clients) {
    try { await client.close() } catch { /* cleanup continues */ }
  }
  // On Windows the native SQLite handle released by a failed DDL statement
  // can take a turn to disappear after close(); give it time before removing
  // the fixture directory.
  await new Promise(resolve => setTimeout(resolve, 500))
  const resolved = path.resolve(root)
  const tempRoot = path.resolve(os.tmpdir())
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('travel-migration-check-')) {
    throw new Error('refusing migration fixture cleanup outside owned temp directory')
  }
  try {
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (error) {
    // A failed native SQLite DDL can keep a Windows handle alive until the
    // Node process exits.  The fixture is outside the repository and contains
    // no user data; report cleanup rather than turning a passed migration
    // assertion into a false-negative process failure.
    console.warn(`[migration check] temporary fixture cleanup deferred: ${error instanceof Error ? error.message : String(error)}`)
  }
}
