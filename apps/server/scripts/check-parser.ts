// 模型输出解析器的自检脚本。
//
// 这个解析器专门用来对付「模型话说毛边」的各种花样，而这些花样在真实调用里
// 出现得随机、复现成本高。把已知的失败形态固化成用例，改代码时先跑一遍，
// 免得修好一种、弄坏另一种。
//
// 用法（二选一）：
//   在项目根目录：npm run check:parser
//   在 apps/server 目录：npx tsx scripts/check-parser.ts

import { parsePlanJson, PlanParseError } from '../src/services/agent/scheduler'

interface Case {
  name: string
  input: string
  /** 期望解析出的第一天景点数量；null 表示期望解析失败 */
  expectSpots: number | null
  /** 期望被判定为截断 */
  expectTruncated?: boolean
}

const clean = JSON.stringify({
  stay: { poiId: 'B001', name: '如家', reason: '交通方便' },
  days: [
    {
      dayIndex: 1,
      summary: '西湖一圈',
      items: [
        { poiId: 'P001', itemType: 'spot', slot: 'morning', note: '早上人少' },
        { poiId: 'R001', itemType: 'restaurant', slot: 'noon', note: '杭帮菜' },
        { poiId: 'P002', itemType: 'spot', slot: 'afternoon', note: '' },
      ],
    },
  ],
})

const cases: Case[] = [
  { name: '正常 JSON', input: clean, expectSpots: 2 },

  { name: '包了 Markdown 代码块', input: '```json\n' + clean + '\n```', expectSpots: 2 },

  {
    name: '前后带客套话',
    input: `好的，我为你排好了：\n${clean}\n以上行程仅供参考，请以实际为准。`,
    expectSpots: 2,
  },

  {
    name: '字符串里有未转义的换行',
    input: clean.replace('早上人少', '早上人少\n建议七点前到'),
    expectSpots: 2,
  },

  {
    name: '对象末尾多了逗号',
    input: clean.replace('"note":""}]}]}', '"note":""},]}]}').replace('"reason":"交通方便"', '"reason":"交通方便",'),
    expectSpots: 2,
  },

  {
    name: '推荐理由里含花括号',
    input: clean.replace('早上人少', '按 {早上去} 更合适'),
    expectSpots: 2,
  },

  {
    name: '输出被截断（最后一个地点写到一半）',
    input: clean.slice(0, clean.lastIndexOf('{"poiId":"P002"') + 18),
    expectSpots: 1,
    expectTruncated: true,
  },

  {
    name: '输出被截断（字符串没闭合）',
    input: clean.slice(0, clean.lastIndexOf('"note":"早上人少') + 12),
    expectSpots: 1,
    expectTruncated: true,
  },

  { name: '完全不是 JSON', input: '抱歉，我无法完成这个请求。', expectSpots: null },

  { name: '空字符串', input: '', expectSpots: null },
]

let passed = 0
let failed = 0

/** 数一数解析结果里第一天有几个 spot，用来判断修复是否保住了有效内容 */
function countSpots(plan: unknown): number {
  const days = (plan as { days?: { items?: { itemType?: string }[] }[] }).days
  if (!Array.isArray(days) || days.length === 0) return 0
  return (days[0]?.items ?? []).filter((item) => item.itemType === 'spot').length
}

for (const testCase of cases) {
  try {
    const plan = parsePlanJson(testCase.input)
    const spots = countSpots(plan)

    if (testCase.expectSpots === null) {
      failed += 1
      console.log(`✗ ${testCase.name}：本应解析失败，却成功解析出了 ${spots} 个景点`)
      continue
    }

    if (spots !== testCase.expectSpots) {
      failed += 1
      console.log(`✗ ${testCase.name}：期望 ${testCase.expectSpots} 个景点，实际 ${spots} 个`)
      continue
    }

    passed += 1
    console.log(`✓ ${testCase.name}（解析出 ${spots} 个景点）`)
  } catch (error) {
    if (testCase.expectSpots === null) {
      const truncated = error instanceof PlanParseError ? error.truncated : undefined
      const matches = testCase.expectTruncated === undefined || testCase.expectTruncated === truncated
      if (matches) {
        passed += 1
        console.log(`✓ ${testCase.name}（按预期报错）`)
      } else {
        failed += 1
        console.log(`✗ ${testCase.name}：截断判定不符，期望 ${testCase.expectTruncated}，实际 ${truncated}`)
      }
      continue
    }

    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`✗ ${testCase.name}：本应解析成功，却抛错「${message}」`)
  }
}

console.log(`\n合计：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
