// 用户 API Key 的加密保管。
//
// 为什么不能明文存：数据库一旦泄露（备份文件外流、误传到公开仓库、
// 运维人员随意导出表），用户绑定的模型 Key 就等于直接送人，
// 对方可以拿着它消耗用户的余额。加密存储后，攻击者还需要额外拿到
// 部署机器上的 VAULT_MASTER_KEY 才能还原明文。
//
// 算法选用 AES-256-GCM：
//   - AES-256 是「对称加密」，加密和解密共用同一把钥匙（这里是 VAULT_MASTER_KEY）。
//     类比：家里的门锁，锁门和开门用的是同一把钥匙。
//   - GCM 是「带认证的加密模式」，它在加密的同时附上一段校验标签。
//     密文被改动哪怕一个字节，解密时会直接报错，而不是悄悄解出一段乱码。
//     类比：保险箱上贴了防伪封条，开箱时能立刻发现被人动过手脚。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config'

const ALGORITHM = 'aes-256-gcm'

// GCM 推荐的初始向量长度是 96 位（12 字节）
const IV_LENGTH = 12

// 认证标签固定 16 字节
const TAG_LENGTH = 16

// 把十六进制的主密钥还原成 32 字节二进制。
// 每次调用重新构造，避免长期在内存里多留一份引用。
function getMasterKey(): Buffer {
  return Buffer.from(config.vaultMasterKey, 'hex')
}

// 当前主密钥的版本号。
// 将来若要轮换主密钥，就把它加一，这样能区分出哪些密文是用旧密钥加密的、
// 需要先解密再用新密钥重新加密。
export const CURRENT_KEY_VERSION = 1

export interface CipherResult {
  cipher: Uint8Array
  iv: Uint8Array
  tag: Uint8Array
  keyVersion: number
}

// 加密。返回密文、初始向量、认证标签三件套，缺一不可。
export function encryptSecret(plainText: string): CipherResult {
  // 每次加密都生成一个全新的随机初始向量。
  // 作用：同一段明文每次加密出来的密文都不同，
  // 否则别人可以靠「密文是否相同」推断出两次保存的 Key 是不是同一个。
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getMasterKey(), iv)

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return { cipher: encrypted, iv, tag, keyVersion: CURRENT_KEY_VERSION }
}

// 解密。密文、初始向量、标签被篡改或主密钥不匹配时都会抛错。
export function decryptSecret(input: {
  cipher: Uint8Array
  iv: Uint8Array
  tag: Uint8Array
}): string {
  const iv = Buffer.from(input.iv)
  const tag = Buffer.from(input.tag)

  // 长度不对说明数据被破坏过，没必要继续尝试
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('密文格式异常，无法解密')
  }

  const decipher = createDecipheriv(ALGORITHM, getMasterKey(), iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(Buffer.from(input.cipher)),
    decipher.final(),
  ]).toString('utf8')
}

// 生成展示用掩码。
// 接口只把这段掩码回给前端，明文永远不离开服务端，
// 这样即便浏览器被恶意脚本注入，也偷不到用户的 Key。
// 例如 sk-abcdefghijklmn 会变成 sk-abc••••••••klmn
export function maskSecret(plainText: string): string {
  // 太短的一律整体遮住，避免掩码本身就泄露了大部分内容
  if (plainText.length <= 12) {
    return '••••••••'
  }
  return `${plainText.slice(0, 6)}${'•'.repeat(8)}${plainText.slice(-4)}`
}
