// 个人设置相关的接口调用。
// 注意：服务端只会返回 Key 的掩码，这里也就没有「读取明文」这件事。

import { api } from './client'

export interface ModelStatus {
  /** 展示用的厂商名称，例如 DeepSeek */
  provider: string
  /** OpenAI 兼容接口地址 */
  baseUrl: string
  /** 模型名称，例如 deepseek-chat */
  modelName: string
  /** 服务端是否存有可解密的 Key */
  hasApiKey: boolean
  /** 掩码形式，例如 sk-abc••••••••klmn */
  maskedKey: string
  keyVersion: number
  updatedAt: string | null
  /** 用户没配 Key，但服务端有全局默认可用 */
  fallbackAvailable: boolean
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs: number
  reply?: string
}

export async function fetchModelStatus(): Promise<ModelStatus> {
  const { data } = await api.get<ModelStatus>('/settings/model')
  return data
}

export async function saveModelConfig(payload: {
  provider: string
  baseUrl: string
  modelName: string
  /** 不传表示保持原有 Key 不变；传空字符串表示清除 */
  apiKey?: string
}): Promise<ModelStatus> {
  const { data } = await api.put<ModelStatus>('/settings/model', payload)
  return data
}

export async function clearModelConfig(): Promise<ModelStatus> {
  const { data } = await api.delete<ModelStatus>('/settings/model')
  return data
}

export async function testModelConnection(payload: {
  baseUrl: string
  modelName: string
  apiKey?: string
}): Promise<TestResult> {
  const { data } = await api.post<TestResult>('/settings/model/test', payload)
  return data
}
