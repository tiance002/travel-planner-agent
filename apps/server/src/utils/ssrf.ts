// SSRF 防护：校验用户自定义的模型接口地址。
//
// 背景（见审查报告 A01 / 9.2）：
//   用户可以在「个人设置」里填任意 http/https baseUrl，服务端随后会主动请求
//   这个地址的 /chat/completions。公开注册后，这会形成一个 SSRF 攻击面：
//   攻击者填 `http://169.254.169.254/latest/meta-data/`（云 metadata）或
//   `http://127.0.0.1:3306` 之类的地址，就能让服务器代替他去访问内网。
//
// 防护四层（与报告建议一一对应）：
//   1. 只允许 http/https，生产环境进一步只允许 https；
//   2. 解析 DNS 后逐个检查目标 IP，拒绝环回、私网、link-local、云 metadata 等保留地址；
//   3. 禁止自动重定向（fetch redirect:'manual'），避免「先给一个公网地址、
//      再 302 到内网」绕过检查；
//   4. 对地址里的主机名做同样的检查——HTTP 层的校验独立于 DNS，两者都要过。
//
// 注意：这里不追求「完整覆盖所有 DNS 重绑定场景」（那需要自定义 agent 在连接层
// 校验实际对端 IP）。作为上线阻断级别的第一道防线，本模块已经把报告点名的
// 风险路径全部堵住；更理想的做法是让模型请求走受控的 egress proxy。

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** 校验失败时抛出，路由层统一转成 400 返回给用户 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/** 允许/拒绝的判定结果 */
export interface UrlCheckResult {
  ok: boolean
  /** 不通过时的中文原因，可直接返回给用户 */
  reason?: string
}

/**
 * 判断一个 IP 是否属于「不该被服务器访问」的保留/内网地址段。
 *
 * 覆盖：
 *   - IPv4：0.0.0.0/8、10/8、127/8、169.254/16（含 169.254.169.254 云 metadata）、
 *     172.16/12、192.168/16、100.64/10（CGNAT）、192.0.0/24、198.18/15、224/4（组播）、240/4
 *   - IPv6：::（未指定）、::1（环回）、fc00::/7（ULA）、fe80::/10（link-local）、
 *     ::ffff:x.x.x.x（IPv4 映射，递归按 IPv4 判）、ff00::/8（组播）
 */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIpv4(ip)
  if (version === 6) return isBlockedIpv6(ip)
  // 无法识别的字面量一律拒绝：宁可误伤也不能放行未知形式
  return true
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = parts

  if (a === 0) return true // 0.0.0.0/8 「本网络」
  if (a === 10) return true // 私有
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // link-local + 云 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 私有
  if (a === 192 && b === 168) return true // 私有
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF 保留
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播 + 保留（224.0.0.0/4、240.0.0.0/4）
  return false
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0] // 去掉 zone id（fe80::1%eth0）

  // IPv4 映射地址 ::ffff:1.2.3.4 与兼容地址 ::1.2.3.4，递归按 IPv4 规则判
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)
  if (mapped) return isBlockedIpv4(mapped[1])

  if (normalized === '::' || normalized === '::1') return true // 未指定 / 环回
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')) return true // fe80::/10
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const firstGroup = parseInt(normalized.split(':')[0] || '0', 16)
  if ((firstGroup & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((firstGroup & 0xff00) === 0xff00) return true // ff00::/8 组播
  return false
}

/** 判断主机名是否是明显的本地名称（无需 DNS 就能识别） */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  // 云厂商 metadata 的常见主机名
  if (host === 'metadata' || host === 'metadata.google.internal') return true
  return false
}

/**
 * 校验一个用户自定义的模型接口地址是否安全。
 *
 * @param raw 用户填写的 baseUrl
 * @param options.requireHttps 生产环境传 true，只允许 https
 * @param options.resolveDns 是否对主机名做 DNS 解析并检查解析结果（默认 true；
 *   写单元测试时可关掉，避免测试依赖真实 DNS）
 */
export async function assertSafeModelBaseUrl(
  raw: string,
  options: { requireHttps?: boolean; resolveDns?: boolean } = {},
): Promise<UrlCheckResult> {
  const { requireHttps = process.env.NODE_ENV === 'production', resolveDns = true } = options
  const value = raw.trim()
  if (!value) return { ok: false, reason: '接口地址不能为空' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: '接口地址格式不正确，请填写完整的 http(s):// 地址' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '接口地址只支持 http:// 或 https://' }
  }
  if (requireHttps && url.protocol !== 'https:') {
    return { ok: false, reason: '生产环境只允许 HTTPS 的模型接口地址' }
  }

  const hostname = url.hostname
  if (!hostname) return { ok: false, reason: '接口地址缺少主机名' }
  if (isLocalHostname(hostname)) {
    return { ok: false, reason: '接口地址不能指向本机或内网域名' }
  }

  // 主机名本身就是 IP 字面量：直接判定，不做 DNS
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { ok: false, reason: '接口地址指向内网或保留地址，已被拒绝' }
    }
    return { ok: true }
  }

  if (!resolveDns) return { ok: true }

  // 域名：解析出所有 A/AAAA 记录，任何一个落在禁用段就整体拒绝
  let records: { address: string }[]
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    return { ok: false, reason: `无法解析接口地址的域名 ${hostname}，请确认地址是否正确` }
  }
  if (records.length === 0) {
    return { ok: false, reason: `域名 ${hostname} 没有解析到任何地址` }
  }
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      return { ok: false, reason: '接口地址解析到了内网或保留地址，已被拒绝' }
    }
  }

  return { ok: true }
}

/**
 * 供调用方使用的断言版本：不通过时抛 UnsafeUrlError。
 * 路由层与 model-client 都直接调它，保证「保存」「测试」「真正发起请求」三处
 * 用的是同一套判定，不存在哪条路径漏检。
 */
export async function assertSafeModelBaseUrlOrThrow(
  raw: string,
  options: { requireHttps?: boolean; resolveDns?: boolean } = {},
): Promise<string> {
  const result = await assertSafeModelBaseUrl(raw, options)
  if (!result.ok) throw new UnsafeUrlError(result.reason ?? '接口地址不安全')
  return raw.trim()
}
