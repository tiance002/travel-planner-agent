// POI 形状转换的唯一事实来源。
//
// 背景（见审查报告 5.3）：
//   项目里存在至少三份「把数据库/行程条目还原成 POI 形状」的实现：
//     - routes/trips.ts 的 toPoiShape
//     - graph-run.ts 的 loadStayPoi 内手工构造
//     - scheduler.ts 的 asPoi
//   还有一处「住宿锚点 → POI」的构造散在 trips.ts 的 alternatives 接口里。
//   它们的字段填充规则并不完全一致（比如有的把 rating 填 null、有的填 ''），
//   导致替换候选筛选、通勤计算拿到的数据形状不同，出现难查的行为差异。
//
// 本文件把四类转换集中到这里：
//   poiFromTripItem    —— 数据库 TripItem → Poi（最常用：换点、通勤计算）
//   poiFromStay        —— Trip 的住宿锚点字段 → Poi
//   poiFromPlannedItem —— PlannedDay 的条目 → Poi
//   plannedItemFromPoi —— Poi → PlannedDay 条目（换点后写回）
//
// 一条硬约定：**坐标只能来自高德**。所有转换都不编造 lng/lat，
// 缺坐标时返回 null 交给调用方决定是拒绝还是跳过。

import type { Poi } from '../services/amap'
import type { PlannedDay } from '../services/agent/scheduler'

/** 住宿锚点在数据库里的四个字段（Trip 的 stay* 列） */
export interface StayFields {
  stayResolved: boolean
  stayPoiId: string | null
  stayName: string | null
  stayLng: number | null
  stayLat: number | null
}

/** 数据库 TripItem 中参与 POI 还原的字段 */
export interface TripItemPoiFields {
  poiId: string | null
  name: string
  lng: number | null
  lat: number | null
  address: string | null
  tel: string | null
  rating: string | null
  cost: string | null
  tag: string | null
  typecode: string | null
  openTimeText: string | null
  photos: string | null
}

/** 数据库 TripItem → Poi。缺 poiId 或坐标时返回 null（不可参与路径计算） */
export function poiFromTripItem(item: TripItemPoiFields): Poi | null {
  if (!item.poiId || item.lng === null || item.lat === null) return null
  return {
    poiId: item.poiId,
    name: item.name,
    lng: item.lng,
    lat: item.lat,
    address: item.address ?? '',
    type: '',
    typecode: item.typecode ?? '',
    cityName: '',
    district: '',
    adcode: '',
    rating: item.rating === null ? null : Number(item.rating),
    cost: item.cost === null ? null : Number(item.cost),
    tag: item.tag ?? '',
    keytag: '',
    openTimeToday: item.openTimeText ?? '',
    openTimeWeek: '',
    tel: item.tel ?? '',
    photos: [],
    distance: null,
  }
}

/**
 * Trip 的住宿锚点字段 → Poi。
 *
 * 展开成完整 Poi 形状只是为了喂给通勤计算，所以除坐标与 poiId 外的字段可以留空。
 * 未确定住宿（stayResolved=false）或缺坐标时返回 null。
 */
export function poiFromStay(stay: StayFields): Poi | null {
  if (
    !stay.stayResolved ||
    !stay.stayPoiId ||
    stay.stayLng === null ||
    stay.stayLng === undefined ||
    stay.stayLat === null ||
    stay.stayLat === undefined
  ) {
    return null
  }
  return {
    poiId: stay.stayPoiId,
    name: stay.stayName ?? '住宿',
    lng: stay.stayLng,
    lat: stay.stayLat,
    address: '',
    type: '住宿服务',
    typecode: '100000',
    cityName: '',
    district: '',
    adcode: '',
    rating: null,
    cost: null,
    tag: '',
    keytag: '',
    openTimeToday: '',
    openTimeWeek: '',
    tel: '',
    photos: [],
    distance: null,
  }
}

/** PlannedDay 的条目 → Poi。缺坐标时返回 null */
export function poiFromPlannedItem(item: PlannedDay['items'][number]): Poi | null {
  if (item.lng === null || item.lat === null) return null
  return {
    poiId: item.poiId,
    name: item.name,
    lng: item.lng,
    lat: item.lat,
    address: item.address ?? '',
    type: '',
    typecode: item.typecode ?? '',
    cityName: '',
    district: '',
    adcode: '',
    rating: item.rating === null ? null : Number(item.rating),
    cost: item.cost === null ? null : Number(item.cost),
    tag: item.tag ?? '',
    keytag: '',
    openTimeToday: item.openTimeText ?? '',
    openTimeWeek: '',
    tel: item.tel ?? '',
    photos: item.photos ?? [],
    distance: null,
  }
}

/**
 * Poi → PlannedDay 的条目。
 *
 * 用于「通勤体检换点」：选中替代地点后把它写成行程条目。
 * note / slot / orderIndex 由调用方保留原条目的值——换点不该改变
 * 这一站的位置语义与推荐理由。
 *
 * 字段类型严格对齐 scheduler 的 PlannedItem：address/tel/tag/openTimeText
 * 在这套模型里都是非空字符串（数据库那边允许 null，写库时再转）。
 * 这条约定保证了「替换后的条目」与「模型直接产出的条目」形状一致，
 * 下游的校验与展示不必区分两种来源。
 */
export function plannedItemFromPoi(
  poi: Poi,
  note: string,
  slot: string,
  orderIndex: number,
): PlannedDay['items'][number] {
  return {
    orderIndex,
    slot,
    itemType: /餐饮|美食|餐厅/.test(`${poi.type} ${poi.typecode}`) ? 'restaurant' : 'spot',
    poiId: poi.poiId,
    name: poi.name,
    lng: poi.lng,
    lat: poi.lat,
    address: poi.address ?? '',
    tel: poi.tel ?? '',
    rating: poi.rating === null ? null : String(poi.rating),
    cost: poi.cost === null ? null : String(poi.cost),
    tag: poi.tag || poi.keytag || '',
    typecode: poi.typecode ?? '',
    openTimeText: poi.openTimeToday ?? '',
    note,
    photos: poi.photos.slice(0, 3),
    commuteMinutes: null,
  }
}
