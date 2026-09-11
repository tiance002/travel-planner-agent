// 「换一个」：为行程里的某个条目找替换候选。
//
// 需求的原话是「用户看了评价后可能不满意，需要在可行的距离范围内找到替换的景点或饭店」。
// 这句话里有两个关键约束，决定了整个实现：
//
//   1. **可行距离** —— 不是「离得最近」，而是「换完之后，与前后两站的通勤都不能超时」。
//      原来那个点的位置是排程时反复调过通勤才定下来的，替换者必须也满足同样的约束，
//      否则修好一个点、坏了一条链。
//
//   2. **用户要看了评价才决策** —— 所以这里返回的是一个候选列表，附上评分、人均、
//      营业时间、与前后两站的通勤分钟数，让用户自己挑。不做「一键随机换一个」，
//      那种做法用户可能连点三次都不满意，体验比不换还差。

import { planRoute, searchPoiAround, straightLineDistance, type Poi } from '../amap'
import { MAX_COMMUTE_MINUTES } from './scheduler'
import { checkSlotHours, isRatingReject, type DayTypeBan } from './spot-rules'

/** 周边搜索的初始半径（米）。找不到足量候选时会逐级放大 */
const SEARCH_RADII = [1500, 3000, 5000]

/** 最多返回几个候选。太多用户挑不过来，太少又不够选 */
const MAX_CANDIDATES = 6

/** 判断一个 POI 是不是餐饮。与 scheduler 保持同一判据 */
function isRestaurantPoi(poi: Poi): boolean {
  return poi.typecode.startsWith('05') || poi.type.includes('餐饮')
}

/**
 * 一个候选地点连同它的通勤信息。
 * 通勤分钟数是真的调高德路径规划算的，不是直线距离换算的——
 * 直线距离在跨江、绕山的情况下会差出好几倍。
 */
export interface AlternativeCandidate {
  poiId: string
  name: string
  lng: number
  lat: number
  address: string | null
  rating: string | null
  cost: string | null
  tag: string | null
  typecode: string | null
  openTimeText: string | null
  photos: string[]
  distanceFromPrevKm: number
  commuteFromPrevMinutes: number | null
  commuteToNextMinutes: number | null
}

/** 查询替换候选需要的输入 */
export interface FindAlternativesInput {
  /** 要替换掉的那个条目 */
  target: Poi
  /** 目标在当前序列里的前一个点（可能是住宿锚点）。没有则传 null */
  previous: Poi | null
  /** 后一个点。没有则传 null */
  next: Poi | null
  /** 目标当前所在的时段，用于校验营业时间 */
  slot: string
  /** 整趟行程已经用过的 poiId，替换时要避开 */
  usedPoiIds: Set<string>
  /** 用户的天型黑名单，替换时也要尊重 */
  ban?: DayTypeBan
}

/**
 * 为某个条目找替换候选。
 *
 * 流程说明：
 *   ① 以「目标点」为圆心做周边搜索，半径从 1.5 公里逐步放大到 5 公里。
 *      为什么以目标点为圆心而不是以前一个点为圆心：用户的心智是「把这一站换个地方」，
 *      换成十公里外的点，整天的路线结构就变了，那已经不是「换一个」而是「重排一天」。
 *   ② 类型必须一致（景点换景点、餐厅换餐厅）。
 *   ③ 评分与营业时间过一遍校验，不把更差的地方推给用户。
 *   ④ 通勤真的算一遍：与前一个点、后一个点都要 ≤40 分钟。
 *      这是最贵的一步（每个候选两次路径规划），所以放在最后，
 *      前面的廉价筛选先把候选量压下来。
 *   ⑤ 按「通勤总时长」升序返回，最顺路的排最前面。
 */
export async function findAlternatives(
  input: FindAlternativesInput,
): Promise<AlternativeCandidate[]> {
  const wantRestaurant = isRestaurantPoi(input.target)
  const collect = new Map<string, Poi>()

  // 周边的关键词：餐厅用「美食」，景点不传关键词，靠 types 限定
  const keywords = wantRestaurant ? '美食' : undefined
  const types = wantRestaurant ? '050000' : '110000|140000|080000'

  for (const radius of SEARCH_RADII) {
    const pois = await searchPoiAround({
      lng: input.target.lng,
      lat: input.target.lat,
      keywords,
      types,
      radius,
      // 按权重排序：高德会综合评分与热度，比纯按距离排更可能有高分地点
      sortRule: 'weight',
      pageSize: 25,
    }).catch(() => [] as Poi[])

    for (const poi of pois) {
      if (collect.has(poi.poiId)) continue
      if (poi.poiId === input.target.poiId) continue
      if (input.usedPoiIds.has(poi.poiId)) continue
      // 类型必须一致
      if (isRestaurantPoi(poi) !== wantRestaurant) continue
      // 评分不达标的不要推给用户
      if (isRatingReject(poi, wantRestaurant)) continue
      // 营业时间与当前时段冲突的不要
      if (checkSlotHours(poi, input.slot, wantRestaurant).verdict === 'closed') continue
      // 用户勾了不爬山，就不要推爬山地点
      if (input.ban?.noHike && matchesHikeKeyword(poi)) continue

      collect.set(poi.poiId, poi)
    }

    // 攒够两倍于展示量的候选就停，留出被通勤筛掉后的余量
    if (collect.size >= MAX_CANDIDATES * 2) break
  }

  if (collect.size === 0) return []

  // 通勤体检：与前一个点、后一个点分别算真实路径时间。并发跑，省时间
  const candidates = [...collect.values()]
  const enriched = await Promise.all(
    candidates.map(async (poi) => {
      const [fromPrev, toNext] = await Promise.all([
        input.previous ? routeMinutes(input.previous, poi) : Promise.resolve<number | null>(null),
        input.next ? routeMinutes(poi, input.next) : Promise.resolve<number | null>(null),
      ])

      // 通勤超时的直接淘汰。null（算不出来）放行——路径服务偶尔会失败，
      // 不该因为一次网络抖动就把好地点筛掉
      if (fromPrev !== null && fromPrev > MAX_COMMUTE_MINUTES) return null
      if (toNext !== null && toNext > MAX_COMMUTE_MINUTES) return null

      return {
        poiId: poi.poiId,
        name: poi.name,
        lng: poi.lng,
        lat: poi.lat,
        address: poi.address || null,
        rating: poi.rating === null ? null : String(poi.rating),
        cost: poi.cost === null ? null : String(poi.cost),
        tag: poi.tag || poi.keytag || null,
        typecode: poi.typecode || null,
        openTimeText: poi.openTimeToday || null,
        photos: poi.photos.slice(0, 3),
        distanceFromPrevKm: input.previous
          ? Math.round(straightLineDistance(input.previous, poi) / 100) / 10
          : 0,
        commuteFromPrevMinutes: fromPrev,
        commuteToNextMinutes: toNext,
      } satisfies AlternativeCandidate
    }),
  )

  return enriched
    .filter((item): item is AlternativeCandidate => item !== null)
    // 按「两段通勤之和」升序：最顺路的排最前面。算不出来的当作 0，排在前面
    // （它们其实是最不确定的，但排后面用户根本看不到）
    .sort(
      (a, b) =>
        (a.commuteFromPrevMinutes ?? 0) +
        (a.commuteToNextMinutes ?? 0) -
        ((b.commuteFromPrevMinutes ?? 0) + (b.commuteToNextMinutes ?? 0)),
    )
    .slice(0, MAX_CANDIDATES)
}

/** 查询两点之间的驾车耗时（分钟）。失败时返回 null，不阻断流程 */
async function routeMinutes(from: Poi, to: Poi): Promise<number | null> {
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
    return null
  }
}

/** 兜底用的高强度地点判断 */
function matchesHikeKeyword(poi: Poi): boolean {
  const text = `${poi.name} ${poi.tag} ${poi.keytag} ${poi.type}`
  return /登山|徒步|索道|爬山|栈道|山顶|峡谷/.test(text)
}
