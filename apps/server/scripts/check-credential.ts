// 运维脚本：检查某个用户已保存的模型凭据是否真的可用。
//
// 用途：用户在「个人设置」里填完 Key 后，如果 AI 功能仍报错，
// 用这个脚本直接读库解密并发起一次最小请求，快速区分是
// 「Key 填错了」「地址填错了」还是「业务代码的问题」。
//
// 用法（必须在 apps/server 目录下执行）：
//   npx tsx scripts/check-credential.ts [用户名]
//
// 安全约定：脚本只打印 Key 的掩码，绝不输出明文。

import { prisma } from '../src/db'
import { testCredentials } from '../src/services/llm'
import { decryptSecret, maskSecret } from '../src/utils/vault'

const username = process.argv[2] ?? '123'

const user = await prisma.user.findUnique({
  where: { username },
  include: { setting: true },
})

if (!user) {
  console.log(`未找到用户名 ${username}`)
  process.exit(1)
}

const setting = user.setting
if (!setting) {
  console.log(`用户 ${username} 还没有保存任何模型配置`)
  process.exit(1)
}

console.log(`用户名：${user.username}`)
console.log(`厂商：${setting.provider || '（未填）'}`)
console.log(`接口地址：${setting.baseUrl || '（未填）'}`)
console.log(`模型名称：${setting.modelName || '（未填）'}`)
console.log(`主密钥版本：${setting.keyVersion}`)

// 有密文不代表能解开：主密钥被换过就解不开了，所以这里实际解一次
if (!setting.apiKeyCipher || !setting.apiKeyIv || !setting.apiKeyTag) {
  console.log('API Key：未配置')
  process.exit(1)
}

let apiKey: string
try {
  apiKey = decryptSecret({
    cipher: setting.apiKeyCipher,
    iv: setting.apiKeyIv,
    tag: setting.apiKeyTag,
  })
} catch {
  console.log('API Key：解密失败，通常是 VAULT_MASTER_KEY 与写入时不一致，需要重新填写')
  process.exit(1)
}

console.log(`API Key：${maskSecret(apiKey)}（长度 ${apiKey.length}）`)
console.log('\n正在发起一次最小对话请求……')

const result = await testCredentials({
  provider: setting.provider,
  baseUrl: setting.baseUrl,
  modelName: setting.modelName,
  apiKey,
})

console.log(`结果：${result.ok ? '可用' : '不可用'}`)
console.log(`说明：${result.message}`)
if (result.reply) console.log(`模型回复：${result.reply}`)

await prisma.$disconnect()
process.exit(result.ok ? 0 : 1)
