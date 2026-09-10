// 模型服务的调用封装。
//
// 统一走「OpenAI 兼容协议」：DeepSeek、通义千问、智谱、月之暗面等国内厂商
// 都提供形状一致的 /chat/completions 接口，请求体里放模型名和消息数组即可。
// 好处是换厂商只需要改「接口地址 + 模型名 + Key」三个值，代码一行都不用动。
//
// 本文件目前只做一件事：验证用户填的凭据是否真的能调通。
// AI 排程（P4）会复用这里的凭据读取与请求封装。

import { config } from '../config'
import { prisma } from '../db'
import { decryptSecret } from '../utils/vault'

export interface ModelCredentials {
  provider: string
  baseUrl: string
  modelName: string
  apiKey: string
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs: number
  /** 模型返回的原文片段，用于确认对方确实在正常工作 */
  reply?: string
}

// 规范化接口地址：去掉尾部斜杠和首尾空格。
// 这里刻意不做「自动补 /v1」这类猜测——不同厂商的路径规则不一样
// （DeepSeek 是 /v1，智谱是 /api/paas/v4，通义是 /compatible-mode/v1），
// 猜错了反而会让用户对着一个错的地址排查半天。前端预设里给出完整地址。
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

// 超时时间。模型接口偶尔会很慢，但超过这个时间说明网络或地址有问题，
// 早点报错比让用户干等强。
const REQUEST_TIMEOUT_MS = 20000

// 调用一次最简短的对话，用来验证凭据可用。
// 参数 max_tokens 设得很小，测试连接只花极少量的 token。
export async function testCredentials(credentials: ModelCredentials): Promise<TestResult> {
  const startedAt = Date.now()
  const baseUrl = normalizeBaseUrl(credentials.baseUrl)

  if (!baseUrl || !credentials.modelName.trim() || !credentials.apiKey.trim()) {
    return { ok: false, message: '接口地址、模型名称、API Key 三项都不能为空', latencyMs: 0 }
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: credentials.modelName.trim(),
        messages: [{ role: 'user', content: '请只回复两个字：正常' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    // AbortSignal 超时与网络不可达都会走到这里，需要区分开给用户不同提示
    const isTimeout = error instanceof Error && error.name === 'TimeoutError'
    return {
      ok: false,
      latencyMs,
      message: isTimeout
        ? `请求超时（超过 ${REQUEST_TIMEOUT_MS / 1000} 秒），请检查接口地址或网络`
        : `无法连接到 ${baseUrl}，请确认接口地址正确、网络通畅`,
    }
  }

  const latencyMs = Date.now() - startedAt

  // 先把响应体读成文本再尝试解析 JSON。
  // 有些网关出错时返回的是 HTML 错误页，直接 response.json() 会抛出一个
  // 与真实原因无关的解析错误，掩盖掉真正的问题。
  const rawText = await response.text()

  if (!response.ok) {
    return { ok: false, latencyMs, message: describeHttpError(response.status, rawText, baseUrl) }
  }

  let payload: {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string }
  }
  try {
    payload = JSON.parse(rawText)
  } catch {
    return {
      ok: false,
      latencyMs,
      message: '接口返回的内容不是标准 JSON，可能填的是网页地址而非 API 地址',
    }
  }

  // HTTP 200 也不代表成功：部分厂商会把错误放在响应体里返回
  if (payload.error) {
    return { ok: false, latencyMs, message: `模型返回错误：${payload.error.message ?? '未知原因'}` }
  }

  const reply = payload.choices?.[0]?.message?.content?.trim() ?? ''
  return {
    ok: true,
    latencyMs,
    reply: reply.slice(0, 60),
    message: `连接成功，模型已响应（耗时 ${latencyMs} 毫秒）`,
  }
}

// 把 HTTP 状态码翻译成用户能看懂的话。
// 直接甩「HTTP 401」给用户，他是不知道该改哪里的。
function describeHttpError(status: number, body: string, baseUrl: string): string {
  // 尽量把厂商返回的原始错误信息也带上，便于排查
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    detail = parsed.error?.message ?? ''
  } catch {
    detail = body.slice(0, 120)
  }

  const suffix = detail ? `：${detail}` : ''

  switch (status) {
    case 400:
      return `请求被拒绝（400），通常是模型名称写错了${suffix}`
    case 401:
    case 403:
      return `API Key 无效或没有权限（${status}），请重新复制粘贴${suffix}`
    case 402:
      return `账户余额不足（402），请到厂商控制台充值${suffix}`
    case 404:
      return `接口地址不正确（404），系统会在该地址后拼接 /chat/completions，请确认地址是否多了或少了路径段（当前：${baseUrl}）${suffix}`
    case 429:
      return `请求太频繁或已达到限额（429），稍后再试${suffix}`
    default:
      return `调用失败（HTTP ${status}）${suffix}`
  }
}

// 读取某个用户的有效凭据，按「用户自己配置的 → 环境变量里的全局默认」顺序回退。
// 全局默认是为了方便开发联调：还没在界面上填 Key 时也能跑通 AI 排程。
export async function getCredentialsForUser(userId: string): Promise<ModelCredentials | null> {
  const setting = await prisma.userSetting.findUnique({ where: { userId } })

  if (setting?.apiKeyCipher && setting.apiKeyIv && setting.apiKeyTag) {
    let apiKey: string
    try {
      apiKey = decryptSecret({
        cipher: setting.apiKeyCipher,
        iv: setting.apiKeyIv,
        tag: setting.apiKeyTag,
      })
    } catch {
      // 解密失败通常意味着 VAULT_MASTER_KEY 被换过，此时不能带病继续跑，
      // 回退到全局默认或让上层提示用户重新填写。
      apiKey = ''
    }

    if (apiKey) {
      return {
        provider: setting.provider,
        baseUrl: setting.baseUrl,
        modelName: setting.modelName,
        apiKey,
      }
    }
  }

  const fallbackKey = config.defaultModelApiKey
  if (fallbackKey) {
    return {
      provider: config.defaultModelProvider,
      baseUrl: config.defaultModelBaseUrl,
      modelName: config.defaultModelName,
      apiKey: fallbackKey,
    }
  }

  return null
}
