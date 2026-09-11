// 高德地图的 React 封装组件。
//
// 职责边界：只负责「把数据画到地图上」和「把用户的交互回传出去」，
// 不关心业务含义（什么算景点、什么算住宿由调用方决定）。
//
// 三个刻意的设计：
//   1. 回调统一放进 ref，避免父组件每次渲染都重建全部标记点；
//   2. 地图实例只创建一次，组件卸载时彻底销毁，防止 React 严格模式下重复初始化；
//   3. 脚本加载失败时给出可读的提示，而不是留一块白板。

import { Spin, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { loadAmap, type AmapEvent, type AmapMapInstance, type AmapOverlay } from '../amap/loader'

/** 地图上的一个标记点 */
export interface MapMarker {
  /** 唯一标识，点击时回传给调用方 */
  id: string
  lng: number
  lat: number
  /** 标记上显示的文字，通常是一天的序号或简短名称，最多两个字符 */
  label?: string
  /** 是否为选中态。选中态用实心高亮色，未选中用空心样式 */
  active?: boolean
  /** 是否已打卡。已打卡用实心绿点 + 对勾角标 */
  done?: boolean
  /** 形态：pin 是水滴形（用于住宿锚点），dot 是圆点（用于景点） */
  shape?: 'dot' | 'pin'
}

interface AmapMapProps {
  /** 地图初始中心。变化时会重新定位（不会重置缩放之外的状态） */
  center?: [number, number]
  zoom?: number
  markers?: MapMarker[]
  /** 折线，格式 "lng,lat;lng,lat;..."，直接使用高德路径规划返回的原始串 */
  polyline?: string
  /** 点击标记的回调 */
  onMarkerClick?: (id: string) => void
  /** 点击地图空白处的回调，返回经纬度。用于让用户在地图上直接点选位置 */
  onMapClick?: (lng: number, lat: number) => void
  /** 标记或折线变化后是否自动缩放到全部可见 */
  fitToContent?: boolean
  height?: number
}

/** 把用户可见的文字转义，避免拼进 HTML 时破坏结构 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 生成标记点的自定义 HTML。用 DOM 而不是高德默认图标，是为了让选中态更醒目 */
function markerHtml(marker: MapMarker): string {
  const escape = escapeHtml(marker.label ?? '')

  if (marker.shape === 'pin') {
    // 水滴形：住宿锚点。选中时放大并加深颜色
    const color = marker.active ? '#fa541c' : '#1677ff'
    const size = marker.active ? 30 : 26
    return (
      `<div style="transform:translateY(-50%);">` +
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}">` +
      `<path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/>` +
      `<circle cx="12" cy="9" r="2.8" fill="#fff"/></svg>` +
      (escape ? `<div style="color:#fff;font-size:11px;text-align:center;margin-top:-28px;position:relative;">${escape}</div>` : '') +
      `</div>`
    )
  }

  // 圆点：景点。默认空心（白底蓝边），选中后实心并带一圈光晕
  if (marker.active) {
    return (
      `<div style="position:relative;width:26px;height:26px;transform:translate(-50%,-50%);">` +
      `<span style="position:absolute;inset:0;border-radius:50%;background:rgba(22,119,255,.25);animation:amap-pulse 1.6s ease-out infinite;"></span>` +
      `<span style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#1677ff;border:2px solid #fff;box-shadow:0 0 0 1px #1677ff;"></span>` +
      `</div>`
    )
  }

  // 已打卡：实心绿点 + 右上角对勾角标，与列表卡片的置灰状态呼应
  if (marker.done) {
    return (
      `<div style="position:relative;transform:translate(-50%,-50%);">` +
      `<span style="display:block;width:12px;height:12px;border-radius:50%;background:#52c41a;border:2px solid #fff;box-shadow:0 0 0 1px #52c41a;"></span>` +
      `<span style="position:absolute;left:8px;top:-8px;width:14px;height:14px;border-radius:50%;background:#52c41a;color:#fff;font-size:9px;line-height:14px;text-align:center;">✓</span>` +
      `</div>`
    )
  }

  return (
    `<div style="position:relative;transform:translate(-50%,-50%);">` +
    `<span style="display:block;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #1677ff;"></span>` +
    (escape ? `<span style="position:absolute;left:50%;top:-18px;transform:translateX(-50%);font-size:11px;color:#1677ff;white-space:nowrap;">${escape}</span>` : '') +
    `</div>`
  )
}

/** 把 "lng,lat;lng,lat" 解析成高德 Polyline 需要的坐标数组 */
function parsePolyline(polyline: string): [number, number][] {
  return polyline
    .split(';')
    .map((pair) => {
      const [lng, lat] = pair.split(',').map(Number)
      return [lng, lat] as [number, number]
    })
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
}

// 选中标记的脉冲动画。高德的自定义标记是普通 DOM，所以需要自己注入一次关键帧
const PULSE_KEYFRAMES = '@keyframes amap-pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.2);opacity:0}}'

export default function AmapMap({
  center,
  zoom = 13,
  markers = [],
  polyline,
  onMarkerClick,
  onMapClick,
  fitToContent = false,
  height = 460,
}: AmapMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<AmapMapInstance | null>(null)
  const overlaysRef = useRef<AmapOverlay[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorText, setErrorText] = useState('')

  // 回调放进 ref：这样父组件重新渲染时不会导致标记点被全部重建
  const markerClickRef = useRef(onMarkerClick)
  const mapClickRef = useRef(onMapClick)
  useEffect(() => {
    markerClickRef.current = onMarkerClick
    mapClickRef.current = onMapClick
  })

  // 注入脉冲动画的关键帧，只需一次
  useEffect(() => {
    if (document.getElementById('amap-pulse-style')) return
    const style = document.createElement('style')
    style.id = 'amap-pulse-style'
    style.textContent = PULSE_KEYFRAMES
    document.head.appendChild(style)
  }, [])

  // 创建地图实例。只执行一次，卸载时销毁
  useEffect(() => {
    let disposed = false

    loadAmap()
      .then((AMap) => {
        if (disposed || !containerRef.current) return

        const map = new AMap.Map(containerRef.current, {
          zoom,
          center: center ?? [116.397428, 39.90923],
          viewMode: '2D',
          // 关闭自带的缩放控件样式差异，保持界面统一
          resizeEnable: true,
        })

        map.on('click', (e: AmapEvent) => {
          const lnglat = e.lnglat
          if (!lnglat || !mapClickRef.current) return
          const lng = typeof lnglat.getLng === 'function' ? lnglat.getLng() : lnglat.lng
          const lat = typeof lnglat.getLat === 'function' ? lnglat.getLat() : lnglat.lat
          mapClickRef.current(lng, lat)
        })

        mapRef.current = map
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (disposed) return
        setStatus('error')
        setErrorText(err instanceof Error ? err.message : '地图加载失败')
      })

    return () => {
      disposed = true
      overlaysRef.current = []
      mapRef.current?.destroy()
      mapRef.current = null
    }
    // 故意只在挂载时执行一次：中心点变化由下面的独立 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 中心点变化时重新定位
  useEffect(() => {
    if (status !== 'ready' || !center) return
    mapRef.current?.setCenter(center)
    mapRef.current?.setZoom(zoom)
  }, [status, center?.[0], center?.[1], zoom])

  // 重绘标记点与折线。数据变化时先清掉旧的覆盖物再画新的，
  // 比逐个 diff 简单可靠，标记数量在几十个以内性能完全够用。
  useEffect(() => {
    const map = mapRef.current
    if (status !== 'ready' || !map || !window.AMap) return

    const AMap = window.AMap
    if (overlaysRef.current.length > 0) {
      map.remove(overlaysRef.current)
      overlaysRef.current = []
    }

    const created: AmapOverlay[] = []

    if (polyline) {
      const path = parsePolyline(polyline)
      if (path.length > 1) {
        created.push(
          new AMap.Polyline({
            path,
            strokeColor: '#1677ff',
            strokeWeight: 5,
            strokeOpacity: 0.85,
            lineJoin: 'round',
            zIndex: 50,
          }),
        )
      }
    }

    for (const marker of markers) {
      const overlay = new AMap.Marker({
        position: [marker.lng, marker.lat],
        content: markerHtml(marker),
        anchor: 'center',
        zIndex: marker.active ? 200 : 100,
      })
      // 用闭包捕获当前标记的 id，点击时回传
      overlay.on('click', () => markerClickRef.current?.(marker.id))
      created.push(overlay)
    }

    if (created.length > 0) {
      map.add(created)
      overlaysRef.current = created
      if (fitToContent) {
        map.setFitView(created, false, [60, 60, 60, 60])
      }
    }
  }, [status, markers, polyline, fitToContent])

  return (
    <div style={{ position: 'relative', height, borderRadius: 8, overflow: 'hidden', background: '#f0f2f5' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {status === 'loading' && (
        <div style={overlayStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Spin size="large" />
            <Typography.Text type="secondary">地图加载中…</Typography.Text>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div style={overlayStyle}>
          <Typography.Text type="danger" style={{ maxWidth: 320, textAlign: 'center' }}>
            {errorText}
          </Typography.Text>
        </div>
      )}
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255,255,255,.85)',
}
