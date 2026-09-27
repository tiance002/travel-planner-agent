// JSON 字符串字段的读写工具。
//
// 背景（见审查报告 5.1）：
//   项目里到处都在对数据库的 JSON 字符串字段做「解析 → 不是数组就退化成空数组」
//   这件事：routes/trips.ts 的 parseJsonArray、graph-run.ts 的 safeParseArray、
//   以及若干处内联的 JSON.parse + try/catch。实现本质相同却各写一份，
//   于是「某处忘了 try/catch」或「某处没有数组校验」的问题就防不胜防。
//
// 这个文件是唯一事实来源：所有 JSON 字符串字段的解析都走这里。
//
// 注意：长期方向是把 preferences / extraNeeds / weather / genReview / genDecisions
// 改为 PostgreSQL 的 JSON/JSONB 字段（报告 5.1 已经给出），届时这些函数会退化为
// 简单的透传。在 SQLite 阶段，它们至少保证了「解析逻辑只有一份」。

/**
 * 把 JSON 字符串安全地解析成字符串数组。
 *
 * 三种容错：
 *   - 不是合法 JSON（脏数据、被截断）→ 空数组；
 *   - 解析出来不是数组（比如是个对象）→ 空数组；
 *   - 数组元素不是字符串（数字、null）→ 逐个 String() 归一化。
 */
export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** 把 JSON 字符串安全地解析成对象；不合法或不是对象时返回 null */
export function parseJsonObject<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

/**
 * 把数组序列化成 JSON 字符串，用于写库。
 * 空数组统一写 null，避免数据库里堆积大量含义相同的 "[]"。
 */
export function stringifyJsonArray(value: string[] | null | undefined): string | null {
  if (!value || value.length === 0) return null
  return JSON.stringify(value)
}
