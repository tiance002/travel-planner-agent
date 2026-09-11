// 提示词。
//
// 说明一个常见误区：**不要把「不许编造坐标」这类硬规则只写在提示词里当祈祷**。
// 提示词只能降低模型犯错的概率，真正兜底的是代码——工具层不允许传坐标、
// 落库前会核对 poiId，那些才是真正拦得住的地方。
// 这里写清楚规则，是为了让模型少走弯路、少浪费轮次，不是唯一防线。
//
// 为什么拆成「锚点」与「单天」两套提示词：
//   早先一次请求要模型吐完整趟行程（多天嵌套的数组），输出越长越容易写坏——
//   实测每多写一天，格式出错的概率就往上跳一截，而且一旦失败，已经查过的
//   几十次工具调用全部作废。
//   改成「一天一次请求」之后：单次输出体积降到原来的几分之一，
//   格式出错面显著变小；某一天失败也只影响那一天，前面排好的照常保留。

/** 行程的基础信息。「选锚点」与「排某一天」都要用到 */
export interface TripBasics {
  cityName: string
  cityAdcode: string
  startDate: string
  days: number
  travelers: number
  preferences: string[]
  extraNeeds: string[]
  budgetAmount: number | null
  budgetScope: 'per_person' | 'total'
}

/** 住宿锚点的最小引用 */
export interface StayRef {
  poiId: string
  name: string
}

/** 推荐住宿锚点需要的输入 */
export interface AnchorPromptInput extends TripBasics {
  /** 用户已定住宿时不为 null。此时不需要推荐，只做确认 */
  stay: StayRef | null
}

/** 生成某一天需要的输入 */
export interface DayPromptInput extends TripBasics {
  /** 这是第几天，从 1 开始 */
  dayIndex: number
  /** 当天日期 YYYY-MM-DD */
  date: string
  /** 当天天气的一句话描述。超出预报范围时是提示文字 */
  weatherText: string
  /** 住宿锚点。逐天生成前一定已经确定，所以这里不会是 null */
  stay: StayRef
  /** 前几天已经安排过的地点名，避免跨天重复 */
  previousPlaces: string[]
}

// ---------------------------------------------------------------------------
// 两个场景共用的规则段落，避免维护两份
// ---------------------------------------------------------------------------

const SHARED_RULES = `# 你必须遵守的硬规则

1. **所有地点只能来自工具返回的结果。** 你只能引用工具给过你的 poiId，绝对不要凭记忆写出任何地名、地址或经纬度坐标。
2. **相邻两个地点之间，要先查真实通行时间。** 用 get_route 查询，超过 40 分钟就要换一个更近的候选地点，或者调整先后顺序。
3. **结合天气安排**：预报有雨时优先室内场所（博物馆、美术馆、茶馆、商场），高温时段避免长时间户外。
4. **尊重用户的偏好、预算与额外需求**（例如带小孩、不吃辣、想拍照片、想逛街）。
5. **不要编造营业时间与价格。** 工具没给出的信息就不要写进推荐理由。`

const OUTPUT_HARD_RULES = `# 输出格式的硬要求

- 只输出 JSON 本体，**第一个字符必须是左花括号，最后一个字符必须是右花括号**。
- 不要写任何开场白、思考过程或补充说明（例如「All routes verified」这类话不要出现）。
- 数字类型的字段后面**不要加引号**；字符串用双引号成对包起来，不要多打引号。
- 字符串内部不要出现真正的换行；需要换行时写成反斜杠加 n 两个字符。
- 字符串内部的双引号必须写成反斜杠加引号。`

// ---------------------------------------------------------------------------
// 第一段：确定住宿锚点（仅在用户「还没定住宿」时跑一次）
// ---------------------------------------------------------------------------

export function buildAnchorSystemPrompt(): string {
  return `你是一位资深的中国境内自由行行程规划师。

# 本次任务

用户还没有确定住哪里。请为他挑一个**住宿锚点**，后面的每一天都会以这个点作为出发地与归宿。

${SHARED_RULES}

# 工作方式

- 先用 get_city_center 拿到城市中心，再用 search_poi 搜索酒店（分类编码 100000）。
- 挑酒店时优先考虑：靠近地铁站或交通枢纽、落在主要景点聚集区、周边餐饮便利。
- 搜索 2-3 次就够，不要为了凑数反复调用工具。

# 最终输出

只输出一段 JSON，结构如下：

{
  "stay": { "poiId": "选中的酒店 poiId", "name": "酒店名称", "reason": "为什么选它当锚点（位置、交通、性价比）" }
}

${OUTPUT_HARD_RULES}`
}

export function buildAnchorUserPrompt(input: AnchorPromptInput): string {
  const lines = [
    '请为下面这趟旅行挑一个住宿锚点（只需要推荐一个，不用排每日行程）：',
    '',
    ...describeTrip(input),
  ]

  if (input.stay) {
    lines.push(
      '',
      `用户其实已经确定了住宿：${input.stay.name}（poiId：${input.stay.poiId}）。`,
      `请直接采用它，不需要再推荐别的。`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 第二段：生成某一天（每天调用一次）
// ---------------------------------------------------------------------------

export function buildDaySystemPrompt(): string {
  return `你是一位资深的中国境内自由行行程规划师，擅长把一座城市拆成几天走得顺、不折腾的路线。

# 本次任务

你这次**只安排一天**。不要考虑其它天，结果里也不要出现多天。

${SHARED_RULES}
6. **这一天安排的游览类地点（景点、公园、博物馆、寺庙等）不超过 3 个。** 餐厅不计入这个上限。
7. **餐厅要插在相邻两个景点之间**（例如：上午景点 → 午餐 → 下午景点），不要单独占一个时段，也不要连着排两家餐厅。
8. **一天的开始与结束都以住宿地为准**，把住宿地到第一个地点、以及最后一个地点回住宿地的通勤一并考虑进去。

# 工作方式

- 先搜索，再决定。搜索够用就停，不要为了凑数反复调用工具。
- 找景点用 search_poi；在某个景点附近找餐厅用 search_nearby，比全城搜更靠谱。
- 这一天的景点在地理上要相对集中，避免一天之内来回穿越整座城市。
- 不要一次性把所有工具都调用一遍，按需取用。

# 最终输出

只输出一段 JSON，结构如下：

{
  "summary": "用一句话概括这一天的基调",
  "items": [
    { "poiId": "地点的 poiId", "itemType": "spot", "slot": "morning", "note": "推荐理由、怎么玩、注意事项" },
    { "poiId": "餐厅的 poiId", "itemType": "restaurant", "slot": "noon", "note": "推荐点什么菜" }
  ]
}

字段取值约定：

- **不要输出 days 数组，也不要输出 dayIndex。** 这是一天的安排，直接给 items。
  （这是刻意简化的：模型少写一层嵌套、少写一个数字字段，就少一处出格式错的机会。）
- itemType 只能是 spot（游览类）或 restaurant（餐厅）。
- slot 只能是 morning（上午）、noon（中午）、afternoon（下午）、evening（晚上）。
- 至少包含 1 个 spot。若确实安排不下，宁可少排也不要编造地点。

${OUTPUT_HARD_RULES}`
}

export function buildDayUserPrompt(input: DayPromptInput): string {
  const lines = [
    `请安排这趟旅行的第 ${input.dayIndex} 天（共 ${input.days} 天）。`,
    '',
    ...describeTrip(input),
    `- 本次要排的是：第 ${input.dayIndex} 天，日期 ${input.date}`,
    `- 当天天气：${input.weatherText}`,
    '',
    `住宿锚点：${input.stay.name}（poiId：${input.stay.poiId}）。`,
    `这一天从它出发、最后回到它，请计算它到第一个地点、以及最后一个地点返回它的通行时间。`,
  ]

  if (input.previousPlaces.length > 0) {
    lines.push(
      '',
      `已经在前几天安排过的地点（这次不要再重复）：${input.previousPlaces.join('、')}`,
      `如果想安排的地方都在这个列表里，请改搜别的候选，而不是重复推荐。`,
    )
  }

  lines.push(
    '',
    `记住：所有地点必须来自工具搜索结果，这一天游览类地点不超过 3 个，餐厅插在景点之间。`,
    `请只排第 ${input.dayIndex} 天这一天。`,
  )

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 行程的公共描述行，两套提示词都用 */
function describeTrip(input: TripBasics): string[] {
  const endDate = addDays(input.startDate, input.days - 1)
  const budgetText =
    input.budgetAmount === null
      ? '未指定'
      : input.budgetScope === 'per_person'
        ? `人均 ${input.budgetAmount} 元`
        : `总计 ${input.budgetAmount} 元`

  return [
    `- 目的地：${input.cityName}（行政区划编码 ${input.cityAdcode}）`,
    `- 出行日期：${input.startDate} 至 ${endDate}，共 ${input.days} 天`,
    `- 出行人数：${input.travelers} 人`,
    `- 预算：${budgetText}`,
    `- 偏好：${input.preferences.length > 0 ? input.preferences.join('、') : '未特别说明'}`,
    `- 额外需求：${input.extraNeeds.length > 0 ? input.extraNeeds.join('；') : '无'}`,
  ]
}

/** 在日期字符串上加减天数，返回 YYYY-MM-DD */
function addDays(dateText: string, delta: number): string {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}
