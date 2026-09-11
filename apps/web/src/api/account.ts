// 账户设置的调用封装：当前用户信息、改名、改密码、头像。

import { api } from './client'

/** 当前登录用户信息。avatar 取值见后端：emoji:xx 为预设，/uploads/.. 为上传 */
export interface MeInfo {
  id: string
  username: string
  avatar: string | null
}

/** 获取当前登录用户（含头像） */
export async function fetchMe(): Promise<MeInfo> {
  const { data } = await api.get<{ user: MeInfo }>('/auth/me')
  return data.user
}

/** 修改用户名。改名后服务端签发新 token，调用方负责替换本地存储 */
export async function updateUsername(username: string): Promise<{ token: string; user: MeInfo }> {
  const { data } = await api.put<{ token: string; user: MeInfo }>('/auth/profile', { username })
  return data
}

/** 修改密码 */
export async function updatePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.put('/auth/password', { oldPassword, newPassword })
}

/** 选择预设头像（emoji:xx）或指向已上传文件的地址 */
export async function setAvatar(avatar: string): Promise<MeInfo> {
  const { data } = await api.post<{ user: MeInfo }>('/auth/avatar', { avatar })
  return data.user
}

/** 上传自定义头像。data 是压缩后的 dataURL（base64 文本），返回可用的头像地址 */
export async function uploadAvatar(data: string): Promise<{ user: MeInfo; url: string }> {
  const { data: result } = await api.post<{ user: MeInfo; url: string }>('/auth/avatar/upload', {
    data,
  })
  return result
}

/** 「我的信息有更新」事件名。改完用户名或头像后广播，让顶栏立即刷新显示 */
export const ME_UPDATED_EVENT = 'me-updated'
