import { z } from 'zod'
import type { PlannedDay } from './scheduler'

const finite = z.number().finite()
const plannedItemSchema = z.object({
  poiId: z.string().min(1), name: z.string().min(1), lng: finite, lat: finite,
  address: z.string(), tel: z.string(), rating: z.string().nullable(), cost: z.string().nullable(),
  tag: z.string(), openTimeText: z.string(), itemType: z.enum(['spot', 'restaurant']),
  slot: z.enum(['morning', 'noon', 'afternoon', 'evening']), note: z.string(), orderIndex: z.number().int().positive(),
  typecode: z.string(), commuteMinutes: finite.nonnegative().nullable(), photos: z.array(z.string()),
})
const pendingSchema = z.object({
  kind: z.literal('commit_pending'), dayIndex: z.number().int().positive(),
  totalDays: z.number().int().positive(), warnings: z.array(z.string()),
  day: z.object({
    dayIndex: z.number().int().positive(), summary: z.string(), items: z.array(plannedItemSchema),
    dayType: z.enum(['normal', 'theme_park', 'hike', 'night_hike', 'recovery']),
    intensity: z.enum(['light', 'medium', 'heavy']),
  }),
}).refine(value => value.dayIndex <= value.totalDays && value.day.dayIndex === value.dayIndex)

export interface PendingCommitPayload {
  kind: 'commit_pending'
  dayIndex: number
  totalDays: number
  day: PlannedDay
  warnings: string[]
}

export function isPendingCommitShape(value: unknown): value is PendingCommitPayload {
  return pendingSchema.safeParse(value).success
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) as unknown } catch { return null }
}

/** Both durable copies must agree when both exist; one valid copy supports older rows. */
export function parsePendingCommitJournal(review: string | null, config: string | null): PendingCommitPayload | null {
  const reviewValue = parseJson(review)
  const configValue = parseJson(config)
  const configured = configValue && typeof configValue === 'object' && !Array.isArray(configValue)
    ? (configValue as Record<string, unknown>).pendingCommit
    : undefined
  const reviewResult = reviewValue === null ? null : pendingSchema.safeParse(reviewValue)
  const configResult = configured === undefined ? null : pendingSchema.safeParse(configured)
  if (reviewResult && !reviewResult.success || configResult && !configResult.success) return null
  const fromReview = reviewResult?.success ? reviewResult.data : null
  const fromConfig = configResult?.success ? configResult.data : null
  if (fromReview && fromConfig && JSON.stringify(fromReview) !== JSON.stringify(fromConfig)) return null
  // Validation may reorder keys. Keep the saved payload byte-for-byte stable
  // across a failed database retry so both durable journal columns agree.
  return (fromReview ? reviewValue : fromConfig ? configured : null) as PendingCommitPayload | null
}
