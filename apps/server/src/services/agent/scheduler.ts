// 排程规则的校验与修正。
//
// 为什么规则要写在代码里而不是提示词里：
//   提示词像是在便签纸上写「请勿迟到」，靠的是自觉；代码则是门禁闸机，不刷卡就进不去。
//   模型偶尔会多排一个景点、把餐厅放到第一个、或者把两个相隔 20 公里的点排在一起，
//   这些都由这一层拦住并修正，而不是返回给用户一份「看起来没错」的行程。
//
// 本文件负责四件事：
//   1. 把模型输出的文本解析成结构（容错处理 Markdown 代码块、多余引号、截断等各种失手）
//   2. 校验每个地点的 poiId 确实来自工具返回，坐标一律以服务端登记表为准
//   3. 修正一天之内的顺序与数量：景点 ≤ 3，餐厅夹在景点之间；跨天去重
//   4. 体检真实通勤时间，超过 40 分钟的相邻点尝试替换
//
// 粒度是「一天」而不是「整趟行程」：生成本身就是一天一次请求，
// 校验跟着对齐，某一天排坏了能立刻发现，不必等所有天都跑完。

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

/** 单天校验的产出 */
export interface DayValidation {
  day: PlannedDay
  /** 校验过程中发现并处理过的问题，存进日志便于排查，也用于给用户提示 */
  warnings: string[]
}

/** 校验单天时的可选项 */
export interface ValidateDayOptions {
  /** 前几天已经用过的 poiId。跨天去重要靠它，免得第 2 天又把第 1 天的景点排一遍 */
  usedPoiIds?: Set<string>
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
 * 解析失败时抛出。比普通的 Error 多带几个信息，方便上层决定怎么补救：
 *   - truncated：是不是「话没说完」被截断了（对应重新输出时要它缩短篇幅）
 *   - snippet：原文尾部，便于在日志里一眼看出写到哪
 *   - fragment：出错位置附近的原文，回传给模型让它知道该改哪里
 */
export class PlanParseError extends Error {
  readonly truncated: boolean
  readonly snippet: string
  readonly fragment: string

  constructor(
    message: string,
    detail: { truncated: boolean; snippet: string; fragment?: string },
  ) {
    super(message)
    this.name = 'PlanParseError'
    this.truncated = detail.truncated
    this.snippet = detail.snippet
    this.fragment = detail.fragment ?? ''
  }
}

/**
 * 把模型返回的文本解析成 JSON。
 *
 * 模型输出失手的花样比想象中多。这里按「修复力度由轻到重」逐级尝试，
 * 能救回的都救回，救不了的才抛错。之所以这么不遗余力：
 * 一次失败的代价是用户白白等上几十秒、几十次高德查询全部作废，
 * 而多试几种解析的代价只有几毫秒。
 *
 * 修复阶梯：
 *   ① 原样解析 —— 剥掉 Markdown 代码块和前后废话后直接 parse，覆盖绝大多数情况
 *   ② 修转义与尾逗号 —— 字符串里有裸换行、对象末尾多了个逗号
 *   ③ 引号级定向修复 —— 值后面凭空多一个引号，或两个字段之间漏了逗号
 *   ④ 截断补全 —— 写到一半撞上长度上限，退回最后一个完整值再补齐括号
 *   ⑤ 全角逗号归一 —— 模型拿中文逗号当字段分隔符
 */
export function parsePlanJson(text: string): RawPlan {
  const raw = text ?? ''
  const cleaned = stripWrappers(raw)
  const scan = extractJsonObject(cleaned)

  if (scan.text) {
    // ① 原样
    const direct = tryParse(scan.text)
    if (direct) return direct

    // ② 修未转义的控制字符与多余的尾逗号
    const repaired = stripTrailingCommas(escapeControlCharsInStrings(scan.text))
    const afterRepair = tryParse(repaired)
    if (afterRepair) return afterRepair

    // ③ 引号级定向修复（多余的引号 / 漏掉的逗号），可连续修多处
    const byFeedback = repairWithParserFeedback(repaired)
    if (byFeedback) return byFeedback

    // ④ 截断补全；截断往往还伴随引号问题，所以补完再修一遍
    const patched = closeTruncatedJson(repaired)
    if (patched) {
      const afterPatch = tryParse(patched)
      if (afterPatch) return afterPatch
      const quotedPatch = repairWithParserFeedback(patched)
      if (quotedPatch) return quotedPatch
    }

    // ⑤ 全角逗号当分隔符，再配合前两种修复
    const normalized = stripTrailingCommas(normalizeFullWidthSeparators(scan.text))
    const afterNormalize = tryParse(normalized)
    if (afterNormalize) return afterNormalize
    const quotedNormalize = repairWithParserFeedback(normalized)
    if (quotedNormalize) return quotedNormalize
  }

  throw new PlanParseError(
    scan.text
      ? '模型输出的 JSON 无法解析'
      : '模型没有按要求输出 JSON（回复里找不到 JSON 对象）',
    {
      truncated: !scan.closed,
      snippet: raw.slice(-300),
      fragment: describeFailure(scan.text ?? cleaned),
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

/**
 * 按「解析器反馈」逐处修复 JSON 结构。
 *
 * 这是对付模型手滑的主力手段。真实观察到的一类毛病长这样：
 *   {"poiId":"B000A8XAW9"","itemType":"spot",…}
 *                        ↑ 值以数字结尾时，后面凭空多出一个引号
 * 一份回复里能连出六处。一个多余的引号会让其后所有引号的「开/关」配对
 * 整体错位，整段 JSON 报废，而且**报错位置可能离真正出错的地方很远**。
 *
 * 思路：不自己写解析器，而是**借 JSON.parse 当探子**——
 * 它会在报错里给出出错的下标，那正是结构出问题的地方。我们只在那里做一个小判断：
 *
 *   - 若这个引号后面（配对之后）紧跟冒号 → 它是个键名，说明前面漏了逗号 → 补一个逗号
 *   - 否则 → 这个引号本身是多余的 → 删掉它
 *
 * 改完重新交给 JSON.parse 验收，不行就再来一轮。能处理「一处」也能处理「六处」，
 * 因为每轮只动一个字符、每轮都有解析器把关。
 */
function repairWithParserFeedback(text: string): RawPlan | null {
  /** 最多修多少处。设个上限，防止在畸形文本上空转 */
  const MAX_ROUNDS = 50
  let current = text

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const parsed = tryParse(current)
    if (parsed) return parsed

    const position = locateParseError(current)
    if (position === null) return null

    // 只处理「引号」这一类毛病，其余情况交给修复阶梯上的其它步骤
    if (current[position] !== '"') return null

    const end = findStringEnd(current, position)
    if (end === -1) return null
    const isKey = nextNonSpaceChar(current, end + 1) === ':'

    const repaired = isKey
      ? `${current.slice(0, position)},${current.slice(position)}`
      : current.slice(0, position) + current.slice(position + 1)

    if (repaired === current) return null
    current = repaired
  }

  return null
}

/** 让 JSON.parse 报出出错位置；取不到（例如「输入意外结束」）返回 null */
function locateParseError(text: string): number | null {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const match = /position (\d+)/.exec(message)
    return match ? Number(match[1]) : null
  }
}

/** 从 startIndex 处的引号开始，找与之配对的结束引号的下标；找不到返回 -1 */
function findStringEnd(text: string, startIndex: number): number {
  for (let i = startIndex + 1; i < text.length; i++) {
    if (text[i] === '"' && !isEscapedAt(text, i)) return i
  }
  return -1
}

/** 判断某个位置的字符是否被反斜杠转义（前面连续奇数个反斜杠即为转义） */
function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/** 取 index 之后最近的一个非空白字符，没有则返回空串 */
function nextNonSpaceChar(text: string, index: number): string {
  for (let i = index; i < text.length; i++) {
    const ch = text[i]!
    if (!/\s/.test(ch)) return ch
  }
  return ''
}

/**
 * 把「当前处于字段分隔位置」的中文全角逗号换成英文半角逗号。
 *
 * 中文输入法下模型偶尔会用「，」当字段分隔符。判断「处于分隔位置」的依据是：
 * 前面是一个已结束的值（引号、括号或数字），后面紧跟一个新的键名引号。
 * 这样就不会误伤字符串正文里的中文逗号——那里的逗号前面是汉字。
 */
function normalizeFullWidthSeparators(text: string): string {
  return text.replace(/(["\]\}\d])\s*，\s*(?=")/g, '$1,')
}

/** 从 JSON.parse 的报错里提取位置，截取附近原文，用于回传给模型 */
function describeFailure(text: string): string {
  try {
    JSON.parse(text)
    return ''
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const match = /position (\d+)/.exec(message)
    if (!match) return ''
    const position = Number(match[1])
    const from = Math.max(0, position - 40)
    const to = Math.min(text.length, position + 40)
    return `${message}\n…${text.slice(from, to)}…`
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

  // 每个景点后面最多跟一家餐厅，形成「景点 → 餐饮 → 景点 → 餐饮」的交替节奏。
  //
  // 为什么不用「把餐厅均分到各个空隙」的算法：那种写法在「2 个景点 + 2 家餐厅」时
  // 算出的空隙数是 1，两家餐厅会**一起挤在同一个空隙里**，结果就是同一天出现
  // 两家连排的午餐（实测出现过）。改成「一个景点后面最多一家」之后，
  // 从结构上就不可能连排，也不需要在事后检查。
  // 最后一个景点之后的那家算晚餐，其余算午餐。
  spots.forEach((spot, index) => {
    result.push({ poi: spot.poi, note: spot.note, slot: spotSlots[index] ?? 'evening' })

    const restaurant = restaurants.shift()
    if (!restaurant) return
    const isLastSpot = index === spots.length - 1
    result.push({
      poi: restaurant.poi,
      note: restaurant.note,
      slot: isLastSpot ? 'evening' : 'noon',
    })
  })

  // 景点数量之外的餐厅没有合法位置可放（放哪都会和另一家连排），
  // 保留在 restaurants 里由调用方记账并提示，不硬塞进结果
  return result
}

/**
 * 从模型的输出里取出「这一天」。
 *
 * 兼容三种写法，都是实际可能遇到的：
 *   - 标准写法：{ summary, items }
 *   - 多包一层：{ days: [ { summary, items } ] }（模型习惯性地按整天输出）
 *   - 多写了 dayIndex：{ dayIndex: 2, summary, items }
 * 只要 items 是数组就认，多出来的字段直接忽略，不为此报错——
 * 我们的目标是拿到安排，不是跟模型的格式洁癖较劲。
 */
function extractRawDay(raw: RawPlan): RawDay | null {
  if (Array.isArray(raw.days)) {
    const first = (raw.days as RawDay[])[0]
    return first && typeof first === 'object' ? first : null
  }

  const self = raw as RawDay
  return Array.isArray(self.items) ? self : null
}

/**
 * 校验并修正模型给出的**某一天**的安排。
 *
 * 传入的登记表是唯一可信来源：模型提到但没在表里的 poiId 一律丢弃。
 * 之所以按天调用而不是一次校验整趟行程，是因为现在生成本身就是一天一次，
 * 校验粒度跟着对齐，能立刻发现「这一天排坏了」而不必等到全部跑完。
 */
export function validateDay(
  raw: RawPlan,
  registry: Map<string, Poi>,
  dayIndex: number,
  options: ValidateDayOptions = {},
): DayValidation {
  const warnings: string[] = []
  const rawDay = extractRawDay(raw)
  if (!rawDay) {
    throw new Error('模型没有给出这一天的地点安排')
  }

  const rawItems = Array.isArray(rawDay.items) ? (rawDay.items as RawItem[]) : []
  const collected: { poi: Poi; note: string }[] = []

  for (const rawItem of rawItems) {
    const poiId = typeof rawItem.poiId === 'string' ? rawItem.poiId : ''
    const poi = registry.get(poiId)

    if (!poi) {
      // 这就是「模型编造地点」的拦截点
      warnings.push(`第 ${dayIndex} 天有一个地点不在候选列表中（poiId：${poiId || '缺失'}），已丢弃`)
      continue
    }

    // 同一天不重复安排同一个地点
    if (collected.some((c) => c.poi.poiId === poi.poiId)) {
      warnings.push(`第 ${dayIndex} 天重复安排了「${poi.name}」，已去重`)
      continue
    }

    // 跨天去重：前几天已经去过的地方，今天不必再去
    if (options.usedPoiIds?.has(poi.poiId)) {
      warnings.push(`第 ${dayIndex} 天重复推荐了前面几天去过的「${poi.name}」，已丢弃`)
      continue
    }

    collected.push({
      poi,
      note: typeof rawItem.note === 'string' ? rawItem.note.slice(0, 200) : '',
    })
  }

  // 这时 collected 里已经全是「可信且未重复」的地点，记进已用集合，
  // 后续换点时就能避开今天剩余的位置
  for (const entry of collected) options.usedPoiIds?.add(entry.poi.poiId)

  // 截断超量的游览地点。餐厅不计入上限，所以先按类型分开数
  const spotCount = collected.filter((c) => !isRestaurant(c.poi)).length
  if (spotCount > MAX_SPOTS_PER_DAY) {
    let keptSpots = 0
    const trimmed = collected.filter((c) => {
      if (isRestaurant(c.poi)) return true
      keptSpots += 1
      return keptSpots <= MAX_SPOTS_PER_DAY
    })
    warnings.push(`第 ${dayIndex} 天原本安排了 ${spotCount} 个景点，已按规则裁剪到 ${MAX_SPOTS_PER_DAY} 个`)
    collected.length = 0
    collected.push(...trimmed)
  }

  const summary =
    typeof rawDay.summary === 'string' && rawDay.summary.trim()
      ? rawDay.summary.trim().slice(0, 120)
      : ''

  const arranged = arrangeDay(collected)
  if (arranged.length === 0) {
    if (collected.length > 0) {
      warnings.push(`第 ${dayIndex} 天只有餐厅、没有景点，已清空（餐厅不会单独占一天）`)
    }
    return { day: { dayIndex, summary, items: [] }, warnings }
  }

  // 餐厅比景点还多时，多出来的那几家没有合法位置——放哪都会和另一家连排，
  // 只能略去。这里如实说明，免得用户以为推荐里本来就没有。
  const keptRestaurants = arranged.filter((entry) => isRestaurant(entry.poi)).length
  const droppedRestaurants =
    collected.filter((entry) => isRestaurant(entry.poi)).length - keptRestaurants
  if (droppedRestaurants > 0) {
    warnings.push(
      `第 ${dayIndex} 天的餐厅数量多于景点数量，${droppedRestaurants} 家会与前后的餐厅挨在一起，已略去`,
    )
  }

  const items = arranged.map((entry, index) =>
    toPlannedItem(entry.poi, entry.note, entry.slot, index + 1),
  )

  // 记进已用集合，供跨天去重与换点使用。
  // 只记最终留下的：被裁掉的候选（例如第 4 个景点）不算「去过」，
  // 后面几天若想用它当替代，仍然允许。
  for (const item of items) options.usedPoiIds?.add(item.poiId)

  return { day: { dayIndex, summary, items }, warnings }
}

/**
 * 从模型的输出里取出住宿锚点，并核对它确实来自登记表。
 * 核对不过返回 null，由调用方给出可读的失败原因。
 */
export function resolveAnchorFromRaw(
  raw: RawPlan,
  registry: Map<string, Poi>,
): { poi: Poi; reason: string } | null {
  const stayPoiId = typeof raw.stay?.poiId === 'string' ? raw.stay.poiId : ''
  const poi = registry.get(stayPoiId)
  if (!poi) return null

  return {
    poi,
    reason: typeof raw.stay?.reason === 'string' ? raw.stay.reason.slice(0, 200) : '',
  }
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
 * 通勤体检：把相邻两点之间的真实车程算出来，超过阈值的换点。
 *
 * 传入的 days 通常只有一天——逐天生成时，每排完一天就单独体检一次，
 * 这样问题能在当天暴露，而不是等整趟行程都排完。
 *
 * 换点策略：从候选池里找一个比原地点离「上一个点」更近的替代者。
 * 不做全局最优搜索——那会把运行时间拉长到用户等不起，够用就好。
 *
 * 返回这一批天里产生的提示信息（原先是写进 plan.warnings，现在由调用方决定怎么用）。
 */
export async function optimizeCommute(
  days: PlannedDay[],
  registry: Map<string, Poi>,
  report: (text: string) => void,
  /** 这几天之外已经用过的 poiId（例如前几天已落库的），换点时要一并避开 */
  excludedPoiIds: Set<string> = new Set(),
): Promise<string[]> {
  const warnings: string[] = []
  const usedPoiIds = new Set<string>(excludedPoiIds)
  for (const day of days) {
    for (const item of day.items) usedPoiIds.add(item.poiId)
  }

  // 进度文案的分母：相邻点对的总数
  const total = days.reduce((sum, day) => sum + Math.max(day.items.length - 1, 0), 0)
  let checked = 0

  for (const day of days) {
    for (let index = 1; index < day.items.length; index++) {
      const previous = day.items[index - 1]
      const current = day.items[index]
      checked += 1
      if (total > 0) report(`正在核对通勤路线（${checked}/${total}）`)

      const minutes = await commuteMinutes(
        asPoi(previous),
        asPoi(current),
      )
      current.commuteMinutes = minutes

      if (minutes === null || minutes <= MAX_COMMUTE_MINUTES) continue

      // 超时了，看看能不能换个更近的地点
      const replacement = pickReplacement(asPoi(previous), asPoi(current), registry, usedPoiIds)
      if (!replacement) {
        warnings.push(
          `第 ${day.dayIndex} 天「${previous.name}」到「${current.name}」需要约 ${minutes} 分钟，` +
            `超过 ${MAX_COMMUTE_MINUTES} 分钟且没有更合适的替代地点，请留意`,
        )
        continue
      }

      const replacementMinutes = await commuteMinutes(asPoi(previous), replacement)
      if (replacementMinutes !== null && replacementMinutes > MAX_COMMUTE_MINUTES) {
        warnings.push(
          `第 ${day.dayIndex} 天「${previous.name}」到「${current.name}」需要约 ${minutes} 分钟，` +
            `已替换为「${replacement.name}」仍需 ${replacementMinutes} 分钟，建议当天减少一个地点`,
        )
      } else {
        warnings.push(
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

  return warnings
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
