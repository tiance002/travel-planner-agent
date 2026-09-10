// 环境变量读取与校验。
// 所有密钥只在这一个文件里读取，其他模块从这里取，避免密钥散落在各处代码中。

import 'dotenv/config'

// 读取必填环境变量。缺失时直接抛错终止启动，
// 避免服务带着空密钥跑起来，等到运行时才报出难排查的错误。
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`缺少环境变量 ${name}，请检查 apps/server/.env 是否已正确配置`)
  }
  return value
}

export const config = {
  // 后端监听端口
  port: Number(process.env.PORT ?? 3001),

  // JWT 签名密钥，用于签发与校验登录凭证
  jwtSecret: required('JWT_SECRET'),

  // 用户 API Key 的加密主密钥，32 字节 hex
  vaultMasterKey: required('VAULT_MASTER_KEY'),

  // 高德 Web 服务 Key：仅后端使用，绝不下发到前端
  amapWebServiceKey: process.env.AMAP_WEB_SERVICE_KEY ?? '',

  // 高德 Web 端(JS API) Key：通过接口下发给浏览器加载地图用，靠域名白名单保护
  amapJsKey: process.env.AMAP_JS_KEY ?? '',

  // 高德 JS API 安全密钥：与 JS Key 配套。2021 年后新建的 JS Key 都强制要求，
  // 缺少它地图会加载失败并报 INVALID_USER_SCODE。
  amapJsSecurityCode: process.env.AMAP_JS_SECURITY_CODE ?? '',
}

// 启动时自检：主密钥必须是 64 位十六进制（即 32 字节），否则加密会失败
if (!/^[0-9a-fA-F]{64}$/.test(config.vaultMasterKey)) {
  throw new Error('VAULT_MASTER_KEY 必须是 64 位十六进制字符（32 字节），请重新生成')
}

// 高德 Key 不阻断启动：账号体系与行程列表不依赖它。
// 但缺 Key 时要把话说清楚，避免开发到地图环节才发现是配置问题。
if (!config.amapWebServiceKey || !config.amapJsKey) {
  console.warn(
    '[配置提醒] 高德 Key 未配置完整。POI 搜索、路径规划、天气与地图渲染都将不可用。\n' +
      '           请在 apps/server/.env 与 apps/web/.env 中补齐（可参考 .env.example）。',
  )
}
