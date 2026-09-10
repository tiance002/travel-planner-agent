// P3 阶段验证脚本：模型 API Key 的加密存储链路。
//
// 验证内容（不依赖真实模型 Key，全部可离线跑通）：
//   1. 未登录时访问设置接口被拒
//   2. 保存配置后，查询接口只返回掩码，不回传明文
//   3. 数据库里落库的是密文，且不包含明文片段
//   4. 不传 apiKey 时保持原 Key 不变
//   5. 传空字符串时清除 Key
//   6. 用无效 Key 测试连接会返回可读的失败原因
//
// 用法：node --experimental-sqlite tools/verify-p3.mjs
// （需要后端已在 3001 端口运行：npm run dev:server）

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(here, '..', 'apps', 'server', 'prisma', 'dev.db')
const BASE = 'http://127.0.0.1:3001/api'

// 一串明显是假的 Key，用于验证「明文不会落库」
const FAKE_KEY = 'sk-p3testabcdefghijklmnop9999'

let passed = 0
let failed = 0

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.log(`  ✘ ${name}${extra ? ` —— ${extra}` : ''}`)
  }
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  return { status: response.status, data }
}

async function main() {
  console.log('\n[1] 未登录时的访问控制')
  const anonymous = await api('/settings/model')
  check('未带凭证返回 401', anonymous.status === 401, `实际 ${anonymous.status}`)

  console.log('\n[2] 准备一个干净的测试账号')
  const username = `p3_${Date.now().toString(36)}`
  const registered = await api('/auth/register', {
    method: 'POST',
    body: { username, password: 'p3-verify-pass' },
  })
  check('注册成功并拿到凭证', registered.status === 201 && Boolean(registered.data?.token))
  const token = registered.data?.token

  console.log('\n[3] 保存模型配置（含 API Key）')
  const saved = await api('/settings/model', {
    method: 'PUT',
    token,
    body: {
      provider: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat',
      apiKey: FAKE_KEY,
    },
  })
  check('保存返回 200', saved.status === 200, `实际 ${saved.status}`)
  check('标记为已配置 Key', saved.data?.hasApiKey === true)
  check('返回的掩码不等于明文', saved.data?.maskedKey !== FAKE_KEY)
  check(
    '响应体里不含明文 Key',
    !JSON.stringify(saved.data ?? {}).includes(FAKE_KEY),
  )
  check('掩码保留首尾特征', /^sk-p3t•+9999$/.test(saved.data?.maskedKey ?? ''), `实际 ${saved.data?.maskedKey}`)

  console.log('\n[4] 数据库落库检查')
  const db = new DatabaseSync(DB_PATH)
  const row = db
    .prepare('SELECT apiKeyCipher, apiKeyIv, apiKeyTag, keyVersion FROM UserSetting ORDER BY updatedAt DESC LIMIT 1')
    .get()
  db.close()

  check('数据库中存在密钥记录', Boolean(row))
  const cipherBuffer = row?.apiKeyCipher ? Buffer.from(row.apiKeyCipher) : null
  check('密文为非空二进制', Boolean(cipherBuffer && cipherBuffer.length > 0))
  check(
    '密文中查不到明文片段',
    Boolean(cipherBuffer) && !cipherBuffer.toString('utf8').includes('p3test'),
    cipherBuffer ? `长度 ${cipherBuffer.length}` : '无密文',
  )
  check('初始向量为 12 字节', row?.apiKeyIv ? Buffer.from(row.apiKeyIv).length === 12 : false)
  check('认证标签为 16 字节', row?.apiKeyTag ? Buffer.from(row.apiKeyTag).length === 16 : false)
  check('主密钥版本号已写入', row?.keyVersion === 1)

  console.log('\n[5] 不传 apiKey 时保持原 Key')
  const untouched = await api('/settings/model', {
    method: 'PUT',
    token,
    body: { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-reasoner' },
  })
  check('仍显示已配置', untouched.data?.hasApiKey === true)
  check('掩码与之前一致', untouched.data?.maskedKey === saved.data?.maskedKey)
  check('模型名已更新', untouched.data?.modelName === 'deepseek-reasoner')

  console.log('\n[6] 用无效 Key 测试连接（预期失败但信息可读）')
  const tested = await api('/settings/model/test', {
    method: 'POST',
    token,
    body: {
      baseUrl: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat',
      apiKey: FAKE_KEY,
    },
  })
  check('接口正常返回', tested.status === 200, `实际 ${tested.status}`)
  check('结果为失败', tested.data?.ok === false)
  check('给出了可读的失败原因', typeof tested.data?.message === 'string' && tested.data.message.length > 4, tested.data?.message)

  console.log('\n[7] 传空字符串清除 Key')
  const cleared = await api('/settings/model', {
    method: 'PUT',
    token,
    body: { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', apiKey: '' },
  })
  check('标记为未配置 Key', cleared.data?.hasApiKey === false)
  check('掩码已清空', cleared.data?.maskedKey === '')

  console.log('\n[8] 清理测试账号')
  const removed = await api('/settings/model', { method: 'DELETE', token })
  check('清除接口返回 200', removed.status === 200, `实际 ${removed.status}`)

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本执行出错：', error)
  process.exit(1)
})
