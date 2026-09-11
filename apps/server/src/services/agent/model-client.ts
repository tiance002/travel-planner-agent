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
  usage?: { prompt: number; completion: number }
}

// 单次请求的超时。工具调用阶段模型回复通常很快，
// 但要求它一次性输出整条行程的 JSON 时会慢一些，所以给得比测试连接宽松。
const DEFAULT_TIMEOUT_MS = 90_000

/** 发起一次对话请求。出错时抛出带中文说明的 Error */
export async function chatCompletion(request: ChatRequest): Promise<ChatResponse> {
  const baseUrl = request.credentials.baseUrl.replace(/\/+$/, '')
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const body: Record<string, unknown> = {
    model: request.credentials.modelName,
    messages: request.messages,
    stream: false,
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools
    body.tool_choice = 'auto'
  }
  if (request.jsonMode) {
    body.response_format = { type: 'json_object' }
  }
  if (request.maxTokens) {
    body.max_tokens = request.maxTokens
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
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
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

  const message = payload.choices?.[0]?.message
  if (!message) {
    throw new Error('模型没有返回任何内容')
  }

  return {
    content: message.content ?? '',
    toolCalls: message.tool_calls ?? [],
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
      return { content: reply.content, messages, rounds: round, toolCallCount }
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
