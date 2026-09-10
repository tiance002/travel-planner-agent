// 密码哈希。
//
// 使用 Node 内置的 crypto.scrypt，而不是 bcrypt / argon2 这类第三方库，
// 原因是它们包含需要本地编译的原生模块，在 Windows 上经常因为缺少
// C++ 构建工具而安装失败。scrypt 是 Node 标准库自带的，零依赖、无需编译。
//
// scrypt 是什么：一种「故意算得很慢」的哈希算法。普通哈希（如 MD5）算得飞快，
// 攻击者拿到数据库后可以每秒尝试几十亿次密码；scrypt 把每次计算的开销拉高，
// 让暴力尝试变得不划算。类比：把门锁换成需要拧 1 万圈才能开的保险柜。

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

// N：CPU 与内存开销因子，越大越慢越安全
// r：块大小
// p：并行度
const PARAMS = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 64

// 生成密码哈希。
// 输出格式：scrypt$N$r$p$盐$哈希
// 把参数和盐一起存进字符串，将来升级参数时旧密码依然能校验通过。
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, PARAMS)
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), derived.toString('hex')].join('$')
}

// 校验密码。
// 使用 timingSafeEqual 做定长时间比较，避免攻击者通过响应耗时差异
// 逐位推断出正确密码。
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false
  }

  const [, n, r, p, saltHex, hashHex] = parts
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')

  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })

  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
