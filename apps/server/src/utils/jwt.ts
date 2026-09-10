// JWT 的签发与校验。
//
// JWT 是什么：一段由服务器签名过的字符串，里面装着「你是谁」的信息。
// 客户端每次请求带上它，服务器验签通过就认为你是登录状态，
// 因此服务器不需要在内存里保存会话。类比：游乐园盖在手背上的隐形印章，
// 出门再进来只看印章，不用重新排队登记。

import jwt from 'jsonwebtoken'
import { config } from '../config'

// 登录凭证有效期。过期后需要重新登录。
const EXPIRES_IN = '7d'

export interface TokenPayload {
  userId: string
  username: string
}

// 签发登录凭证
export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: EXPIRES_IN })
}

// 校验登录凭证。签名不对或已过期都返回 null，由调用方决定如何响应。
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload
  } catch {
    return null
  }
}
