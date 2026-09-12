// V5 端到端：验证决策记录落库（genDecisions）
const API = 'http://127.0.0.1:3001/api'

let r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'smoke_bot', password: 'SmokeTest2026!' }),
})
const token = (await r.json()).token
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const trips = (await (await fetch(`${API}/trips`, { headers: auth })).json()).trips ?? []
const target = trips.find((t) => t.status !== 'generating') ?? trips[0]
console.log('测试行程：', target.id)

await fetch(`${API}/trips/${target.id}/generate`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ mode: 'restart' }),
})
console.log('触发生成')

for (let i = 0; i < 180; i++) {
  await new Promise((res) => setTimeout(res, 2000))
  const t = await (await fetch(`${API}/trips/${target.id}`, { headers: auth })).json()
  const detail = t.trip ?? t
  if (detail.status === 'ready') {
    // 检查决策记录
    const decisions = detail.genDecisions ? JSON.parse(detail.genDecisions) : []
    console.log('✅ 生成成功，决策记录', decisions.length, '条：')
    for (const d of decisions) console.log('   -', d)
    process.exit(decisions.length > 0 ? 0 : 1)
  }
  if (detail.status === 'failed') {
    console.log('❌ 失败：', detail.genError)
    process.exit(1)
  }
}
console.log('❌ 超时')
process.exit(1)
