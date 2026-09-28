import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'

// Supply harmless configuration fixtures; this test never contacts external APIs.
process.env.JWT_SECRET = 'proxy-check-fixture'
process.env.VAULT_MASTER_KEY = '0'.repeat(64)
process.env.AMAP_WEB_SERVICE_KEY = 'fixture'
process.env.AMAP_JS_KEY = 'fixture'
const { parseTrustedProxies } = await import('../src/config')
const { rateLimit, resetRateLimits } = await import('../src/middleware/rate-limit')

assert.equal(parseTrustedProxies(''), undefined, 'empty configuration must leave Express untrusted')
assert.equal(parseTrustedProxies('1'), 1, 'a bare number is a trusted hop count')
assert.deepEqual(parseTrustedProxies('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8'])

async function withServer(trustProxy: number | string | string[] | undefined, callback: (base: string) => Promise<void>) {
  const app = express()
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy)
  app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }))
  app.get('/limited', rateLimit({ prefix: `proxy-check-${Math.random()}`, limit: 1, windowMs: 60_000 }), (_req, res) => {
    res.json({ ok: true })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    await callback(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

// Default mode: a client supplied XFF header cannot change req.ip or evade
// the limiter.  The fetch calls exercise the real Express parser and socket.
resetRateLimits()
await withServer(undefined, async base => {
  const ip = await fetch(`${base}/ip`, { headers: { 'X-Forwarded-For': '198.51.100.7' } })
  const parsed = await ip.json() as { ip: string; ips: string[] }
  assert.notEqual(parsed.ip, '198.51.100.7', 'untrusted XFF must not become req.ip')

  const first = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': '198.51.100.1' } })
  const second = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': '198.51.100.2' } })
  assert.equal(first.status, 200)
  assert.equal(second.status, 429, 'changing a forged XFF must not evade rate limiting')
})

// Trusted deployments opt in explicitly.  One trusted hop selects the nearest
// forwarded client address; a CIDR rule gives the same result from this local
// test server.
await withServer(parseTrustedProxies('1'), async base => {
  const response = await fetch(`${base}/ip`, {
    headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' },
  })
  // With one trusted hop Express exposes the nearest forwarded address as
  // req.ip; req.ips intentionally excludes addresses beyond that trust edge.
  assert.deepEqual(await response.json(), { ip: '203.0.113.9', ips: ['203.0.113.9'] })
})
await withServer(parseTrustedProxies('127.0.0.1/32'), async base => {
  const response = await fetch(`${base}/ip`, {
    headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' },
  })
  assert.equal((await response.json() as { ip: string }).ip, '203.0.113.9')
})

console.log('✓ trusted proxy parsing and real Express rate-limit requests')
