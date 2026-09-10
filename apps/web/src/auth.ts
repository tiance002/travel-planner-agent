// 登录凭证的本地存取。
//
// 这里用 localStorage 保存 JWT。它的特点是持久（关掉浏览器再打开还在），
// 缺点是无法防住 XSS（页面里被注入的恶意脚本可以读走它）。
// 对个人项目够用；若将来要做严格的安全加固，可改成 httpOnly Cookie 方案。

const TOKEN_KEY = 'travel_planner_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// 从 JWT 里读出用户名，仅用于界面展示。
// 注意：这里只做解码、不做验签，因此绝不能用来做任何权限判断——
// 真正的校验永远在后端完成。
export function getUsernameFromToken(): string | null {
  const token = getToken()
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1])) as { username?: string }
    return payload.username ?? null
  } catch {
    return null
  }
}
