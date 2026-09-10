// 高德能力代理路由。
//
// 为什么要绕一层后端：高德 Web 服务 Key 一旦下发到浏览器就等于公开，
// 会被任意人拿去刷配额（直接影响费用）。所以浏览器只调自家的 /api/amap/*，
// 由后端带着 Key 去请求高德，再把归一化结果返回。
//
// 唯一的例外是地图渲染用的 JS API Key —— 它本来就必须出现在浏览器里，
// 靠控制台的域名白名单保护，因此通过 /config 接口下发。

import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { config } from '../config'
import { requireAuth } from '../middleware/auth'
import {
  AmapError,
  geocode,
  getWeather,
  planRoute,
  regeocode,
  searchPoiAround,
  searchPoiText,
} from '../services/amap'

export const amapRouter = Router()

// 高德所有能力都要求登录后再用，避免被当作公开代理刷配额
amapRouter.use(requireAuth)

/**
 * 统一的处理包装：把高德返回的业务错误转成 502（上游服务异常），
 * 其余未预期的错误交给全局错误处理，避免把内部细节泄露给前端。
 */
function route(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res)
    } catch (err) {
      if (err instanceof AmapError) {
        res.status(502).json({ error: err.message, infocode: err.infocode })
        return
      }
      next(err)
    }
  }
}

// 查询参数统一按字符串进来，这里用 coerce 做类型转换
const geocodeQuery = z.object({
  address: z.string().min(1, '缺少 address 参数'),
  city: z.string().optional(),
})

const regeoQuery = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
})

const poiTextQuery = z.object({
  keywords: z.string().min(1, '缺少 keywords 参数'),
  region: z.string().optional(),
  types: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(25).optional(),
  pageNum: z.coerce.number().int().min(1).max(8).optional(),
})

const poiAroundQuery = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
  keywords: z.string().optional(),
  types: z.string().optional(),
  radius: z.coerce.number().int().min(1).max(50_000).optional(),
  sortRule: z.enum(['distance', 'weight']).optional(),
  pageSize: z.coerce.number().int().min(1).max(25).optional(),
  pageNum: z.coerce.number().int().min(1).max(8).optional(),
})

const weatherQuery = z.object({
  adcode: z.string().regex(/^\d{6}$/, 'adcode 必须是 6 位行政区划编码'),
})

const directionQuery = z.object({
  mode: z.enum(['driving', 'walking', 'bicycling', 'transit']),
  originLng: z.coerce.number(),
  originLat: z.coerce.number(),
  destLng: z.coerce.number(),
  destLat: z.coerce.number(),
  city1: z.string().optional(),
  city2: z.string().optional(),
})

// 下发地图渲染所需的 JS API 配置。
// 注意这里永远不包含 Web 服务 Key。
amapRouter.get(
  '/config',
  route(async (_req, res) => {
    res.json({
      jsKey: config.amapJsKey,
      securityCode: config.amapJsSecurityCode,
      // 让前端能明确提示「地图未配置」，而不是白屏后一头雾水
      configured: Boolean(config.amapJsKey && config.amapJsSecurityCode),
    })
  }),
)

// 地址 → 经纬度与行政区划编码。新建行程时用它把「目的地城市」解析成 adcode
amapRouter.get(
  '/geocode',
  route(async (req, res) => {
    const parsed = geocodeQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }
    const result = await geocode(parsed.data.address, parsed.data.city)
    if (!result) {
      res.status(404).json({ error: '未能解析该地址，请换一个更具体的名称试试' })
      return
    }
    res.json({ result })
  }),
)

// 经纬度 → 地址。用户在地图上点选位置时用它转成可读地名
amapRouter.get(
  '/regeo',
  route(async (req, res) => {
    const parsed = regeoQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: '缺少合法的经纬度' })
      return
    }
    const result = await regeocode(parsed.data.lng, parsed.data.lat)
    if (!result) {
      res.status(404).json({ error: '该位置没有对应的地址信息' })
      return
    }
    res.json({ result })
  }),
)

// POI 关键字搜索。搜酒店（types=100000）、景点（110000）、餐厅（050000）都走这里
amapRouter.get(
  '/poi/text',
  route(async (req, res) => {
    const parsed = poiTextQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }
    const pois = await searchPoiText(parsed.data)
    res.json({ pois })
  }),
)

// POI 周边搜索。以住宿为圆心找餐厅时用它，结果自带 distance
amapRouter.get(
  '/poi/around',
  route(async (req, res) => {
    const parsed = poiAroundQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }
    const pois = await searchPoiAround(parsed.data)
    res.json({ pois })
  }),
)

// 天气。注意高德仅提供约 4 天预报，超出窗口返回空数组
amapRouter.get(
  '/weather',
  route(async (req, res) => {
    const parsed = weatherQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }
    const result = await getWeather(parsed.data.adcode)
    if (!result) {
      res.json({ weather: null, note: '该城市暂无预报数据' })
      return
    }
    res.json({ weather: result })
  }),
)

// 路径规划。返回真实距离、耗时与可直接绘制的路线折线
amapRouter.get(
  '/direction',
  route(async (req, res) => {
    const parsed = directionQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }
    const result = await planRoute(parsed.data)
    res.json({ route: result })
  }),
)
