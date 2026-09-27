// SSRF 防护与限流可信来源的自检（见审查报告任务1、任务3、任务9）。
//
// 为什么单独一个脚本：这两块是**安全边界**，一旦退化不会在功能上表现出来，
// 只会在被利用时才暴露。所以把「已知攻击形态」固化成用例，每次改代码都跑一遍。
//
// 用法：在 apps/server 目录 `npx tsx scripts/check-ssrf.ts`

import { assertSafeModelBaseUrl, isBlockedIp, UnsafeUrlError, assertSafeModelBaseUrlOrThrow } from '../src/utils/ssrf'
import { clientIp, rateKey, rateLimit, resetRateLimits } from '../src/middleware/rate-limit'
import type { Request } from 'express'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name}`)
  }
}

// ---------------------------------------------------------------------------
// 1. IP 黑名单：受限地址必须全部拦下，公网地址必须放行
// ---------------------------------------------------------------------------

console.log('\n--- SSRF：IP 黑名单 ---')

// 受限段（全部应为 true = 拦截）
const blocked = [
  '127.0.0.1', // 环回
  '127.1.2.3', // 环回整段
  '10.0.0.5', // 私有
  '172.16.0.1', // 私有
  '172.31.255.254', // 私有边界
  '192.168.1.1', // 私有
  '169.254.169.254', // 云 metadata（AWS/GCP/Aliyun）
  '100.64.0.1', // CGNAT
  '0.0.0.0', // 本网络
  '224.0.0.1', // 组播
  '255.255.255.255', // 广播
  '198.18.0.1', // 基准测试段
  '::1', // IPv6 环回
  '::', // IPv6 未指定
  'fe80::1', // IPv6 link-local
  'fc00::1', // IPv6 ULA
  'fd12:3456::1', // IPv6 ULA
  '::ffff:127.0.0.1', // IPv4 映射到环回
  '::ffff:10.0.0.1', // IPv4 映射到私网
  '::ffff:169.254.169.254', // IPv4 映射到 metadata
]
for (const ip of blocked) {
  check(`拦截 ${ip}`, isBlockedIp(ip), true)
}

// 公网地址（应为 false = 放行）
const allowed = ['8.8.8.8', '1.1.1.1', '223.5.5.5', '2001:4860:4860::8888']
for (const ip of allowed) {
  check(`放行 ${ip}`, isBlockedIp(ip), false)
}

// 非法字面量一律拒绝
check('拒绝无法识别的字面量', isBlockedIp('not-an-ip'), true)

// ---------------------------------------------------------------------------
// 2. URL 校验：协议、内网地址、域名
// ---------------------------------------------------------------------------

console.log('\n--- SSRF：URL 校验 ---')

// 非 http/https 协议
check(
  '拒绝 file:// 协议',
  (await assertSafeModelBaseUrl('file:///etc/passwd', { resolveDns: false })).ok,
  false,
)
check(
  '拒绝 gopher:// 协议',
  (await assertSafeModelBaseUrl('gopher://127.0.0.1:6379/', { resolveDns: false })).ok,
  false,
)

// 直接填内网 IP 字面量
check(
  '拒绝 http://127.0.0.1',
  (await assertSafeModelBaseUrl('http://127.0.0.1:8080', { resolveDns: false })).ok,
  false,
)
check(
  '拒绝云 metadata 地址',
  (await assertSafeModelBaseUrl('http://169.254.169.254/latest/meta-data/', { resolveDns: false })).ok,
  false,
)
check(
  '拒绝 IPv4 映射的环回',
  (await assertSafeModelBaseUrl('http://[::ffff:127.0.0.1]/v1', { resolveDns: false })).ok,
  false,
)
check(
  '拒绝 localhost',
  (await assertSafeModelBaseUrl('http://localhost:11434/v1', { resolveDns: false })).ok,
  false,
)
check(
  '拒绝 .internal 域名',
  (await assertSafeModelBaseUrl('http://db.internal/v1', { resolveDns: false })).ok,
  false,
)

// 生产环境强制 https
check(
  '生产环境拒绝 http 明文地址',
  (await assertSafeModelBaseUrl('http://api.deepseek.com/v1', { requireHttps: true, resolveDns: false })).ok,
  false,
)
check(
  '生产环境放行 https 地址',
  (await assertSafeModelBaseUrl('https://api.deepseek.com/v1', { requireHttps: true, resolveDns: false })).ok,
  true,
)

// 合法公网地址
check(
  '放行合法模型地址',
  (await assertSafeModelBaseUrl('https://api.deepseek.com/v1', { resolveDns: false })).ok,
  true,
)
check(
  '放行合法公网 IP 地址',
  (await assertSafeModelBaseUrl('https://223.5.5.5/v1', { resolveDns: false })).ok,
  true,
)

// 空值与非法格式
check('拒绝空地址', (await assertSafeModelBaseUrl('', { resolveDns: false })).ok, false)
check('拒绝非 URL 字符串', (await assertSafeModelBaseUrl('随便写的', { resolveDns: false })).ok, false)

// 断言版本确实会抛错
let threw = false
try {
  await assertSafeModelBaseUrlOrThrow('http://127.0.0.1/v1', { resolveDns: false })
} catch (error) {
  threw = error instanceof UnsafeUrlError
}
check('OrThrow 版本对不安全地址抛 UnsafeUrlError', threw, true)

// ---------------------------------------------------------------------------
// 3. 限流客户端标识：伪造 X-Forwarded-For 不得改变身份键（任务3）
// ---------------------------------------------------------------------------

console.log('\n--- 限流：客户端 IP 可信来源 ---')

/** 构造一个最小的假 Request，只为验证 clientIp 的取值逻辑 */
function fakeReq(opts: {
  xff?: string
  ip?: string
  socketRemote?: string
}): Request {
  return {
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    ip: opts.ip,
    socket: { remoteAddress: opts.socketRemote },
  } as unknown as Request
}

// 关键回归点：客户端自己塞 XFF，不得影响 clientIp。
// 原实现「优先取 XFF 第一段」会让攻击者每次换一个值来绕过限流。
check(
  '伪造 XFF 不影响 clientIp（取 req.ip）',
  clientIp(fakeReq({ xff: '1.2.3.4', ip: '203.0.113.9' })),
  '203.0.113.9',
)
check(
  'XFF 与 req.ip 不同时，以 req.ip 为准',
  clientIp(fakeReq({ xff: '9.9.9.9, 8.8.8.8', ip: '203.0.113.9' })),
  '203.0.113.9',
)
check(
  '没有 req.ip 时回退 socket 地址',
  clientIp(fakeReq({ xff: '1.2.3.4', socketRemote: '198.51.100.7' })),
  '198.51.100.7',
)
check(
  '两者都没有时返回 unknown',
  clientIp(fakeReq({})),
  'unknown',
)

// 登录用户按 userId 区分，未登录按 IP
check(
  '登录用户用 userId 作为限流键',
  rateKey({ user: { userId: 'u-1' }, headers: {}, ip: '1.2.3.4', socket: {} } as unknown as Request, 'auth'),
  'auth:u:u-1',
)
check(
  '未登录用 IP 作为限流键',
  rateKey({ headers: {}, ip: '1.2.3.4', socket: {} } as unknown as Request, 'auth'),
  'auth:ip:1.2.3.4',
)

// ---------------------------------------------------------------------------
// 4. 限流中间件：超限返回 429，且不因伪造 XFF 被绕过
// ---------------------------------------------------------------------------

console.log('\n--- 限流：中间件行为 ---')

resetRateLimits()

/** 跑一次限流中间件，返回它是否放行（true = 通过，false = 被 429 拦下） */
function runLimit(mw: ReturnType<typeof rateLimit>, req: Request): boolean {
  let passed = false
  const res = {
    statusCode: 200,
    setHeader: () => {},
    status(code: number) {
      this.statusCode = code
      return this
    },
    json: () => {},
  }
  mw(req, res as never, () => {
    passed = true
  })
  return passed
}

const limiter = rateLimit({ prefix: 'test', limit: 3, windowMs: 60_000 })
const reqA = fakeReq({ ip: '10.9.9.9' })
check('第 1 次放行', runLimit(limiter, reqA), true)
check('第 2 次放行', runLimit(limiter, reqA), true)
check('第 3 次放行', runLimit(limiter, reqA), true)
check('第 4 次被拦（超限）', runLimit(limiter, reqA), false)

// 换一个 IP 是另一个桶，不受影响
check('不同 IP 独立计数', runLimit(limiter, fakeReq({ ip: '10.9.9.10' })), true)

// 关键回归点：同一个 IP 携带不断变化的伪造 XFF，仍应落在同一个桶里被限流。
// 这正是原实现「优先信 XFF」会失效的场景。
const reqSpoof1 = fakeReq({ xff: 'aaa', ip: '10.9.9.20' })
const reqSpoof2 = fakeReq({ xff: 'bbb', ip: '10.9.9.20' })
const reqSpoof3 = fakeReq({ xff: 'ccc', ip: '10.9.9.20' })
const reqSpoof4 = fakeReq({ xff: 'ddd', ip: '10.9.9.20' })
runLimit(limiter, reqSpoof1)
runLimit(limiter, reqSpoof2)
runLimit(limiter, reqSpoof3)
check('伪造不同 XFF 无法绕过限流（第 4 次被拦）', runLimit(limiter, reqSpoof4), false)

resetRateLimits()

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\nSSRF 与限流自检：${pass}/${pass + fail} 通过`)
if (fail > 0) {
  console.log('\n未通过的用例：')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
