/**
 * The commit journal is also inspected by the lock layer before a worker is
 * reclaimed.  Keep this structural check independent from graph-run so both
 * layers agree on whether a journal can be retried without another model call.
 */
export function isPendingCommitShape(value: unknown): value is {
  kind: 'commit_pending'
  dayIndex: number
  totalDays: number
  day: {
    dayIndex: number
    summary: string
    items: Array<Record<string, unknown>>
    dayType: string
    intensity: string
  }
  warnings: string[]
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (payload.kind !== 'commit_pending' ||
    !Number.isInteger(payload.dayIndex) || (payload.dayIndex as number) < 1 ||
    !Number.isInteger(payload.totalDays) || (payload.totalDays as number) < (payload.dayIndex as number) ||
    !Array.isArray(payload.warnings) || !payload.warnings.every(warning => typeof warning === 'string')) return false
  const day = payload.day
  if (!day || typeof day !== 'object' || Array.isArray(day)) return false
  const planned = day as Record<string, unknown>
  if (planned.dayIndex !== payload.dayIndex || typeof planned.summary !== 'string' ||
    typeof planned.dayType !== 'string' || typeof planned.intensity !== 'string' || !Array.isArray(planned.items)) return false
  return planned.items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))
}
