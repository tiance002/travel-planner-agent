// 排程规则的自检脚本。
//
// 每天生成完都要过一遍这些规则：地点必须来自登记表、景点数量按天型取上限、
// 餐厅夹在景点之间不连排、跨天不重复、评分不低于 4、营业时间与时段对得上、
// 高强度行程之后自动降档。这些是「已经冻结的产品决策」，
// 不该因为某次重构而悄悄失效，所以固化成用例，改代码前先跑一遍。
//
// 用法（二选一）：
//   在项目根目录：npm run check:scheduler
//   在 apps/server 目录：npx tsx scripts/check-scheduler.ts

import type { Poi } from '../src/services/amap'
import { validateDay, type RawPlan } from '../src/services/agent/scheduler'
import {
  checkRating,
  checkSlotHours,
  matchesHike,
  matchesNightHike,
  matchesThemePark,
  maxSpotsForDay,
  nightKind,
  nightKindOfText,
  parseDayTypeBan,
  parseOpenHours,
  resolveDayType,
  resolveIntensity,
  type NightKind,
} from '../src/services/agent/spot-rules'

/** 造一个假 POI。typecode 以 05 开头即被判定为餐饮 */
function poi(
  poiId: string,
  name: string,
  typecode = '110000',
  extra: Partial<Poi> = {},
): Poi {
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
    ...extra,
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

// ---------------------------------------------------------------------------
// 第二组：评分、营业时间、天型与跨天传导
//
// 这一组验的是「选点质量」而不是「结构正确」。它们同样是硬规则——
// 用户要求「不要在晚上安排 7 点就关门的」「评分不要低于 4」，
// 这些不能只写在提示词里靠模型自觉。
// ---------------------------------------------------------------------------

let rulePass = 0
const ruleFailures: string[] = []

/** 断言相等，收集失败项而不是立刻退出，好一次看全 */
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    rulePass += 1
    console.log(`  ✓ ${name}`)
  } else {
    ruleFailures.push(
      `${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`,
    )
    console.log(`  ✗ ${name}`)
  }
}

console.log('\n--- 评分下限 ---')
check('景点 4.5 分通过', checkRating(poi('A', 'A', '110000', { rating: 4.5 }), false), 'ok')
check('景点 4.0 分通过（边界）', checkRating(poi('A', 'A', '110000', { rating: 4 }), false), 'ok')
check('景点 3.9 分低于下限', checkRating(poi('A', 'A', '110000', { rating: 3.9 }), false), 'low')
check('评分缺失放行（不误杀免费公园）', checkRating(poi('A', 'A', '110000', { rating: null }), false), 'unknown')
check('餐厅放宽到 3.5 分', checkRating(poi('A', 'A', '050100', { rating: 3.6 }), true), 'ok')
check('餐厅 3.4 分低于下限', checkRating(poi('A', 'A', '050100', { rating: 3.4 }), true), 'low')

console.log('\n--- 营业时间解析 ---')
check('标准格式', parseOpenHours('09:00-17:00'), { open: 540, close: 1020 })
check('带空格', parseOpenHours('09:00 - 17:00'), { open: 540, close: 1020 })
check('分时段取首尾', parseOpenHours('08:30-12:00;13:00-17:30'), { open: 510, close: 1050 })
check('全天开放', parseOpenHours('全天'), { open: 0, close: 1440 })
check('空字符串返回 null', parseOpenHours(''), null)
check('跨夜营业换算到次日', parseOpenHours('18:00-02:00'), { open: 1080, close: 1560 })

console.log('\n--- 营业时间与时段交叉校验 ---')
const museum = poi('M', '博物馆', '110000', { openTimeToday: '09:00-17:00' })
check('博物馆排上午通过', checkSlotHours(museum, 'morning', false).verdict, 'ok')
check('博物馆排下午偏仓促', checkSlotHours(museum, 'afternoon', false).verdict, 'tight')
check('博物馆排晚上淘汰（关门了）', checkSlotHours(museum, 'evening', false).verdict, 'closed')
const nightMarket = poi('N', '夜市', '110000', { openTimeToday: '18:00-23:00' })
check('夜市排晚上通过', checkSlotHours(nightMarket, 'evening', false).verdict, 'ok')
check('夜市排上午淘汰（还没开）', checkSlotHours(nightMarket, 'morning', false).verdict, 'closed')
check(
  '营业时间缺失放行',
  checkSlotHours(poi('U', '免费公园'), 'evening', false).verdict,
  'unknown',
)
check(
  '餐厅不参与营业时间校验',
  checkSlotHours(poi('R', '小店', '050100', { openTimeToday: '07:00-09:00' }), 'evening', true).verdict,
  'ok',
)

console.log('\n--- 天型关键词识别 ---')
check('环球影城是主题乐园', matchesThemePark(poi('T', '北京环球影城')), true)
check('欢乐谷是主题乐园', matchesThemePark(poi('T', '上海欢乐谷')), true)
check('长隆是主题乐园', matchesThemePark(poi('T', '广州长隆野生动物世界')), true)
check('普通公园不是主题乐园', matchesThemePark(poi('T', '人民公园')), false)
check('索道是徒步类', matchesHike(poi('H', '黄山云谷索道')), true)
check('夜爬识别为夜爬型', matchesNightHike(poi('H', '泰山夜爬看日出')), true)
check('普通登山道不是夜爬', matchesNightHike(poi('H', '香山登山道')), false)

console.log('\n--- 天型判定（模型提议 + 规则兜底） ---')
check(
  '规则表强制升级为主题乐园',
  resolveDayType({ proposed: 'normal', spots: [poi('T', '北京环球影城')] }).dayType,
  'theme_park',
)
check(
  '模型说整天但排了 3 个景点 → 降级',
  resolveDayType({
    proposed: 'theme_park',
    spots: [poi('1', 'A'), poi('2', 'B'), poi('3', 'C')],
  }).dayType,
  'normal',
)
check(
  '用户勾了不含主题乐园 → 强制降级',
  resolveDayType({
    proposed: 'theme_park',
    spots: [poi('T', '北京环球影城')],
    ban: { noThemePark: true },
  }).dayType,
  'normal',
)
check(
  '用户勾了不含爬山 → 索道日降级',
  resolveDayType({
    proposed: 'hike',
    spots: [poi('H', '黄山云谷索道')],
    ban: { noHike: true },
  }).dayType,
  'normal',
)
check(
  '用户勾了不夜爬 → 夜爬日降级',
  resolveDayType({
    proposed: 'night_hike',
    spots: [poi('H', '泰山夜爬看日出')],
    ban: { noNightHike: true },
  }).dayType,
  'normal',
)
check(
  '夜爬优先于主题乐园',
  resolveDayType({ spots: [poi('H', '泰山夜爬看日出')] }).dayType,
  'night_hike',
)

console.log('\n--- 景点上限按天型 ---')
check('normal 上限 3', maxSpotsForDay('normal'), 3)
check('theme_park 上限 1', maxSpotsForDay('theme_park'), 1)
check('hike 上限 1', maxSpotsForDay('hike'), 1)
check('recovery 上限 2', maxSpotsForDay('recovery'), 2)

console.log('\n--- 强度推导 ---')
check('主题乐园是 heavy', resolveIntensity('theme_park'), 'heavy')
check('恢复日是 light', resolveIntensity('recovery'), 'light')
check('勾了节奏轻松则一切 light', resolveIntensity('theme_park', { relaxed: true }), 'light')

console.log('\n--- 额外需求黑名单解析 ---')
check('识别不含爬山', parseDayTypeBan(['不含爬山等高强度行程']).noHike, true)
check('识别不含主题乐园', parseDayTypeBan(['不含主题乐园整天行程']).noThemePark, true)
check('识别不夜爬', parseDayTypeBan(['不安排夜爬看日出']).noNightHike, true)
check('识别节奏轻松', parseDayTypeBan(['行程节奏轻松一些']).relaxed, true)
check('带老人触发轻松模式', parseDayTypeBan(['带老人']).relaxed, true)
check('无关需求不误判', parseDayTypeBan(['素食', '自驾']).noHike, false)

console.log('\n--- 夜间活动分类（去重的前提） ---')
check('酒吧识别', nightKind(poi('B1', '南锣鼓巷酒吧', '080306')), 'bar')
check('精酿酒吧识别', nightKind(poi('B2', '老城精酿', '080306')), 'bar')
check('英文 Live House 识别', nightKind(poi('B3', 'Blue Note Live House', '080306')), 'bar')
check('清吧识别', nightKind(poi('B4', '后海清吧', '080306')), 'bar')
// 这条是最容易踩的坑：barbecue 里包含 "bar"，卡了词边界才不会误判
check('烧烤不会被误判成酒吧', nightKind(poi('B5', '张记 Barbecue 烧烤', '050100')), null)
check('小吃街识别', nightKind(poi('S1', '河坊街小吃街', '110000')), 'snack_street')
check('夜市识别', nightKind(poi('S2', '西市场夜市', '110000')), 'snack_street')
check('大排档识别', nightKind(poi('S3', '江边大排档', '050100')), 'snack_street')
// 单家店不该算成一条街，否则会把正常的餐饮选择也封掉
check('单家「沙县小吃」不算小吃街', nightKind(poi('S4', '沙县小吃', '050100')), null)
check('普通景点不参与去重', nightKind(poi('N1', '西湖', '110000')), null)
check('从文本判断（用于恢复已落库数据）', nightKindOfText('某某夜市'), 'snack_street')

// ---------------------------------------------------------------------------
// 第三组：走一遍完整 validateDay，验证新规则真的接进了主流程
// ---------------------------------------------------------------------------

interface RuleCase {
  name: string
  raw: RawPlan
  /** 覆盖登记表里的 POI（用于造低分、关门等特例） */
  registryOverride?: Map<string, Poi>
  /** 跨天传导的输入 */
  previousDayState?: { dayType: 'night_hike'; intensity: 'heavy' } | null
  /** 用户额外需求黑名单 */
  banText?: string[]
  /** 期望保留的条目名（按顺序） */
  expect: string[]
  /** 期望的最终天型 */
  expectDayType?: string
}

const LOW_RATED = poi('L001', '低分小景点', '110000', { rating: 3.2 })
const CLOSED_AT_NIGHT = poi('C001', '五点关门馆', '110000', {
  rating: 4.6,
  openTimeToday: '09:00-17:00',
})
const THEME_PARK = poi('T001', '北京环球影城', '110000', { rating: 4.8 })

const ruleCases: RuleCase[] = [
  {
    name: '评分 3.2 的景点被剔除',
    raw: day([{ poiId: 'P001' }, { poiId: 'L001' }]),
    registryOverride: new Map(
      [...registry.entries(), ['L001', LOW_RATED]],
    ),
    expect: ['断桥残雪'],
  },
  {
    name: '被排到晚间的 17:00 关门馆被剔除',
    raw: day([{ poiId: 'C001', slot: 'evening' }, { poiId: 'P002' }]),
    registryOverride: new Map(
      [...registry.entries(), ['C001', CLOSED_AT_NIGHT]],
    ),
    expect: ['苏堤'],
  },
  {
    name: '主题乐园整天型：只保留一个景点',
    raw: day([{ poiId: 'T001' }, { poiId: 'P002' }]),
    registryOverride: new Map(
      [...registry.entries(), ['T001', THEME_PARK]],
    ),
    // 整天型的结构：同一天里同一地点出现在 morning 与 afternoon 两条
    expect: ['北京环球影城', '北京环球影城'],
    expectDayType: 'theme_park',
  },
  {
    name: '前一天夜爬 → 今天强制恢复日，不排上午景点',
    raw: day([{ poiId: 'P001' }, { poiId: 'P002' }, { poiId: 'P003' }]),
    previousDayState: { dayType: 'night_hike', intensity: 'heavy' },
    // 恢复日景点上限 2，且从下午开始
    expect: ['断桥残雪', '苏堤'],
    expectDayType: 'recovery',
  },
  {
    name: '用户勾了不含主题乐园 → 环球影城不再触发整天型',
    raw: day([{ poiId: 'T001' }, { poiId: 'P002' }]),
    registryOverride: new Map(
      [...registry.entries(), ['T001', THEME_PARK]],
    ),
    banText: ['不含主题乐园整天行程'],
    expect: ['北京环球影城', '苏堤'],
    expectDayType: 'normal',
  },
]

console.log('\n--- validateDay 全流程（新规则已接入） ---')

let vPass = 0
const vFailures: string[] = []

for (const item of ruleCases) {
  const reg = item.registryOverride ?? registry
  const used = new Set<string>()

  try {
    const { day: planned } = validateDay(item.raw, reg, 1, {
      usedPoiIds: used,
      ban: item.banText ? parseDayTypeBan(item.banText) : undefined,
      previousDayState: item.previousDayState ?? null,
    })
    const got = planned.items.map((entry) => entry.name)
    const ok =
      JSON.stringify(got) === JSON.stringify(item.expect) &&
      (item.expectDayType === undefined || planned.dayType === item.expectDayType)

    if (ok) {
      vPass += 1
      console.log(`  ✓ ${item.name}`)
    } else {
      vFailures.push(
        `${item.name}\n      期望：${JSON.stringify(item.expect)} 天型 ${item.expectDayType ?? '不限'}` +
          `\n      实际：${JSON.stringify(got)} 天型 ${planned.dayType}`,
      )
      console.log(`  ✗ ${item.name}`)
    }
  } catch (error) {
    vFailures.push(`${item.name}\n      抛错：${error instanceof Error ? error.message : String(error)}`)
    console.log(`  ✗ ${item.name}（抛错）`)
  }
}

// ---------------------------------------------------------------------------
// 第四组：夜间活动去重的跨天传导
// ---------------------------------------------------------------------------

console.log('\n--- 夜间活动去重（撞了已去过的类别要换掉） ---')

{
  // BAR_B 刻意放到很远的地方：换点逻辑只在「比原来更近」时才替换，
  // 都放在同一坐标的话距离相等，会走「换不到 → 保留并提示」那条分支，
  // 测的就不是我们要测的替换路径了
  const FAR_BAR = poi('B102', '江边清吧', '080306', { rating: 4.6, lng: 121.9, lat: 31.4 })
  const LANTERN = poi('N002', '江畔观景台', '110000', { rating: 4.7 })
  const dedupRegistry = new Map<string, Poi>([
    ...registry.entries(),
    [LANTERN.poiId, LANTERN],
    [FAR_BAR.poiId, FAR_BAR],
  ])

  // 前面某天已经去过酒吧，这一天晚上又排了一家别的酒吧
  const { day: planned, warnings } = validateDay(
    day([
      { poiId: 'P001', slot: 'morning' },
      { poiId: 'B102', slot: 'evening' },
    ]),
    dedupRegistry,
    2,
    { usedNightKinds: new Set<NightKind>(['bar']) },
  )
  const names = planned.items.map((entry) => entry.name)
  check(
    '撞了去过的酒吧 → 夜里不再出现酒吧',
    names.filter((name) => nightKindOfText(name) === 'bar').length,
    0,
  )
  check('原来那家酒吧被换掉了', names.includes('江边清吧'), false)
  check('换点动作有留下说明', warnings.some((w) => w.includes('酒吧')), true)

  // 没有撞上时不该动它：今天还没人去过酒吧
  const { day: untouched } = validateDay(
    day([
      { poiId: 'P001', slot: 'morning' },
      { poiId: 'B102', slot: 'evening' },
    ]),
    dedupRegistry,
    2,
    { usedNightKinds: new Set<NightKind>() },
  )
  check(
    '没撞上时酒吧照常保留',
    untouched.items.some((entry) => entry.name === '江边清吧'),
    true,
  )
}

const totalPass = rulePass + vPass
const totalFail = ruleFailures.length + vFailures.length

console.log(`\n选点质量与天型自检：${totalPass}/${totalPass + totalFail} 通过`)
if (totalFail > 0) {
  console.log('\n未通过的用例：')
  for (const failure of [...ruleFailures, ...vFailures]) console.log(`    - ${failure}`)
  process.exit(1)
}
