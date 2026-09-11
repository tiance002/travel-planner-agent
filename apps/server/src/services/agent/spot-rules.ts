// 地点的硬性规则表：评分、营业时间、天型判定。
//
// 为什么单独放一个文件：这些规则的共同点是「**只依赖高德返回的 POI 数据**，
// 不需要模型、不需要网络」，因此可以被生成流程、替换流程，以及未来的校验脚本
// 反复复用。放在 scheduler 里会和解析逻辑混在一起，改规则时要翻很长一段。
//
// 三条规则各自的取舍，都写在对应函数的注释里，这里先说一句话总纲：
// **宁可放行也不要误杀。** 高德的数据缺失率不低（评分常缺、营业时间常缺），
// 一刀切会把很多真正值得去的地方挡在门外，用户看到的是一份莫名其妙变短的行程。

import type { Poi } from '../amap'

// ---------------------------------------------------------------------------
// 评分规则
// ---------------------------------------------------------------------------

/** 景点评分下限。低于这个分数的游览类地点不安排 */
export const MIN_SPOT_RATING = 4

/**
 * 餐厅的评分下限放宽到 3.5。
 *
 * 为什么不与景点同标准：高德的餐厅评分整体偏低，一条街上 4.0 分以上的
 * 往往只有三五家，而用户一天要吃两顿。若餐厅也硬卡 4 分，很容易出现
 * 「这一天找不到餐厅」——整个生成流程会卡死在这一步。
 */
export const MIN_RESTAURANT_RATING = 3.5

/** 评分判定的三种结果 */
export type RatingVerdict =
  /** 通过：有评分且达到下限 */
  | 'ok'
  /** 通过但勉强：有评分但低于下限，仅在放宽模式下放行 */
  | 'low'
  /** 未知：高德没返回评分，放行但排在中间 */
  | 'unknown'
  /** 淘汰：明确低于下限 */
  | 'reject'

/**
 * 判断一个地点的评分是否可接受。
 *
 * 三种情况分开返回，是因为调用方对它们的处理不同：
 *   - ok / unknown：正常保留
 *   - low：只有在「放宽模式」（该区域确实找不到高分地点）下才保留，且要提示用户
 *   - reject：淘汰
 *
 * 注意评分缺失（null）绝不是淘汰理由。高德有大量 POI 没有评分，
 * 尤其是免费公园、新开的场馆；把它们全砍掉会误杀一批真正值得去的地方。
 */
export function checkRating(poi: Poi, isRestaurant: boolean): RatingVerdict {
  if (poi.rating === null || Number.isNaN(poi.rating)) return 'unknown'

  const floor = isRestaurant ? MIN_RESTAURANT_RATING : MIN_SPOT_RATING
  return poi.rating >= floor ? 'ok' : 'low'
}

/** 评分是否可以直接淘汰（不考虑放宽模式）。低分一律淘汰，未知放行 */
export function isRatingReject(poi: Poi, isRestaurant: boolean): boolean {
  return checkRating(poi, isRestaurant) === 'low'
}

/**
 * 从高德的营业时间文本里解析出「开门钟点」和「关门钟点」，单位是「距零点的分钟数」。
 *
 * 高德给出的格式花样很多，实测见过的有：
 *   "09:00-17:00"            标准
 *   "09:00 - 17:00"          带空格
 *   "08:30-17:30;17:30-21:00" 分时段（取首尾，覆盖全天大部分）
 *   "全天" / "24小时"         全天开放
 *   ""                       没有数据
 *
 * 返回 null 表示「无法判断」，调用方应当放行而不是淘汰。
 */
export function parseOpenHours(text: string): { open: number; close: number } | null {
  const raw = (text ?? '').trim()
  if (!raw) return null

  // 全天开放：给一个覆盖整天的窗口，让任何时段都能通过校验
  if (/全天|24\s*小时|全天开放/.test(raw)) return { open: 0, close: 24 * 60 }

  // 抓取所有 HH:MM 形式的时刻，按出现顺序取最小与最大
  const moments: number[] = []
  const pattern = /(\d{1,2})\s*[:：]\s*(\d{2})/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour >= 0 && hour <= 24 && minute >= 0 && minute < 60) {
      moments.push(hour * 60 + minute)
    }
  }

  if (moments.length === 0) return null
  if (moments.length === 1) {
    // 只有一个时刻，大概率是「09:00 起」这种写法，补一个默认的收摊时间
    return { open: moments[0], close: 22 * 60 }
  }

  // **不能取 min/max**：那会丢掉「谁在前、谁在后」的信息。
  // 例如 "18:00-02:00"（夜市跨夜），min 会得到 02:00 当成开门时间，
  // max 得到 18:00 当成关门时间，方向整个反了。
  // 正确做法是按出现顺序取：第一个是开门，最后一个是关门。
  const open = moments[0]
  let close = moments[moments.length - 1]

  // 跨夜的营业时间（例如 "18:00-02:00"）：关门时刻小于开门时刻时，
  // 把它视为次日凌晨，换算成「超过 24 点」的分钟数，这样与 evening 时段
  // （18:00-22:30）比较时才不会出错
  if (close <= open) close += 24 * 60

  return { open, close }
}

// ---------------------------------------------------------------------------
// 时段与营业时间的交叉校验
// ---------------------------------------------------------------------------

/**
 * 时段到钟点区间的映射。
 *
 * 为什么要有这张表：我们的排程是「时段级」的（上午/中午/下午/晚上），
 * 没有具体钟点，而营业时间是「钟点级」的。要把两者放到一起比，
 * 就必须给每个时段定一个代表性的时间窗。
 *
 * 取值依据是中国人自由行的常见节奏，宁可定宽一点：
 * 定窄了会把本来能去的地点误判为「去了就关门」。
 */
export const SLOT_WINDOWS: Record<string, { start: number; end: number; label: string }> = {
  morning: { start: 8 * 60 + 30, end: 12 * 60, label: '上午' },
  noon: { start: 12 * 60, end: 13 * 60 + 30, label: '中午' },
  afternoon: { start: 13 * 60 + 30, end: 18 * 60, label: '下午' },
  evening: { start: 18 * 60, end: 22 * 60 + 30, label: '晚上' },
}

/** 时段与营业时间至少要重叠这么久，才算「去了不是白跑」 */
export const MIN_OVERLAP_MINUTES = 60

/**
 * 剩余可玩时间少于这个数时，不算不合格，但要提醒用户「会比较仓促」。
 *
 * 为什么要用「剩余时长」而不是「重叠时长」做判据：
 * 重叠时长对下午来说天然很大（下午窗 13:30-18:00 有 4.5 小时），
 * 任何 17:00 关门的景点重叠都有 210 分钟，测不出「仓促」这个感觉。
 * 真正的感觉是「我 13:30 到，17:00 就关门，只剩 3 个半小时」——
 * 所以要算的是 `关门时刻 − 时段起始时刻`。
 *
 * 判据取 `剩余 <= 阈值` 而不是 `<`：博物馆 09:00-17:00 排下午，
 * 到达 13:30、关门 17:00，剩余正好 3.5 小时，这种「刚好差一点」的
 * 情况本意就是要提示仓促，用严格小于会从边界上漏掉。
 */
export const TIGHT_REMAINING_MINUTES = 210

export type HoursVerdict =
  /** 通过：剩余时间充足 */
  | 'ok'
  /** 通过但仓促：能玩，只是剩余时间偏短 */
  | 'tight'
  /** 未知：没有营业时间数据，放行 */
  | 'unknown'
  /** 淘汰：安排的这个时段它已经关门或还没开门 */
  | 'closed'

export interface HoursCheck {
  verdict: HoursVerdict
  /** 给用户看的可读说明，未知时为空 */
  detail: string
}

/**
 * 校验「某个地点安排在某个时段」是否合理。
 *
 * 判据是**重叠时长**而不是「完全包含」。原因：景点常常 09:00-17:00，
 * 而我们的「下午」时段是 13:30-18:00，永远不可能被完全包含——
 * 用「完全包含」做判据的话，几乎所有景点都会不合格。
 * 改成「重叠 ≥ 60 分钟」，语义就变成「去了至少能玩够一小时，不算白跑」。
 *
 * 在通过之后再看一眼「剩余时间」：如果到达时段起点后离关门不足 3.5 小时，
 * 说明能玩但仓促。这一档只提示不淘汰——用户可能就想进去看一眼。
 */
export function checkSlotHours(poi: Poi, slot: string, isRestaurant: boolean): HoursCheck {
  // 餐厅的营业时间不参与校验：高德给餐厅的营业时间最不准（很多小店根本不上报），
  // 而且用户本来就会挑自己想吃的那家。硬卡只会把正常行程卡死。
  if (isRestaurant) return { verdict: 'ok', detail: '' }

  const window = SLOT_WINDOWS[slot]
  if (!window) return { verdict: 'unknown', detail: '' }

  const hours = parseOpenHours(poi.openTimeToday)
  if (!hours) return { verdict: 'unknown', detail: '' }

  const overlapStart = Math.max(window.start, hours.open)
  const overlapEnd = Math.min(window.end, hours.close)
  const overlap = overlapEnd - overlapStart

  if (overlap < MIN_OVERLAP_MINUTES) {
    const label = window.label
    return {
      verdict: 'closed',
      detail: `「${poi.name}」营业时间为 ${poi.openTimeToday}，${label}去已经来不及玩`,
    }
  }

  // 到达这个时段后还能玩多久。时段的实际到达时间不早于开门时刻
  const arriveAt = Math.max(window.start, hours.open)
  const remaining = hours.close - arriveAt

  if (remaining <= TIGHT_REMAINING_MINUTES) {
    return {
      verdict: 'tight',
      detail: `「${poi.name}」营业至 ${formatMinutes(hours.close)}，${window.label}去只够玩一会儿`,
    }
  }

  return { verdict: 'ok', detail: '' }
}

/** 把「距零点的分钟数」格式化成 HH:MM。超过 24 点（跨夜）时按次日时间显示 */
function formatMinutes(value: number): string {
  const normalized = value % (24 * 60)
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 天型判定
// ---------------------------------------------------------------------------

/** 一天的行程体裁 */
export type DayType = 'normal' | 'theme_park' | 'hike' | 'night_hike' | 'recovery'

/** 一天的体力强度 */
export type Intensity = 'light' | 'medium' | 'heavy'

/** 各天型的默认强度 */
export const DAY_TYPE_INTENSITY: Record<DayType, Intensity> = {
  normal: 'medium',
  theme_park: 'heavy',
  hike: 'heavy',
  night_hike: 'heavy',
  recovery: 'light',
}

/**
 * 天型的景点数量上限。
 *
 * 原来的 MAX_SPOTS_PER_DAY = 3 是一个全局常量，但「大景区整天」和「爬山」
 * 这两种天型的结构就是「一整天玩这一个」，3 这个数字对它们没有意义。
 */
export function maxSpotsForDay(dayType: DayType): number {
  switch (dayType) {
    case 'theme_park':
    case 'hike':
    case 'night_hike':
      return 1
    case 'recovery':
      return 2
    default:
      return 3
  }
}

/**
 * 强制升级天型的关键词表。
 *
 * 为什么必须有这张表：模型对「这个景点能不能玩一整天」的判断不可靠，
 * 同一个园子可能今天判整天、明天判半天。这几个词的判断没有歧义，
 * 用规则锁死比信任模型稳。
 *
 * 只放「几乎不可能是半天行程」的地点，宁缺勿滥：
 * 表越长，误升级的风险越大。
 */
const THEME_PARK_PATTERNS = [
  /环球影城/,
  /迪士尼/,
  /欢乐谷/,
  /长隆/,
  /方特/,
  /融创乐园/,
  /海洋公园/,
  /海昌/,
  /影视城/,
  /世界之窗/,
  /欢乐世界/,
  /水上乐园/,
  /野生动物园/,
  /极地馆/,
]

/** 高强度徒步类关键词 */
const HIKE_PATTERNS = [
  /登山/,
  /徒步/,
  /索道/,
  /爬坡/,
  /山道/,
  /栈道/,
  /大峡谷/,
  /山峰/,
  /山顶/,
  /爬山/,
]

/** 明确指向「夜间爬山看日出」的关键词。优先级高于普通 hike */
const NIGHT_HIKE_PATTERNS = [
  /夜爬/,
  /日出/,
  /观日出/,
  /看日出/,
  /夜登/,
  /夜间登山/,
]

/** 一个地点的名称与标签拼成的可匹配文本 */
function matchText(poi: Poi): string {
  return `${poi.name} ${poi.tag} ${poi.keytag} ${poi.type}`
}

/** 命中主题乐园规则表时返回 true */
export function matchesThemePark(poi: Poi): boolean {
  const text = matchText(poi)
  return THEME_PARK_PATTERNS.some((pattern) => pattern.test(text))
}

/** 命中高强度徒步规则表时返回 true */
export function matchesHike(poi: Poi): boolean {
  const text = matchText(poi)
  return HIKE_PATTERNS.some((pattern) => pattern.test(text))
}

/** 命中夜爬/日出规则表时返回 true */
export function matchesNightHike(poi: Poi): boolean {
  const text = matchText(poi)
  return NIGHT_HIKE_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 用户在「额外需求」里可以勾选的天型黑名单。
 *
 * 这些开关的意义：用户说「我这次不想爬山」，那就不能让模型或规则表
 * 硬塞一个爬山日进来。作为硬性黑名单执行，优先级高于一切判定。
 */
export interface DayTypeBan {
  /** 不含爬山等高强度行程 */
  noHike?: boolean
  /** 不含主题乐园整天行程 */
  noThemePark?: boolean
  /** 不安排夜爬看日出 */
  noNightHike?: boolean
  /** 行程节奏轻松一些（所有天强度降为 light，景点上限降为 2） */
  relaxed?: boolean
}

/** 从用户的额外需求文本里识别出天型黑名单 */
export function parseDayTypeBan(extraNeeds: string[]): DayTypeBan {
  const joined = extraNeeds.join(' ')
  return {
    noHike: /不.*(爬山|高强度|徒步)|避免爬山|轻松.*不.*爬/.test(joined),
    noThemePark: /不.*(主题乐园|乐园|环球影城|迪士尼)|避免.*乐园/.test(joined),
    noNightHike: /不.*夜爬|不.*日出|避免.*夜爬/.test(joined),
    relaxed: /节奏.*轻松|轻松.*一些|不要太累|慢节奏|老人|孕|小孩.*小/.test(joined),
  }
}

/** 天型判定的输入 */
export interface ResolveDayTypeInput {
  /** 模型自己提议的天型（来自输出 JSON 的 dayStyle 字段） */
  proposed?: string
  /** 这一天最终留下的景点（已通过校验的） */
  spots: Poi[]
  /** 用户的额外需求黑名单 */
  ban?: DayTypeBan
}

/**
 * 判定某一天的天型。策略是「模型提议 + 规则兜底」，外加一道用户黑名单：
 *
 *   ① 规则表**强制升级**：命中夜爬 → night_hike；命中主题乐园 → theme_park；
 *      命中高强度徒步 → hike。这一步优先级最高，因为这几个词的判断没有歧义。
 *   ② 模型提议的合法性校验：
 *      - 说 theme_park 但这一天排了 ≥2 个景点 → 降级 normal
 *        （防止模型嘴上说整天、手上排了仨地方）
 *      - 说 hike / night_hike 但没选中相应强度的地点 → 降级 normal
 *      - 什么都没命中 → normal
 *   ③ 用户的额外需求黑名单**最后统一拦截**：不管上面的结果来自规则表还是模型，
 *      只要用户说了「不爬山」「不要主题乐园整天」「不夜爬」，一律降级为 normal。
 *
 * 第 ③ 步为什么放在最后而不是中间：早先的实现把黑名单只挂在「规则表强制升级」
 * 那条分支上，结果出现了一个漏洞——如果**模型自己**提议了 hike（而规则表因为
 * 关键词没覆盖全没有强制升级），黑名单就完全失效了。用户明确说了不想爬山，
 * 系统却还是排了爬山，这是不能接受的。所以黑名单必须是所有路径的统一出口。
 */
export function resolveDayType(input: ResolveDayTypeInput): {
  dayType: DayType
  warnings: string[]
} {
  const warnings: string[] = []
  const ban = input.ban ?? {}
  const spots = input.spots

  // ---- ① 规则表强制升级（按优先级：夜爬 > 主题乐园 > 徒步） ----
  const nightHikeHit = spots.find((poi) => matchesNightHike(poi))
  const themeParkHit = spots.find((poi) => matchesThemePark(poi))
  const hikeHit = spots.find((poi) => matchesHike(poi))

  let dayType: DayType = 'normal'

  if (nightHikeHit) dayType = 'night_hike'
  else if (themeParkHit) dayType = 'theme_park'
  else if (hikeHit) dayType = 'hike'

  if (dayType !== 'normal') {
    if (dayType === 'theme_park' && spots.length > 1) {
      warnings.push(`主题乐园整天行程只安排「${themeParkHit?.name ?? ''}」一个地点，其余已略去`)
    }
    if (dayType === 'hike') {
      warnings.push(`这一天以「${hikeHit?.name ?? ''}」为主，强度较大，已按整天行程安排`)
    }
    if (dayType === 'night_hike') {
      warnings.push(`这一天安排了夜爬看日出，白天以休整为主，次日会相应放轻松`)
    }
  }

  // ---- ② 规则表没命中时，看模型自己的提议 ----
  if (dayType === 'normal') {
    const proposed = (input.proposed ?? '').trim() as DayType
    const valid: DayType[] = ['normal', 'theme_park', 'hike', 'night_hike', 'recovery']
    if (valid.includes(proposed) && proposed !== 'normal') {
      if (proposed === 'theme_park' && spots.length > 1) {
        warnings.push('模型想把这一天当作主题乐园整天安排，但排了多个地点，已按常规一天处理')
      } else if ((proposed === 'hike' || proposed === 'night_hike') && !hikeHit) {
        warnings.push('模型把这一天标为高强度行程，但没有选中相应强度的地点，已按常规一天处理')
      } else {
        // 模型提议被采纳。注意 recovery 只能由系统在跨天传导时给出，
        // 模型自己说 recovery 也认（它可能是判断出这天该轻一点），但会给个提示
        dayType = proposed
        if (proposed === 'recovery') {
          warnings.push('模型把这一天安排为恢复日，节奏会放缓')
        }
      }
    }
  }

  // ---- ③ 用户黑名单统一拦截 ----
  const blocked =
    (dayType === 'night_hike' && (ban.noNightHike || ban.noHike)) ||
    (dayType === 'theme_park' && ban.noThemePark) ||
    (dayType === 'hike' && ban.noHike)

  if (blocked) {
    const label =
      dayType === 'theme_park' ? '主题乐园整天行程' : dayType === 'night_hike' ? '夜爬看日出' : '全天徒步'
    warnings.push(
      `${spots[0]?.name ? `「${spots[0].name}」原本适合安排成${label}，但` : ''}你选择了不安排这类行程，已按常规一天安排`,
    )
    return { dayType: 'normal', warnings }
  }

  // 恢复日只能由系统在跨天传导时给出，模型提议的已在上一步处理。
  // 这里额外兜一道：如果用户勾了「节奏轻松」，恢复日的强度会在 resolveIntensity 里再压一次
  return { dayType, warnings }
}

/**
 * 把天型与用户偏好合成最终的强度。
 *
 * 「节奏轻松一些」这个开关的作用就在这一步：不管原来是什么强度，
 * 都压到 light，并且景点上限降为 2。
 */
export function resolveIntensity(dayType: DayType, ban: DayTypeBan = {}): Intensity {
  if (ban.relaxed) return 'light'
  return DAY_TYPE_INTENSITY[dayType]
}
