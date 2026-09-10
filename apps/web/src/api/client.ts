// 统一的请求封装。
//
// axios 的「拦截器」是什么：在请求真正发出前、以及响应回来后插入的一段公共逻辑。
// 类比：公司收发室，所有寄出的信都会自动贴上工牌编号，所有退回的信都会统一登记。
// 这里用它做两件事：自动带上登录凭证、遇到 401 自动登出。

import axios from 'axios'
import { clearToken, getToken } from '../auth'

export const api = axios.create({
  // 走相对路径 /api，由 Vite 的开发代理转发到后端，因此不需要写完整域名
  baseURL: '/api',
  timeout: 20000,
})

// 请求拦截：自动附加登录凭证
api.interceptors.request.use((requestConfig) => {
  const token = getToken()
  if (token) {
    requestConfig.headers.Authorization = `Bearer ${token}`
  }
  return requestConfig
})

// 响应拦截：登录态失效时清掉本地凭证并回到登录页
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearToken()
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

// 把后端返回的错误消息提取出来，方便页面直接展示
export function extractError(error: unknown, fallback = '请求失败，请稍后再试'): string {
  if (axios.isAxiosError(error)) {
    return (error.response?.data as { error?: string } | undefined)?.error ?? fallback
  }
  return fallback
}
