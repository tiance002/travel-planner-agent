// 认证路由：注册、登录、查询当前登录用户，以及账户设置（改名、改密码、头像）。

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { signToken } from '../utils/jwt'
import { hashPassword, verifyPassword } from '../utils/password'

export const authRouter = Router()

/** 头像上传目录。文件由 /uploads 静态服务对外提供 */
export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads')

// 用 zod 校验入参。zod 是什么：一个「数据格式检查器」，
// 在数据进入业务逻辑之前先确认字段存在、类型正确、长度合规，
// 不合法就直接返回 400，避免脏数据往后流。
const registerSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_]{3,32}$/, '用户名需为 3-32 位字母、数字或下划线'),
  password: z.string().min(8, '密码至少 8 位').max(72, '密码过长'),
})

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
})

// 注册
authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const { username, password } = parsed.data

    const exists = await prisma.user.findUnique({ where: { username } })
    if (exists) {
      res.status(409).json({ error: '该用户名已被占用' })
      return
    }

    const user = await prisma.user.create({
      data: { username, passwordHash: await hashPassword(password) },
    })

    // 注册成功后直接返回登录凭证，用户不需要再登录一次
    res.status(201).json({
      token: signToken({ userId: user.id, username: user.username }),
      user: { id: user.id, username: user.username },
    })
  } catch (err) {
    next(err)
  }
})

// 登录
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: '请输入用户名和密码' })
      return
    }

    const { username, password } = parsed.data
    const user = await prisma.user.findUnique({ where: { username } })

    // 注意：用户不存在与密码错误返回同一个提示，
    // 否则攻击者可以靠提示差异逐个试出哪些用户名真实存在。
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ error: '用户名或密码错误' })
      return
    }

    res.json({
      token: signToken({ userId: user.id, username: user.username }),
      user: { id: user.id, username: user.username },
    })
  } catch (err) {
    next(err)
  }
})

// 查询当前登录用户，用于前端刷新页面后确认登录态是否仍然有效。
// 顺带返回头像：左侧栏与顶部都要显示，每次都查一次库（单表主键查询，开销可忽略）
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, username: true, avatar: true },
    })
    if (!user) {
      res.status(404).json({ error: '用户不存在' })
      return
    }
    res.json({ user })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// 账户设置
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_]{3,32}$/, '用户名需为 3-32 位字母、数字或下划线'),
})

// 修改用户名。改名后旧 token 里装的还是旧用户名，所以要把新 token 一并返回，
// 前端替换本地存储的凭证，用户无需重新登录
authRouter.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const parsed = profileSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const { username } = parsed.data
    const exists = await prisma.user.findUnique({ where: { username } })
    if (exists && exists.id !== req.user!.userId) {
      res.status(409).json({ error: '该用户名已被占用' })
      return
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { username },
      select: { id: true, username: true, avatar: true },
    })

    res.json({
      token: signToken({ userId: user.id, username: user.username }),
      user,
    })
  } catch (err) {
    next(err)
  }
})

const passwordSchema = z.object({
  oldPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(72, '密码过长'),
})

// 修改密码。必须先验旧密码——这是账户系统最基本的自我保护
authRouter.put('/password', requireAuth, async (req, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } })
    if (!user || !(await verifyPassword(parsed.data.oldPassword, user.passwordHash))) {
      res.status(400).json({ error: '当前密码不正确' })
      return
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    })

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

const avatarSchema = z.object({
  /** 两种取值：「emoji:🌿」系统预设；「/uploads/...」已上传文件的地址 */
  avatar: z.string().max(120),
})

// 设置头像（预设或已上传的地址）。上传动作走 /avatar/upload，这里只负责「选中哪张」
authRouter.post('/avatar', requireAuth, async (req, res, next) => {
  try {
    const parsed = avatarSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: '头像参数不合法' })
      return
    }

    const { avatar } = parsed.data
    const isPreset = avatar.startsWith('emoji:')
    const isUploaded = avatar.startsWith('/uploads/avatar-')
    if (!isPreset && !isUploaded) {
      res.status(400).json({ error: '不支持的头像地址' })
      return
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { avatar },
      select: { id: true, username: true, avatar: true },
    })

    res.json({ user })
  } catch (err) {
    next(err)
  }
})

// 上传自定义头像。前端把图片压缩成 dataURL（base64 文本）整包发来，
// 服务端解码后落到 uploads 目录。不做裁剪——压缩在前端做，服务端只验安全边界。
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const MAX_AVATAR_BYTES = 300 * 1024

const avatarUploadSchema = z.object({
  /** dataURL 形如 data:image/png;base64,xxxx */
  data: z.string().min(1, '缺少图片数据'),
})

authRouter.post('/avatar/upload', requireAuth, async (req, res, next) => {
  try {
    const parsed = avatarUploadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
      return
    }

    const match = /^data:([a-z]+\/[a-z0-9+-]+);base64,(.+)$/s.exec(parsed.data.data)
    if (!match) {
      res.status(400).json({ error: '图片数据格式不正确' })
      return
    }

    const ext = ALLOWED_IMAGE_TYPES[match[1]]
    if (!ext) {
      res.status(400).json({ error: '只支持 PNG / JPG / WebP 格式的图片' })
      return
    }

    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
      res.status(400).json({ error: '图片需小于 300KB，请换一张或压缩后再上传' })
      return
    }

    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    // 文件名带 userId：一人一份，重复上传直接覆盖旧文件，不会互相影响
    const filename = `avatar-${req.user!.userId}.${ext}`
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer)

    // 带随机参数防缓存：换头像后浏览器要立刻看到新图
    const url = `/uploads/${filename}?v=${randomUUID().slice(0, 8)}`
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { avatar: url.split('?')[0] },
      select: { id: true, username: true, avatar: true },
    })

    res.json({ user, url })
  } catch (err) {
    next(err)
  }
})
