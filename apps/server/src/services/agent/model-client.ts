// 模型客户端：与 OpenAI 兼容接口通信，并处理「工具调用」的多轮往返。
//
// 什么是工具调用（tool calling）：
//   普通对话里模型只能凭记忆回答，很容易编造事实。工具调用则是让模型先「申请」去查资料：
//   它输出一句「我要调用 search_poi，关键词是西湖」，程序执行这个查询，
//   把真实结果塞回对话，模型再基于真实数据继续思考。
//   类比：考试时允许翻资料，但资料只能从指定的几本书里查，不许自己瞎写。
//
// 这一层的职责，就是把这个「申请 → 执行 → 回填」的来回跑完，直到模型给出最终答案。

import { describeHttpError, type ModelCredentials } from '../llm'

/** 模型要求调用某个工具时返回的结构（OpenAI 兼容格式） */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** 参数是 JSON 字符串，需要自己解析 */
    arguments: string
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** 仅 assistant 消息可能带：它希望调用的工具 */
  tool_calls?: ToolCall[]
  /** 仅 tool 消息需要：对应哪一次工具调用 */
  tool_call_id?: string
}

export interface ChatRequest {
  credentials: ModelCredentials
  messages: ChatMessage[]
  tools?: unknown[]
  /** 强制模型只输出 JSON。要求提示词里必须出现 json 字样，否则部分厂商会报错 */
  jsonMode?: boolean
  maxTokens?: number
  timeoutMs?: number
}

export interface ChatResponse {
  content: string
  toolCalls: ToolCall[]
  /**
   * 模型这次为什么停下。取值与含义：
   *   stop      正常说完
   *   length    撞到了「单次回复字数上限」，内容被**截断**了
   *   tool_calls 它要求调用工具
   *
   * 这个字段以前被丢掉了，代价很大：模型输出到一半被截断时，
   * 我们只能看到「JSON 解析失败」，无从判断到底是模型写错了格式还是话没说完。
   */
  finishReason: string
  usage?: { prompt: number; completion: number }
}

// 单次请求的超时。工具调用阶段模型回复通常很快，
// 但要求它一次性输出整条行程的 JSON 时会慢一些，所以给得比测试连接宽松。
const DEFAULT_TIMEOUT_MS = 90_000

/**
 * 单次回复允许的最大输出长度（token 数）。
 *
 * 为什么不省略这个参数：省略时用的是各厂商**各自的默认值**，
 * 而 DeepSeek 的默认值只有 4096。一条两天的行程 JSON，
 * 光把每个地点的推荐理由写详细些就很容易超过这个数——
 * 结果就是 JSON 被从中间截断，解析必然失败。
 * 这种失败还很「随机」：模型这次话少就过了，下次话多就挂，最难排查。
 *
 * 8192 是 DeepSeek 允许的上限。换用其他厂商时若报参数超限，
 * 可用环境变量 MODEL_MAX_OUTPUT_TOKENS 调小。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.MODEL_MAX_OUTPUT_TOKENS ?? 8192)

/** 发起一次对话请求。出错时抛出带中文说明的 Error */
export async function chatCompletion(request: ChatRequest): Promise<ChatResponse> {
  const baseUrl = request.credentials.baseUrl.replace(/\/+$/, '')
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const body: Record<string, unknown> = {
    model: request.credentials.modelName,
    messages: request.messages,
    stream: false,
    // 始终显式指定，别交给厂商默认值决定——默认值往往是截断的源头
    max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools
    body.tool_choice = 'auto'
  }
  if (request.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.credentials.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError'
    throw new Error(
      isTimeout
        ? `模型响应超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`
        : `无法连接模型接口 ${baseUrl}，请检查网络与接口地址`,
    )
  }

  // 先读文本再解析：网关报错时经常返回 HTML，直接 .json() 会抛出与真实原因无关的错误
  const rawText = await response.text()
  if (!response.ok) {
    throw new Error(describeHttpError(response.status, rawText, baseUrl))
  }

  let payload: {
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] }
      finish_reason?: string
    }[]
    error?: { message?: string }
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    payload = JSON.parse(rawText)
  } catch {
    throw new Error('模型返回的内容不是标准 JSON，可能是接口地址填错了')
  }

  if (payload.error) {
    throw new Error(`模型返回错误：${payload.error.message ?? '未知原因'}`)
  }

  const choice = payload.choices?.[0]
  const message = choice?.message
  if (!message) {
    throw new Error('模型没有返回任何内容')
  }

  return {
    content: message.content ?? '',
    toolCalls: message.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? 'unknown',
    usage: payload.usage
      ? { prompt: payload.usage.prompt_tokens ?? 0, completion: payload.usage.completion_tokens ?? 0 }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// 工具调用循环
// ---------------------------------------------------------------------------

export interface ToolLoopOptions {
  credentials: ModelCredentials
  systemPrompt: string
  userPrompt: string
  tools: unknown[]
  /** 执行一次工具调用。实现方负责校验参数、记录登记表 */
  executeTool: (name: string, args: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** 最多往返多少轮，防止模型反复调用工具停不下来 */
  maxRounds?: number
  /** 每轮开始前调用，可用来读取最新的进度或检查是否已被取消 */
  beforeRound?: (round: number) => void
  /** 调试日志 */
  log?: (line: string) => void
}

export interface ToolLoopResult {
  /** 模型最终给出的回答（这里期望是一段 JSON 文本） */
  content: string
  /** 完整对话记录，排查问题时很有用 */
  messages: ChatMessage[]
  rounds: number
  toolCallCount: number
  /** 最后一条回复的结束原因，length 说明被截断了 */
  finishReason: string
}

/**
 * 跑完整个「模型 ↔ 工具」循环，返回模型的最终回答。
 *
 * 退出条件有两个：模型不再请求调用工具（正常结束），
 * 或者轮数用尽（抛错，避免无限烧 token）。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.userPrompt },
  ]

  const maxRounds = options.maxRounds ?? 20
  let toolCallCount = 0

  for (let round = 1; round <= maxRounds; round++) {
    options.beforeRound?.(round)

    const reply = await chatCompletion({
      credentials: options.credentials,
      messages,
      tools: options.tools,
    })

    messages.push({
      role: 'assistant',
      content: reply.content || null,
      ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
    })

    // 不再请求工具，说明模型认为信息够了，这一条就是最终答案
    if (reply.toolCalls.length === 0) {
      return {
        content: reply.content,
        messages,
        rounds: round,
        toolCallCount,
        finishReason: reply.finishReason,
      }
    }

    for (const call of reply.toolCalls) {
      toolCallCount += 1
      options.log?.(`第 ${round} 轮：调用 ${call.function.name}`)
      const result = await options.executeTool(call.function.name, call.function.arguments)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  throw new Error(`模型在 ${maxRounds} 轮内仍未给出最终方案，可能陷入了反复调用工具`)
}

/**
 * 让模型把最终答案重新输出一遍。
 *
 * 为什么需要这一步：模型偶尔会把话说「毛边」——JSON 前后带解释、字符串里有没转义的换行、
 * 或者干脆写到一半撞上长度上限被截断。遇到这种情况，
 * 最省事的做法不是重跑一遍全部工具查询（那要几十秒、还把高德配额再烧一次），
 * 而是**保留已有对话，只追加一句提醒**，让它重说一遍。
 *
 * 两个刻意的设计：
 *   - 这一轮**不带工具**。工具一旦在场，模型就有机会又跑去调工具而不给出最终答案。
 *   - 开启 jsonMode（response_format=json_object），由接口层面强制它只输出 JSON，
 *     比在提示词里反复叮嘱可靠得多。注意：该参数要求提示词里出现 json 字样，
 *     所以下面的提醒语里必须包含「JSON」。
 */
export async function reaskForJson(options: {
  credentials: ModelCredentials
  messages: ChatMessage[]
  /** 上一次失败的具体原因，会原样转达给模型，让它知道该改什么 */
  feedback: string
  /** 让模型收敛篇幅，用于「上次被截断」的情形 */
  askShorter?: boolean
  log?: (line: string) => void
}): Promise<{ content: string; messages: ChatMessage[]; finishReason: string }> {
  const parts = [
    `你上一条回复不能被解析，原因：${options.feedback}`,
    '',
    '请重新输出最终结果，要求：',
    '1. 只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码块；',
    '2. 字符串内部不要出现未转义的换行与引号；',
    '3. 地点只能使用此前工具返回过的 poiId。',
  ]
  if (options.askShorter) {
    parts.push(
      '4. 上一次输出因超出长度上限被截断，这次请**明显缩短**每个地点的 note 与每天的 summary',
      '   （note 控制在 30 字以内），优先保证 JSON 结构完整。',
    )
  }

  const messages: ChatMessage[] = [
    ...options.messages,
    { role: 'user', content: parts.join('\n') },
  ]

  options.log?.('模型上一条输出不是合法 JSON，正在请它重新输出（不重跑工具查询）')

  const reply = await chatCompletion({
    credentials: options.credentials,
    messages,
    jsonMode: true,
  })

  messages.push({
    role: 'assistant',
    content: reply.content || null,
    ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
  })

  return { content: reply.content, messages, finishReason: reply.finishReason }
}
