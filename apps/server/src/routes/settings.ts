// 个人设置：模型厂商与 API Key 的管理接口。
//
// 设计要点——明文 Key 永远不下发：
//   前端提交明文（HTTPS 加密传输中），服务端立刻用主密钥加密落库，
//   之后任何查询接口都只返回形如 sk-abc••••••••klmn 的掩码。
//   这样即使有人在你的浏览器里注入脚本，也偷不到 Key。

import { Router } from 'express'
import { z } from 'zod'
import { config } from '../config'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { getCredentialsForUser, testCredentials } from '../services/llm'
import { decryptSecret, encryptSecret, maskSecret } from '../utils/vault'

export const settingsRouter = Router()

// 所有设置接口都必须登录后才能访问
settingsRouter.use(requireAuth)

// 允许的接口地址：必须是 http/https。
// 这里不限制具体域名，因为用户可能自建代理或使用中转服务。
const httpUrl = z
  .string()
  .trim()
  .refine((value) => value === '' || /^https?:\/\/\S+$/i.test(value), '接口地址需要以 http:// 或 https:// 开头')

const saveSchema = z.object({
  provider: z.string().trim().max(40, '厂商名称过长').default(''),
  baseUrl: httpUrl.default(''),
  modelName: z.string().trim().max(100, '模型名称过长').default(''),
  // 三态：不传 = 保持原 Key 不动；传空字符串 = 清除 Key；传非空 = 覆盖
  apiKey: z.string().trim().max(500, 'API Key 过长').optional(),
})

const testSchema = z.object({
  baseUrl: httpUrl.default(''),
  modelName: z.string().trim().max(100).default(''),
  apiKey: z.string().trim().max(500).optional(),
})

// 把数据库记录整理成前端需要的形状，绝不包含明文
async function buildStatus(userId: string) {
  const setting = await prisma.userSetting.findUnique({ where: { userId } })

  // 有密文并不代表能解开——主密钥被换过就解不开了，所以这里实际解一次做校验
  let maskedKey = ''
  let keyReadable = false
  if (setting?.apiKeyCipher && setting.apiKeyIv && setting.apiKeyTag) {
    try {
      const plain = decryptSecret({
        cipher: setting.apiKeyCipher,
        iv: setting.apiKeyIv,
        tag: setting.apiKeyTag,
      })
      maskedKey = maskSecret(plain)
      keyReadable = true
    } catch {
      keyReadable = false
    }
  }

  // 是否正靠环境变量里的全局默认 Key 在工作（开发联调时的便利通道）
  const fallbackKey = config.defaultModelApiKey

  return {
    provider: setting?.provider ?? '',
    baseUrl: setting?.baseUrl ?? '',
    modelName: setting?.modelName ?? '',
    hasApiKey: keyReadable,
    maskedKey,
    keyVersion: setting?.keyVersion ?? 1,
    updatedAt: setting?.updatedAt ?? null,
    // 提示前端：用户还没配 Key，但服务端有全局默认可用
    fallbackAvailable: !keyReadable && Boolean(fallbackKey),
  }
}

// 查询当前配置
settingsRouter.get('/model', async (req, res, next) => {
  try {
    res.json(await buildStatus(req.user!.userId))
  } catch (err) {
    next(err)
  }
})

// 保存配置
settingsRouter.put('/model', async (req, res, next) => {
  try {
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const userId = req.user!.userId
    const { provider, baseUrl, modelName, apiKey } = parsed.data

    // 先取出旧记录，用于「不传 apiKey 时保留原值」以及「清除时不误删配置」
    const existing = await prisma.userSetting.findUnique({ where: { userId } })

    const data: Record<string, unknown> = { provider, baseUrl, modelName }

    if (apiKey !== undefined) {
      if (apiKey === '') {
        // 用户主动清除 Key
        data.apiKeyCipher = null
        data.apiKeyIv = null
        data.apiKeyTag = null
      } else {
        const encrypted = encryptSecret(apiKey)
        data.apiKeyCipher = Buffer.from(encrypted.cipher)
        data.apiKeyIv = Buffer.from(encrypted.iv)
        data.apiKeyTag = Buffer.from(encrypted.tag)
        data.keyVersion = encrypted.keyVersion
      }
    } else if (!existing) {
      // 首次保存且没带 Key，字段留空即可
      data.apiKeyCipher = null
      data.apiKeyIv = null
      data.apiKeyTag = null
    }

    await prisma.userSetting.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })

    res.json(await buildStatus(userId))
  } catch (err) {
    next(err)
  }
})

// 清空全部模型配置
settingsRouter.delete('/model', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    await prisma.userSetting.deleteMany({ where: { userId } })
    res.json(await buildStatus(userId))
  } catch (err) {
    next(err)
  }
})

// 测试连接。
// 允许直接带草稿参数来测，用户不必「先保存再测」；
// 没带 Key 时会依次尝试已保存的 Key 和环境变量里的全局默认。
settingsRouter.post('/model/test', async (req, res, next) => {
  try {
    const parsed = testSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const userId = req.user!.userId
    const fallback = await getCredentialsForUser(userId)

    const credentials = {
      provider: parsed.data.modelName ? parsed.data.modelName : (fallback?.provider ?? ''),
      baseUrl: parsed.data.baseUrl || fallback?.baseUrl || '',
      modelName: parsed.data.modelName || fallback?.modelName || '',
      apiKey: parsed.data.apiKey || fallback?.apiKey || '',
    }

    if (!credentials.apiKey) {
      res.status(400).json({
        error: '请先填写 API Key，或先保存一份可用的配置',
      })
      return
    }

    res.json(await testCredentials(credentials))
  } catch (err) {
    next(err)
  }
})
