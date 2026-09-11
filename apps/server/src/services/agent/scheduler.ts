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

export interface RawPlan {
  stay?: { poiId?: unknown; name?: unknown; reason?: unknown }
  days?: unknown
}

/**
 * 解析失败时抛出。比普通的 Error 多带两个信息，方便上层决定怎么补救：
 *   - truncated：是不是「话没说完」被截断了（对应重新输出时要它缩短篇幅）
 *   - snippet：模型当时写到哪里，直接打进日志，省得再复现一次
 */
export class PlanParseError extends Error {
  readonly truncated: boolean
  readonly snippet: string

  constructor(message: string, detail: { truncated: boolean; snippet: string }) {
    super(message)
    this.name = 'PlanParseError'
    this.truncated = detail.truncated
    this.snippet = detail.snippet
  }
}

/**
 * 把模型返回的文本解析成 JSON。
 *
 * 模型输出失手的花样比想象中多，这里按「从轻到重」依次尝试三种解析方式，
 * 能救回的都救回，救不了的才抛错：
 *   1. 原样解析：剥掉 Markdown 代码块和前后废话后直接 parse（覆盖九成情况）
 *   2. 修小毛病：字符串里有没转义的换行、对象末尾多了个逗号
 *   3. 截断修复：输出到一半撞上长度上限，最后一个地点写到一半就断了
 */
export function parsePlanJson(text: string): RawPlan {
  const cleaned = stripWrappers(text ?? '')
  const scan = extractJsonObject(cleaned)

  // 1) 原样解析
  if (scan.text) {
    const direct = tryParse(scan.text)
    if (direct) return direct

    // 2) 修掉未转义的控制字符与多余的尾逗号，再试一次
    const repaired = stripTrailingCommas(escapeControlCharsInStrings(scan.text))
    const afterRepair = tryParse(repaired)
    if (afterRepair) return afterRepair

    // 3) 截断修复：丢掉最后一个残缺片段，补齐未闭合的括号
    const patched = closeTruncatedJson(repaired)
    const afterPatch = patched ? tryParse(patched) : null
    if (afterPatch) return afterPatch
  }

  const raw = text ?? ''
  throw new PlanParseError(
    scan.text
      ? '模型输出的 JSON 无法解析'
      : '模型没有按要求输出 JSON（回复里找不到 JSON 对象）',
    {
      truncated: !scan.closed,
      snippet: raw.slice(-300),
    },
  )
}

/** 尽力而为的解析：失败返回 null，不抛错 */
function tryParse(text: string): RawPlan | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? (value as RawPlan) : null
  } catch {
    return null
  }
}

/** 剥掉 BOM、Markdown 代码块围栏与首尾空白 */
function stripWrappers(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/```/g, '')
    .trim()
}

interface ScanResult {
  /** 从第一个 { 开始的片段；没找到则为 null */
  text: string | null
  /** 这段片段括号是否配平。false 基本等同于「输出被截断」 */
  closed: boolean
}

/**
 * 从混杂文本里切出第一个完整的 JSON 对象。
 *
 * 为什么不用 indexOf('{') + lastIndexOf('}') 这种省事写法：
 * 地点名称、推荐理由里完全可能带上花括号，而且模型可能在 JSON 后面又补一段解释，
 * 前后一刀切很可能切出半截。这里用括号栈逐字符扫描，能正确跳过字符串内部，
 * 顺带还能判断出是不是压根没闭合（被截断了）。
 */
function extractJsonObject(text: string): ScanResult {
  const start = text.indexOf('{')
  if (start === -1) return { text: null, closed: false }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return { text: text.slice(start, i + 1), closed: true }
    }
  }

  // 扫到结尾还没闭合：把剩下的都交出去，由后面的修复逻辑处理
  return { text: text.slice(start), closed: false }
}

/**
 * 把 JSON 字符串**内部**未转义的换行、制表符等控制字符转义掉。
 *
 * JSON 规范不允许字符串里出现裸的换行，但模型写中文长句时特别容易直接敲回车，
 * 于是整段 JSON 就废了。这个函数只动字符串内部，字符串外的空白保持原样
 * （字符串外的换行本来就是合法空白，乱转义反而会把 JSON 弄坏）。
 */
function escapeControlCharsInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (const ch of text) {
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }

    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inString = false
      continue
    }

    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20) {
      out +=
        ch === '\n'
          ? '\\n'
          : ch === '\r'
            ? '\\r'
            : ch === '\t'
              ? '\\t'
              : `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += ch
  }

  return out
}

/** 去掉 ], } 之前多余的逗号（形如 [1,2,] 这种，JSON 规范里不合法） */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === ',') {
      // 往后看一眼：只要后面第一个有效字符是收尾括号，这个逗号就是多余的
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }

    out += ch
  }

  return out
}

/**
 * 截断修复：退回最后一个完整结束的位置，再把没闭合的括号补上。
 *
 * 类比：一页纸被裁掉了下半截，我们就在最后一个完整的句子处收尾，
 * 然后给没写完的段落补上句号。丢掉的是最后那个半截的地点，
 * 比起整趟行程都失败，这个代价小得多。
 */
function closeTruncatedJson(text: string): string | null {
  if (!text.startsWith('{')) return null

  // 找一个「刚好结束一个完整值」的位置：字符串闭合处（且不是键名），或收尾括号处
  let inString = false
  let escaped = false
  let lastComplete = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        // 字符串闭合了，但它可能是「键名」而不是「值」——判据是紧跟其后是否冒号：
        //   "note": "..."  → 这里的 "note" 是键名，值还没写出来，不能算一个完整的值
        //   "slot": "morning", → 这里的 "morning" 是值，可以在此收尾
        // 这个区分很关键：漏掉它，截断在字符串中间时就会把 head 切在冒号后面，
        // 反而拼出一个仍然不完整的 JSON。
        let j = i + 1
        while (j < text.length && /\s/.test(text[j]!)) j++
        if (text[j] !== ':') lastComplete = i + 1
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '}' || ch === ']') lastComplete = i + 1
  }

  if (lastComplete <= 0) return null

  const head = text.slice(0, lastComplete).replace(/[,\s]+$/, '')
  const need = unclosedContainers(head)
  if (need === null) return null
  if (need.length === 0) return head

  // 开启顺序是反的，倒着补：{ 补 }，[ 补 ]
  return head + need.reverse().map((open) => (open === '{' ? '}' : ']')).join('')
}

/** 扫描文本里尚未闭合的 { [ 列表，按开启顺序返回；字符串没闭合时返回 null */
function unclosedContainers(text: string): string[] | null {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }

  return inString ? null : stack
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
