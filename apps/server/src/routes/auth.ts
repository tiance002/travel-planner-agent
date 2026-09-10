// 认证路由：注册、登录、查询当前登录用户。

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { signToken } from '../utils/jwt'
import { hashPassword, verifyPassword } from '../utils/password'

export const authRouter = Router()

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

// 查询当前登录用户，用于前端刷新页面后确认登录态是否仍然有效
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})
