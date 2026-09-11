// 排程规则的校验与修正。
//
// 为什么规则要写在代码里而不是提示词里：
//   提示词像是在便签纸上写「请勿迟到」，靠的是自觉；代码则是门禁闸机，不刷卡就进不去。
//   模型偶尔会多排一个景点、把餐厅放到第一个、或者把两个相隔 20 公里的点排在一起，
//   这些都由这一层拦住并修正，而不是返回给用户一份「看起来没错」的行程。
//
// 本文件负责四件事：
//   1. 把模型输出的文本解析成结构（容错处理 Markdown 代码块等包裹）
//   2. 校验每个地点的 poiId 确实来自工具返回，坐标一律以服务端登记表为准
//   3. 修正每天的顺序与数量：景点 ≤ 3，餐厅夹在景点之间
//   4. 体检真实通勤时间，超过 40 分钟的相邻点尝试替换

import { planRoute, straightLineDistance, type Poi } from '../amap'

/** 每天游览类地点的上限。餐厅不计入 */
export const MAX_SPOTS_PER_DAY = 3

/** 相邻两点可接受的最大通勤时间（分钟），超过就换点 */
export const MAX_COMMUTE_MINUTES = 40

export interface PlannedItem {
  poiId: string
  name: string
  lng: number
  lat: number
  address: string
  tel: string
  rating: string | null
  cost: string | null
  tag: string
  openTimeText: string
  itemType: 'spot' | 'restaurant'
  slot: string
  note: string
  orderIndex: number
  /** 与前一个地点之间的真实通勤分钟数。0 表示当天第一个地点（从住宿出发） */
  commuteMinutes: number | null
}

export interface PlannedDay {
  dayIndex: number
  summary: string
  items: PlannedItem[]
}

export interface PlanResult {
  stay: { poiId: string; name: string; reason: string; lng: number; lat: number } | null
  days: PlannedDay[]
  /** 校验过程中发现并处理过的问题，存进日志便于排查，也用于给用户提示 */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 1. 解析模型输出
// ---------------------------------------------------------------------------

interface RawItem {
  poiId?: unknown
  itemType?: unknown
  slot?: unknown
  note?: unknown
}

interface RawDay {
  dayIndex?: unknown
  summary?: unknown
  items?: unknown
}

interface RawPlan {
  stay?: { poiId?: unknown; name?: unknown; reason?: unknown }
  days?: unknown
}

/**
 * 把模型返回的文本解析成 JSON。
 * 模型经常会顺手包一层 ```json 代码块，或者前后加几句客套话，
 * 这里统一剥掉再解析，减少无谓的重试。
 */
export function parsePlanJson(text: string): RawPlan {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型没有按要求输出 JSON')
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as RawPlan
  } catch {
    throw new Error('模型输出的 JSON 无法解析')
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. 校验与修正
// ---------------------------------------------------------------------------

/** 判断一个 POI 是不是餐饮。以高德分类编码为准，不信任模型自己标 itemType */
function isRestaurant(poi: Poi): boolean {
  return poi.typecode.startsWith('05') || poi.type.includes('餐饮')
}

/** 把 POI 转成待落库的条目 */
function toPlannedItem(
  poi: Poi,
  note: string,
  slot: string,
  orderIndex: number,
): PlannedItem {
  return {
    poiId: poi.poiId,
    name: poi.name,
    lng: poi.lng,
    lat: poi.lat,
    address: poi.address,
    tel: poi.tel,
    rating: poi.rating === null ? null : String(poi.rating),
    cost: poi.cost === null ? null : String(poi.cost),
    tag: poi.tag || poi.keytag,
    // 高德不总是返回营业时间，缺失时前端要显示「营业时间未知」而不是空白
    openTimeText: poi.openTimeToday,
    itemType: isRestaurant(poi) ? 'restaurant' : 'spot',
    slot,
    note,
    orderIndex,
    commuteMinutes: null,
  }
}

/**
 * 把一天内的地点重排成「景点 → 餐厅 → 景点 → 餐厅 → 景点」的顺序。
 *
 * 餐厅为什么不能单独成段：用户不会「专程去吃个饭再回去玩」，
 * 餐厅的合理位置是在两个景点之间顺手解决一顿。所以顺序由代码排定，
 * 不依赖模型自觉。
 */
function arrangeDay(items: { poi: Poi; note: string }[]): { poi: Poi; note: string; slot: string }[] {
  const spots = items.filter((i) => !isRestaurant(i.poi))
  const restaurants = items.filter((i) => isRestaurant(i.poi))

  // 一个景点都没有的「整天」没有意义，直接清空，由上层提示
  if (spots.length === 0) return []

  // 景点按 morning → afternoon → evening 依次分配时段
  const spotSlots = ['morning', 'afternoon', 'evening']
  const result: { poi: Poi; note: string; slot: string }[] = []

  // 餐厅尽量均分到景点之间的空隙；只有 1 个景点时全部放在它之后
  const gaps = Math.max(spots.length - 1, 1)

  spots.forEach((spot, index) => {
    result.push({ poi: spot.poi, note: spot.note, slot: spotSlots[index] ?? 'evening' })

    // 这个景点之后该分配几家餐厅
    const quota = Math.floor(restaurants.length / gaps) + (index < restaurants.length % gaps ? 1 : 0)
    for (let n = 0; n < quota; n++) {
      const restaurant = restaurants.shift()
      if (!restaurant) break
      // 最后一个景点之后的餐厅算晚餐，其余算午餐
      const isLastGap = index === spots.length - 1
      result.push({ poi: restaurant.poi, note: restaurant.note, slot: isLastGap ? 'evening' : 'noon' })
    }
  })

  // 极端情况下还有餐厅没分配出去（空隙数为 0 等），补在末尾
  for (const restaurant of restaurants) {
    result.push({ poi: restaurant.poi, note: restaurant.note, slot: 'evening' })
  }

  return result
}

/**
 * 校验并修正模型给出的方案。
 * 传入的登记表是唯一可信来源：模型提到但没在表里的 poiId 一律丢弃。
 */
export function validatePlan(raw: RawPlan, registry: Map<string, Poi>, expectedDays: number): PlanResult {
  const warnings: string[] = []
  const days: PlannedDay[] = []

  const rawDays = Array.isArray(raw.days) ? (raw.days as RawDay[]) : []
  if (rawDays.length === 0) {
    throw new Error('模型没有给出任何一天的安排')
  }

  const usedPoiIds = new Set<string>()

  rawDays.forEach((rawDay, dayOffset) => {
    const dayIndex = Number(rawDay.dayIndex)
    const safeDayIndex = Number.isInteger(dayIndex) && dayIndex > 0 ? dayIndex : dayOffset + 1

    const rawItems = Array.isArray(rawDay.items) ? (rawDay.items as RawItem[]) : []
    const collected: { poi: Poi; note: string }[] = []

    for (const rawItem of rawItems) {
      const poiId = typeof rawItem.poiId === 'string' ? rawItem.poiId : ''
      const poi = registry.get(poiId)

      if (!poi) {
        // 这就是「模型编造地点」的拦截点
        warnings.push(`第 ${safeDayIndex} 天有一个地点不在候选列表中（poiId：${poiId || '缺失'}），已丢弃`)
        continue
      }

      // 同一天不重复安排同一个地点
      if (collected.some((c) => c.poi.poiId === poi.poiId)) {
        warnings.push(`第 ${safeDayIndex} 天重复安排了「${poi.name}」，已去重`)
        continue
      }

      collected.push({
        poi,
        note: typeof rawItem.note === 'string' ? rawItem.note.slice(0, 200) : '',
      })
    }

    // 截断超量的游览地点。餐厅不计入上限，所以先按类型分开数
    const spotCount = collected.filter((c) => !isRestaurant(c.poi)).length
    if (spotCount > MAX_SPOTS_PER_DAY) {
      let keptSpots = 0
      const trimmed = collected.filter((c) => {
        if (isRestaurant(c.poi)) return true
        keptSpots += 1
        return keptSpots <= MAX_SPOTS_PER_DAY
      })
      warnings.push(`第 ${safeDayIndex} 天原本安排了 ${spotCount} 个景点，已按规则裁剪到 ${MAX_SPOTS_PER_DAY} 个`)
      collected.length = 0
      collected.push(...trimmed)
    }

    const arranged = arrangeDay(collected)
    if (arranged.length === 0) {
      if (collected.length > 0) {
        warnings.push(`第 ${safeDayIndex} 天只有餐厅、没有景点，已清空（餐厅不会单独占一天）`)
      }
      days.push({ dayIndex: safeDayIndex, summary: '', items: [] })
      return
    }

    const items = arranged.map((entry, index) =>
      toPlannedItem(entry.poi, entry.note, entry.slot, index + 1),
    )
    // 记录已用地点，后面换点时要避开这些
    for (const item of items) usedPoiIds.add(item.poiId)

    days.push({
      dayIndex: safeDayIndex,
      summary:
        typeof rawDay.summary === 'string' && rawDay.summary.trim()
          ? rawDay.summary.trim().slice(0, 120)
          : '',
      items,
    })
  })

  // 补齐模型漏掉的天数：宁可空着，也不要让它把第 5 天复制成第 4 天
  for (let index = 1; index <= expectedDays; index++) {
    if (!days.some((d) => d.dayIndex === index)) {
      warnings.push(`模型漏掉了第 ${index} 天，已留空`)
      days.push({ dayIndex: index, summary: '', items: [] })
    }
  }
  days.sort((a, b) => a.dayIndex - b.dayIndex)

  // 住宿锚点同样必须来自登记表
  let stay: PlanResult['stay'] = null
  const stayPoiId = typeof raw.stay?.poiId === 'string' ? raw.stay.poiId : ''
  const stayPoi = registry.get(stayPoiId)
  if (stayPoi) {
    stay = {
      poiId: stayPoi.poiId,
      name: stayPoi.name,
      lng: stayPoi.lng,
      lat: stayPoi.lat,
      reason: typeof raw.stay?.reason === 'string' ? raw.stay.reason.slice(0, 200) : '',
    }
  }

  return { stay, days, warnings }
}

// ---------------------------------------------------------------------------
// 4. 通勤体检与换点
// ---------------------------------------------------------------------------

/** 查询两点之间的驾车耗时（分钟）。失败时返回 null，不阻断流程 */
async function commuteMinutes(from: Poi, to: Poi): Promise<number | null> {
  try {
    const route = await planRoute({
      mode: 'driving',
      originLng: from.lng,
      originLat: from.lat,
      destLng: to.lng,
      destLat: to.lat,
    })
    return Math.round(route.duration / 60)
  } catch {
    // 路径查询失败不该让整份行程作废，交给用户按直线距离判断
    return null
  }
}

/**
 * 通勤体检：把每天相邻两点之间的真实车程算出来，超过阈值的换点。
 *
 * 换点策略：从候选池里找一个比原地点离「上一个点」更近的替代者。
 * 不做全局最优搜索——那会把运行时间拉长到用户等不起，够用就好。
 */
export async function optimizeCommute(
  plan: PlanResult,
  registry: Map<string, Poi>,
  report: (text: string) => void,
): Promise<void> {
  const usedPoiIds = new Set<string>()
  for (const day of plan.days) {
    for (const item of day.items) usedPoiIds.add(item.poiId)
  }

  const total = plan.days.reduce((sum, day) => Math.max(sum, day.items.length), 0)
  let checked = 0

  for (const day of plan.days) {
    for (let index = 1; index < day.items.length; index++) {
      const previous = day.items[index - 1]
      const current = day.items[index]
      checked += 1
      if (total > 0) report(`正在核对通勤路线（${checked}/${total * plan.days.length}）`)

      const minutes = await commuteMinutes(
        asPoi(previous),
        asPoi(current),
      )
      current.commuteMinutes = minutes

      if (minutes === null || minutes <= MAX_COMMUTE_MINUTES) continue

      // 超时了，看看能不能换个更近的地点
      const replacement = pickReplacement(asPoi(previous), asPoi(current), registry, usedPoiIds)
      if (!replacement) {
        plan.warnings.push(
          `第 ${day.dayIndex} 天「${previous.name}」到「${current.name}」需要约 ${minutes} 分钟，` +
            `超过 ${MAX_COMMUTE_MINUTES} 分钟且没有更合适的替代地点，请留意`,
        )
        continue
      }

      const replacementMinutes = await commuteMinutes(asPoi(previous), replacement)
      if (replacementMinutes !== null && replacementMinutes > MAX_COMMUTE_MINUTES) {
        plan.warnings.push(
          `第 ${day.dayIndex} 天「${previous.name}」到「${current.name}」需要约 ${minutes} 分钟，` +
            `已替换为「${replacement.name}」仍需 ${replacementMinutes} 分钟，建议当天减少一个地点`,
        )
      } else {
        plan.warnings.push(
          `第 ${day.dayIndex} 天原安排的「${current.name}」距上一个地点约 ${minutes} 分钟，` +
            `已换成更近的「${replacement.name}」`,
        )
      }

      usedPoiIds.delete(current.poiId)
      usedPoiIds.add(replacement.poiId)
      day.items[index] = toPlannedItem(
        replacement,
        current.note,
        current.slot,
        current.orderIndex,
      )
      day.items[index].commuteMinutes = replacementMinutes
    }
  }
}

/** 把已落库的条目反向还原成 POI 需要的形状（换点时要用坐标） */
function asPoi(item: PlannedItem): Poi {
  return {
    poiId: item.poiId,
    name: item.name,
    lng: item.lng,
    lat: item.lat,
    address: item.address,
    type: '',
    typecode: '',
    cityName: '',
    district: '',
    adcode: '',
    rating: null,
    cost: null,
    tag: '',
    keytag: '',
    openTimeToday: item.openTimeText,
    openTimeWeek: '',
    tel: item.tel,
    photos: [],
    distance: null,
  }
}

/** 挑一个替代地点：未使用过的游览类 POI 里，离上一个点最近的 */
function pickReplacement(
  previous: Poi,
  current: Poi,
  registry: Map<string, Poi>,
  usedPoiIds: Set<string>,
): Poi | null {
  const currentDistance = straightLineDistance(previous, current)
  let best: Poi | null = null
  let bestDistance = currentDistance

  for (const poi of registry.values()) {
    if (usedPoiIds.has(poi.poiId)) continue
    if (isRestaurant(poi)) continue

    const distance = straightLineDistance(previous, poi)
    if (distance < bestDistance) {
      best = poi
      bestDistance = distance
    }
  }

  return best
}
