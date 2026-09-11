// 开发期手动跑一次行程生成，用来验证 AI 编排是否正常。
//
// 为什么要有这个脚本：真实生成要跑一两分钟、会调用十几次高德接口，
// 通过页面点按钮调试一次成本太高。这里直接调服务端函数，
// 能在终端看到每一次工具调用和最终产出，排查最快。
//
// 用法（须在 apps/server 目录下执行）：
//   npx tsx scripts/try-generate.ts [用户名] [天数]

import { prisma } from '../src/db'
import { generateTrip } from '../src/services/agent'
import { geocode } from '../src/services/amap'

const username = process.argv[2] ?? '123'
const days = Number(process.argv[3] ?? 2)

const user = await prisma.user.findUnique({ where: { username } })
if (!user) {
  console.log(`未找到用户名 ${username}`)
  process.exit(1)
}

// 用杭州做样例：景点、餐饮、酒店资源都足够丰富
const cityName = '杭州'
const geo = await geocode(cityName, cityName)
if (!geo) {
  console.log('城市解析失败，检查高德 Key 是否可用')
  process.exit(1)
}

const startDate = new Date()
startDate.setDate(startDate.getDate() + 1)

const trip = await prisma.trip.create({
  data: {
    userId: user.id,
    title: `${cityName} ${days} 日测试行程`,
    cityName,
    cityAdcode: geo.adcode,
    startDate,
    days,
    travelers: 2,
    preferences: JSON.stringify(['自然风光', '当地美食']),
    extraNeeds: JSON.stringify(['不想起太早']),
    budgetAmount: 800,
    budgetScope: 'per_person',
    // 刻意不定住宿，验证「AI 推荐锚点区域」这条路径
    stayResolved: false,
    status: 'draft',
  },
})

console.log(`已创建测试行程：${trip.id}（${cityName} ${days} 天，未定住宿）`)
console.log('开始生成……\n')

const startedAt = Date.now()
try {
  await generateTrip(trip.id)
} catch (error) {
  console.log(`\n生成失败：${error instanceof Error ? error.message : String(error)}`)
}

const elapsed = Math.round((Date.now() - startedAt) / 1000)
const finished = await prisma.trip.findUnique({
  where: { id: trip.id },
  include: {
    tripDays: {
      orderBy: { dayIndex: 'asc' },
      include: { items: { orderBy: { orderIndex: 'asc' } } },
    },
  },
})

console.log(`\n===== 结果（耗时 ${elapsed} 秒）=====`)
console.log(`状态：${finished?.status}`)
if (finished?.genError) console.log(`失败原因：${finished.genError}`)
if (finished?.stayResolved) {
  console.log(`住宿锚点：${finished.stayName}（${finished.stayLng}, ${finished.stayLat}）`)
}

for (const day of finished?.tripDays ?? []) {
  console.log(`\n第 ${day.dayIndex} 天（${day.date.toISOString().slice(0, 10)}）${day.summary ?? ''}`)
  if (day.items.length === 0) {
    console.log('  （无安排）')
  }
  for (const item of day.items) {
    const kind = item.itemType === 'restaurant' ? '餐厅' : '景点'
    const rating = item.rating ? ` 评分 ${item.rating}` : ''
    console.log(`  ${item.orderIndex}. [${item.slot}] ${kind} ${item.name}${rating}`)
    console.log(`     坐标 ${item.lng},${item.lat}　${item.note ?? ''}`)
  }
}

const spotCount = (finished?.tripDays ?? []).reduce(
  (sum, day) => sum + day.items.filter((i) => i.itemType === 'spot').length,
  0,
)
const restaurantCount = (finished?.tripDays ?? []).reduce(
  (sum, day) => sum + day.items.filter((i) => i.itemType === 'restaurant').length,
  0,
)
console.log(`\n合计：景点 ${spotCount} 个，餐厅 ${restaurantCount} 个`)
console.log(`行程编号（可在页面上查看）：${trip.id}`)

await prisma.$disconnect()
