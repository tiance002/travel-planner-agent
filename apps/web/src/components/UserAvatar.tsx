// 头像展示组件：把用户头像字段渲染成统一大小的圆形头像。
//
// avatar 字段有三种情况：
//   「emoji:🌿」  系统预设，直接把 emoji 渲染出来（悠闲风：用旅行主题的 emoji 当头像）
//   「/uploads/..」用户上传的图片地址
//   null / 其他    默认人形图标

import { Avatar } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import type { CSSProperties } from 'react'

interface UserAvatarProps {
  avatar?: string | null
  username?: string
  size?: number
  style?: CSSProperties
}

export default function UserAvatar({ avatar, username, size = 32, style }: UserAvatarProps) {
  // emoji 预设：Avatar 里直接放字符，字号随尺寸缩放
  if (avatar && avatar.startsWith('emoji:')) {
    return (
      <Avatar
        size={size}
        style={{ fontSize: size * 0.55, lineHeight: `${size}px`, ...style }}
        aria-label={`${username ?? '用户'}的头像`}
      >
        {avatar.slice('emoji:'.length)}
      </Avatar>
    )
  }

  // 用户上传：img 方式渲染，加载失败时 antd 会自动回落到图标
  if (avatar && avatar.startsWith('/uploads/')) {
    return (
      <Avatar size={size} src={avatar} icon={<UserOutlined />} style={style} />
    )
  }

  return <Avatar size={size} icon={<UserOutlined />} style={style} />
}
