// AI 可调用的工具集。
//
// 这一层的核心思想：**模型只能通过这里声明的工具去「要数据」，不能自己编造地点和坐标。**
// 类比：给一个实习生配了一张门禁卡，他只能去资料室、气象台、交通台这三个房间取材料，
// 取到什么就用什么；他不能凭记忆写「杭州西湖在东经 120.1 度」这种数字，因为那很容易记错。
//
// 具体做法是「POI 登记表」：凡是工具返回过的地点都会被登记下来，
// 模型后续想引用某个地点时只能给 poiId，服务端再依据登记表回填真实经纬度。
// 这样即便模型硬编了一个坐标，也会因为查不到记录而被丢弃。

import { z } from 'zod'
import {
  geocode,
  getWeather,
  planRoute,
  searchPoiAround,
  searchPoiText,
  type Poi,
  type RouteMode,
} from '../amap'

// ---------------------------------------------------------------------------
// 会话上下文
// ---------------------------------------------------------------------------

/** 一次行程生成会话的上下文。工具执行时需要的城市信息与登记表都放在这里 */
export interface ToolContext {
  cityName: string
  cityAdcode: string
  /** poiId → POI 归一化数据。只有进过这张表的地点才允许被行程引用 */
  registry: Map<string, Poi>
  /** 上报进度文案，前端轮询时能显示「正在搜索景点」这类提示 */
  report: (text: string) => void
}

/** 把工具返回的 POI 登记进表，并返回 poiId */
function register(ctx: ToolContext, list: Poi[]): void {
  for (const poi of list) {
    ctx.registry.set(poi.poiId, poi)
  }
}

/**
 * 精简 POI 后再交给模型。
 *
 * 刻意不返回经纬度：一是省 token，二是从源头断掉模型「复述坐标」的念头——
 * 它手上没有坐标，自然就编不出来。坐标由服务端在落库时统一回填。
 */
function briefPoi(poi: Poi) {
  return {
    poiId: poi.poiId,
    name: poi.name,
    type: poi.type,
    district: poi.district,
    address: poi.address,
    rating: poi.rating,
    cost: poi.cost,
    tag: poi.tag,
    openTime: poi.openTimeToday,
    /** 周边搜索时才有，单位米 */
    straightDistance: poi.distance,
  }
}

// ---------------------------------------------------------------------------
// 工具参数定义（同时用于给模型看，以及服务端校验）
// ---------------------------------------------------------------------------

const searchPoiSchema = z.object({
  keywords: z.string().trim().min(1, '关键词不能为空').max(40),
  /** 高德分类编码，多个用竖线分隔，例如「110000|140000」 */
  types: z.string().trim().max(60).optional(),
  limit: z.number().int().min(1).max(15).optional(),
})

const searchNearbySchema = z.object({
  /** 圆心地点，必须是工具返回过的 poiId */
  anchorPoiId: z.string().trim().min(1),
  keywords: z.string().trim().max(40).optional(),
  types: z.string().trim().max(60).optional(),
  radius: z.number().int().min(300).max(5000).optional(),
  limit: z.number().int().min(1).max(15).optional(),
})

const getRouteSchema = z.object({
  fromPoiId: z.string().trim().min(1),
  toPoiId: z.string().trim().min(1),
  mode: z.enum(['driving', 'walking', 'transit']).optional(),
})

// ---------------------------------------------------------------------------
// 提供给模型的工具清单（OpenAI 风格）
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_poi',
      description:
        '按关键词在城市范围内搜索地点，返回候选列表。可用来找景点、餐厅、酒店。' +
        '常用分类编码：110000 风景名胜（含公园、寺庙、观景地）、140000 科教文化（博物馆、美术馆）、' +
        '050000 餐饮服务、100000 住宿服务、060000 购物服务、080000 体育休闲。' +
        '多个分类用竖线分隔。建议每个主题搜索 8-15 条，便于后续挑选。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词，例如「西湖」「杭帮菜」「地铁站」' },
          types: { type: 'string', description: '高德分类编码，多个用 | 分隔，不填表示不限分类' },
          limit: { type: 'integer', description: '返回条数，1-15，默认 10' },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_nearby',
      description:
        '以某个已搜索到的地点为圆心，找它周边的地点。适合「在某景点附近找餐厅」这类需求。' +
        '圆形范围受半径限制，半径最大 5000 米。',
      parameters: {
        type: 'object',
        properties: {
          anchorPoiId: { type: 'string', description: '圆心地点的 poiId，必须来自之前工具的返回结果' },
          keywords: { type: 'string', description: '关键词，例如「餐厅」「咖啡」' },
          types: { type: 'string', description: '高德分类编码，例如 050000 餐饮服务' },
          radius: { type: 'integer', description: '半径（米），300-5000，默认 1500' },
          limit: { type: 'integer', description: '返回条数，1-15，默认 10' },
        },
        required: ['anchorPoiId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_route',
      description:
        '计算两个已搜索到的地点之间的真实通行方案，返回实际里程与耗时（不是直线距离）。' +
        '用于判断相邻两个地点是否太远、以及给用户写「怎么过去」。' +
        '注意：只能传 poiId，系统会自行取坐标，不要尝试传经纬度。',
      parameters: {
        type: 'object',
        properties: {
          fromPoiId: { type: 'string', description: '起点 poiId' },
          toPoiId: { type: 'string', description: '终点 poiId' },
          mode: {
            type: 'string',
            enum: ['driving', 'walking', 'transit'],
            description: '出行方式：driving 驾车打车 / walking 步行 / transit 公交地铁。默认 driving',
          },
        },
        required: ['fromPoiId', 'toPoiId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description:
        '查询目的地未来几天的天气。注意高德只提供约 4 天的预报，行程日期超出这个范围时返回为空，' +
        '此时不要编造天气，按「未知」处理。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_city_center',
      description:
        '获取目的地的中心点坐标与行政信息。当用户还没有确定住宿时，' +
        '可以先用它拿到城市中心，再以中心附近搜索酒店，挑出 2-3 个交通便利的区域作为行程锚点。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

export interface ToolResult {
  ok: boolean
  /** 交给模型看的内容（已精简） */
  data?: unknown
  error?: string
}

/**
 * 执行一次工具调用。
 *
 * 任何异常都会被吞成 { ok:false, error } 交回给模型，而不是把整个生成过程打断——
 * 模型看到「这个工具失败了」可以换个思路继续，比直接崩掉有用得多。
 */
export async function runTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  let args: unknown
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, error: '参数不是合法 JSON，请重新调用' }
  }

  try {
    switch (name) {
      case 'search_poi':
        return await runSearchPoi(args, ctx)
      case 'search_nearby':
        return await runSearchNearby(args, ctx)
      case 'get_route':
        return await runGetRoute(args, ctx)
      case 'get_weather':
        return await runGetWeather(ctx)
      case 'get_city_center':
        return await runGetCityCenter(ctx)
      default:
        return { ok: false, error: `没有名为 ${name} 的工具` }
    }
  } catch (error) {
    // 高德的 AmapError 与网络异常都会走到这里，如实回给模型，让它自己决定下一步
    return { ok: false, error: error instanceof Error ? error.message : '工具执行失败' }
  }
}

async function runSearchPoi(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = searchPoiSchema.safeParse(args)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }

  const limit = parsed.data.limit ?? 10
  ctx.report(`正在搜索「${parsed.data.keywords}」`)

  const list = await searchPoiText({
    keywords: parsed.data.keywords,
    region: ctx.cityAdcode,
    types: parsed.data.types,
    pageSize: limit,
  })

  register(ctx, list)

  if (list.length === 0) {
    return { ok: true, data: { count: 0, hint: '该关键词没有搜到结果，换个说法再试' } }
  }

  return { ok: true, data: { count: list.length, items: list.map(briefPoi) } }
}

async function runSearchNearby(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = searchNearbySchema.safeParse(args)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }

  // 圆心必须来自登记表：这就是「不允许模型编坐标」的执行点
  const anchor = ctx.registry.get(parsed.data.anchorPoiId)
  if (!anchor) {
    return {
      ok: false,
      error: `找不到 poiId 为 ${parsed.data.anchorPoiId} 的地点，请先通过 search_poi 搜索它`,
    }
  }

  const limit = parsed.data.limit ?? 10
  const radius = parsed.data.radius ?? 1500
  ctx.report(`正在搜索「${anchor.name}」周边 ${radius} 米内的地点`)

  const list = await searchPoiAround({
    lng: anchor.lng,
    lat: anchor.lat,
    keywords: parsed.data.keywords,
    types: parsed.data.types,
    radius,
    sortRule: 'distance',
    pageSize: limit,
  })

  register(ctx, list)

  if (list.length === 0) {
    return {
      ok: true,
      data: { count: 0, hint: `「${anchor.name}」周边该范围内没有结果，可以放宽关键词或加大半径` },
    }
  }

  return {
    ok: true,
    data: {
      count: list.length,
      anchor: { poiId: anchor.poiId, name: anchor.name },
      items: list.map(briefPoi),
    },
  }
}

async function runGetRoute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = getRouteSchema.safeParse(args)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }

  const from = ctx.registry.get(parsed.data.fromPoiId)
  const to = ctx.registry.get(parsed.data.toPoiId)
  if (!from || !to) {
    return {
      ok: false,
      error: '起点或终点不在候选列表里，请先搜索这两个地点再查询路线',
    }
  }

  const mode: RouteMode = parsed.data.mode ?? 'driving'
  ctx.report(`正在规划「${from.name}」到「${to.name}」的路线`)

  const route = await planRoute({
    mode,
    originLng: from.lng,
    originLat: from.lat,
    destLng: to.lng,
    destLat: to.lat,
    city1: ctx.cityAdcode,
    city2: ctx.cityAdcode,
  })

  return {
    ok: true,
    data: {
      from: { poiId: from.poiId, name: from.name },
      to: { poiId: to.poiId, name: to.name },
      mode,
      distanceMeters: route.distance,
      durationMinutes: Math.round(route.duration / 60),
      taxiCost: route.taxiCost,
    },
  }
}

async function runGetWeather(ctx: ToolContext): Promise<ToolResult> {
  ctx.report('正在查询目的地天气')
  const weather = await getWeather(ctx.cityAdcode)

  if (!weather || weather.casts.length === 0) {
    return {
      ok: true,
      data: {
        available: false,
        hint: '高德暂未提供该城市的预报（通常因为行程日期超出未来 4 天），请按天气未知处理，不要编造',
      },
    }
  }

  return {
    ok: true,
    data: {
      available: true,
      reportTime: weather.reportTime,
      casts: weather.casts.map((c) => ({
        date: c.date,
        weekday: c.week,
        day: c.dayWeather,
        night: c.nightWeather,
        dayTemp: c.dayTemp,
        nightTemp: c.nightTemp,
      })),
    },
  }
}

async function runGetCityCenter(ctx: ToolContext): Promise<ToolResult> {
  ctx.report('正在定位城市中心')
  const result = await geocode(ctx.cityName, ctx.cityName)
  if (!result) {
    return { ok: false, error: `无法解析城市「${ctx.cityName}」的位置` }
  }

  return {
    ok: true,
    data: {
      city: result.city || ctx.cityName,
      adcode: result.adcode,
      centerLng: result.lng,
      centerLat: result.lat,
      hint: '可以用 search_poi 搜索该城市的酒店，挑出交通便利的区域作为住宿锚点',
    },
  }
}
