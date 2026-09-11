// 运维脚本：把一个用户的模型配置复制给另一个用户。
//
// 用途：完整端到端冒烟（SMOKE_GENERATE=1）需要测试账号有真实可用的模型 Key，
// 但测试账号不该手工填 Key。用这个脚本把主账号的配置借给测试账号；
// 冒烟脚本结尾会自己「清除配置」，借出去的凭据不会留在测试账号里。
//
// 用法（必须在 apps/server 目录下执行）：
//   npx tsx scripts/copy-credential.ts <来源用户名> <目标用户名>
//
// 安全约定：密文、IV、认证标签整组原样复制（同一主密钥下可解），
// 脚本只在结尾打印掩码确认，绝不输出明文。

import { prisma } from '../src/db'
import { maskSecret, decryptSecret } from '../src/utils/vault'

const [, , fromName, toName] = process.argv
if (!fromName || !toName) {
  console.log('用法：npx tsx scripts/copy-credential.ts <来源用户名> <目标用户名>')
  process.exit(1)
}

const from = await prisma.user.findUnique({
  where: { username: fromName },
  include: { setting: true },
})
if (!from) {
  console.log(`未找到来源用户 ${fromName}`)
  process.exit(1)
}
const source = from.setting
if (!source?.apiKeyCipher || !source.apiKeyIv || !source.apiKeyTag) {
  console.log(`来源用户 ${fromName} 没有已保存的模型配置`)
  process.exit(1)
}

const to = await prisma.user.findUnique({
  where: { username: toName },
  include: { setting: true },
})
if (!to) {
  console.log(`未找到目标用户 ${toName}`)
  process.exit(1)
}

// 密文直接复制：主密钥是全局唯一的，同一份密文在任何用户下解出的明文相同
await prisma.userSetting.upsert({
  where: { userId: to.id },
  create: {
    userId: to.id,
    provider: source.provider,
    baseUrl: source.baseUrl,
    modelName: source.modelName,
    apiKeyCipher: source.apiKeyCipher,
    apiKeyIv: source.apiKeyIv,
    apiKeyTag: source.apiKeyTag,
    keyVersion: source.keyVersion,
  },
  update: {
    provider: source.provider,
    baseUrl: source.baseUrl,
    modelName: source.modelName,
    apiKeyCipher: source.apiKeyCipher,
    apiKeyIv: source.apiKeyIv,
    apiKeyTag: source.apiKeyTag,
    keyVersion: source.keyVersion,
  },
})

// 解一次确认复制出来的凭据是完整可解的
const plain = decryptSecret({
  cipher: source.apiKeyCipher,
  iv: source.apiKeyIv,
  tag: source.apiKeyTag,
})

console.log(`已把 ${fromName} 的模型配置复制给 ${toName}`)
console.log(`  厂商：${source.provider}  模型：${source.modelName}`)
console.log(`  API Key：${maskSecret(plain)}`)

await prisma.$disconnect()
