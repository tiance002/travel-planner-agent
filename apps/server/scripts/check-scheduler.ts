// 排程规则的自检脚本。
//
// 每天生成完都要过一遍这些规则：地点必须来自登记表、景点不超过 3 个、
// 餐厅夹在景点之间不连排、跨天不重复。这些是「已经冻结的产品决策」，
// 不该因为某次重构而悄悄失效，所以固化成用例，改代码前先跑一遍。
//
// 用法（二选一）：
//   在项目根目录：npm run check:scheduler
//   在 apps/server 目录：npx tsx scripts/check-scheduler.ts

import type { Poi } from '../src/services/amap'
import { validateDay, type RawPlan } from '../src/services/agent/scheduler'

/** 造一个假 POI。typecode 以 05 开头即被判定为餐饮 */
function poi(poiId: string, name: string, typecode = '110000'): Poi {
  return {
    poiId,
    name,
    lng: 120.15,
    lat: 30.25,
    address: `${name}的地址`,
    type: '风景名胜',
    typecode,
    cityName: '杭州',
    district: '西湖区',
    adcode: '330100',
    rating: 4.5,
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

const SPOT1 = poi('P001', '断桥残雪')
const SPOT2 = poi('P002', '苏堤')
const SPOT3 = poi('P003', '雷峰塔')
const SPOT4 = poi('P004', '灵隐寺')
const FOOD1 = poi('R001', '楼外楼', '050100')
const FOOD2 = poi('R002', '外婆家', '050100')

const registry = new Map<string, Poi>(
  [SPOT1, SPOT2, SPOT3, SPOT4, FOOD1, FOOD2].map((item) => [item.poiId, item]),
)

/** 构造一条单天的模型输出 */
function day(rawItems: { poiId: string; itemType?: string; slot?: string; note?: string }[]) {
  return { summary: '测试用的一天', items: rawItems } as RawPlan
}

interface Case {
  name: string
  raw: unknown
  /** 前几天已用过的 poiId，用于验证跨天去重 */
  usedPoiIds?: string[]
  /** 期望最终保留的条目名（按顺序）；null 表示期望抛错 */
  expect: string[] | null
}

const cases: Case[] = [
  {
    name: '标准单天：景点 → 餐厅 → 景点',
    raw: day([
      { poiId: 'P001', slot: 'morning' },
      { poiId: 'R001', slot: 'noon' },
      { poiId: 'P002', slot: 'afternoon' },
    ]),
    expect: ['断桥残雪', '楼外楼', '苏堤'],
  },

  {
    name: '模型仍按旧格式多包一层 days',
    raw: { days: [{ summary: '', items: [{ poiId: 'P001' }] }] },
    expect: ['断桥残雪'],
  },

  {
    name: '景点超过 3 个，裁到 3 个',
    raw: day([{ poiId: 'P001' }, { poiId: 'P002' }, { poiId: 'P003' }, { poiId: 'P004' }]),
    expect: ['断桥残雪', '苏堤', '雷峰塔'],
  },

  {
    name: '跨天去重：昨天去过的不再排',
    raw: day([{ poiId: 'P001' }, { poiId: 'P002' }]),
    usedPoiIds: ['P001'],
    expect: ['苏堤'],
  },

  {
    name: '编造的地点（不在登记表里）被丢弃',
    raw: day([{ poiId: 'FAKE_ID' }, { poiId: 'P002' }]),
    expect: ['苏堤'],
  },

  {
    name: '只有餐厅、没有景点，整天清空',
    raw: day([{ poiId: 'R001' }, { poiId: 'R002' }]),
    expect: [],
  },

  {
    name: '餐厅多于景点，多出来的略去（不连排）',
    raw: day([{ poiId: 'P001' }, { poiId: 'R001' }, { poiId: 'R002' }]),
    expect: ['断桥残雪', '楼外楼'],
  },

  {
    name: '同一天重复同一个地点，去重',
    raw: day([{ poiId: 'P001' }, { poiId: 'P001' }, { poiId: 'P002' }]),
    expect: ['断桥残雪', '苏堤'],
  },

  {
    name: '没有 items 字段，判定为模型没给安排',
    raw: { summary: '今天随便走走' },
    expect: null,
  },
]

let pass = 0
const failures: string[] = []

for (const item of cases) {
  const used = new Set(item.usedPoiIds ?? [])
  let got: string[] | null = null

  try {
    const { day: planned } = validateDay(item.raw as RawPlan, registry, 1, { usedPoiIds: used })
    got = planned.items.map((entry) => entry.name)
  } catch {
    got = null
  }

  const ok = JSON.stringify(got) === JSON.stringify(item.expect)
  if (ok) {
    pass += 1
    console.log(`  ✓ ${item.name}`)
  } else {
    failures.push(`${item.name}\n      期望：${JSON.stringify(item.expect)}\n      实际：${JSON.stringify(got)}`)
    console.log(`  ✗ ${item.name}`)
  }
}

console.log(`\n排程规则自检：${pass}/${cases.length} 通过`)
if (failures.length > 0) {
  console.log('\n未通过的用例：')
  for (const failure of failures) console.log(`    - ${failure}`)
  process.exit(1)
}
