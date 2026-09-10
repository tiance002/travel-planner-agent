// 高德 JS API 的动态加载器。
//
// 为什么不用 <script> 标签写死在 index.html 里：
//   1. Key 由后端下发，不在前端构建产物里留痕，换 Key 不需要重新打包；
//   2. 只有真正打开地图的页面才加载这 500 多 KB 的脚本，首屏更快。
//
// 关键坑：高德安全密钥必须在脚本「加载之前」挂到 window._AMapSecurityConfig 上。
// 顺序反了会报 INVALID_USER_SCODE，地图白屏且错误信息很隐晦。

import { api } from '../api/client'

/** 高德 JS API 入口脚本。v=2.0 是当前主版本 */
const SCRIPT_BASE = 'https://webapi.amap.com/maps?v=2.0&key='

// --- 高德 SDK 的最小类型声明 -------------------------------------------------
// 高德官方没有随包提供 TypeScript 类型，这里只声明实际用到的部分，
// 既能让类型检查通过，也不会因为大段 any 失去意义。

/** 经纬度对象，高德 SDK 里的 LngLat */
export interface AmapLngLat {
  lng: number
  lat: number
  getLng(): number
  getLat(): number
}

/** 地图事件对象。不同事件携带的字段不同，这里只声明我们用得到的 */
export interface AmapEvent {
  lnglat?: AmapLngLat
  target?: AmapOverlay
}

/** 覆盖物（标记点、折线等）的公共方法 */
export interface AmapOverlay {
  setMap(map: AmapMapInstance | null): void
  setPosition?(position: [number, number]): void
  getExtData?(): unknown
  on(event: string, handler: (e: AmapEvent) => void): void
  off?(event: string, handler: (e: AmapEvent) => void): void
}

/** 地图实例 */
export interface AmapMapInstance {
  add(overlay: AmapOverlay | AmapOverlay[]): void
  remove(overlay: AmapOverlay | AmapOverlay[]): void
  clearMap(): void
  setCenter(center: [number, number]): void
  setZoom(zoom: number, immediately?: boolean): void
  setFitView(overlays?: AmapOverlay[], immediately?: boolean, avoid?: number[]): void
  on(event: string, handler: (e: AmapEvent) => void): void
  off(event: string, handler: (e: AmapEvent) => void): void
  destroy(): void
}

/** 高德 SDK 的全局命名空间 */
export interface AmapNamespace {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMapInstance
  Marker: new (options: Record<string, unknown>) => AmapOverlay
  Polyline: new (options: Record<string, unknown>) => AmapOverlay
  LngLat: new (lng: number, lat: number) => AmapLngLat
}

declare global {
  interface Window {
    AMap?: AmapNamespace
    _AMapSecurityConfig?: { securityJsCode?: string }
  }
}

/** 后端下发的客户端地图配置 */
interface AmapClientConfig {
  jsKey: string
  securityCode: string
  configured: boolean
}

// 加载中的 Promise。多个组件同时请求时共享同一次加载，避免重复插入脚本
let loading: Promise<AmapNamespace> | null = null

/** 往页面里插入一段脚本，加载完成或失败时兑现 Promise */
function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existed = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existed) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    // 网络不通或域名白名单不匹配都会走到这里
    script.onerror = () => reject(new Error('高德地图脚本加载失败，请检查网络，以及 Key 的域名白名单是否包含当前地址'))
    document.head.appendChild(script)
  })
}

/**
 * 加载高德 JS API。
 * 失败时会把缓存的 Promise 清空，这样用户重试（例如刷新页面后）不会一直被同一个失败结果挡住。
 */
export async function loadAmap(): Promise<AmapNamespace> {
  if (window.AMap) return window.AMap
  if (loading) return loading

  loading = (async () => {
    const { data } = await api.get<AmapClientConfig>('/amap/config')
    if (!data.configured) {
      throw new Error('地图尚未配置：请在 apps/server/.env 中填写高德 JS API Key 与安全密钥')
    }

    // 必须在插入脚本之前设置，顺序不能颠倒
    window._AMapSecurityConfig = { securityJsCode: data.securityCode }

    await injectScript(`${SCRIPT_BASE}${data.jsKey}`)

    if (!window.AMap) {
      throw new Error('高德地图脚本已加载，但未能初始化，请确认 Key 类型为「Web端(JS API)」')
    }
    return window.AMap
  })()

  try {
    return await loading
  } catch (err) {
    loading = null
    throw err
  }
}
