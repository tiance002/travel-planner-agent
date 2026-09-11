// 个人设置页：账户设置（头像、用户名、密码）+ 模型接口配置。
//
// 安全原则：明文 Key 只在提交那一刻存在于浏览器内存里，
// 保存后页面立即清空输入框，界面上只展示服务端返回的掩码。
// 密码同理：新旧密码都只在提交瞬间存在，任何接口都不会回显。

import {
  EyeInvisibleOutlined,
  KeyOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Descriptions,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  theme as antdTheme,
} from 'antd'
import { setToken } from '../auth'
import { extractError } from '../api/client'
import {
  fetchMe,
  ME_UPDATED_EVENT,
  setAvatar as saveAvatar,
  updatePassword,
  updateUsername,
  uploadAvatar,
  type MeInfo,
} from '../api/account'
import {
  clearModelConfig,
  fetchModelStatus,
  saveModelConfig,
  testModelConnection,
  type ModelStatus,
  type TestResult,
} from '../api/settings'
import UserAvatar from '../components/UserAvatar'

// 常见厂商预设。选中后自动带出接口地址与候选模型名，
// 用户也可以全部手填（选择「自定义」即可）。
// 这些地址都是各家官方的 OpenAI 兼容入口，路径段各不相同，所以不做自动拼接。
const PROVIDERS = [
  {
    key: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    key: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  {
    key: '自定义',
    baseUrl: '',
    models: [],
  },
]

/** 系统预设头像：一群旅行主题的 emoji，选一个就是你的形象 */
const PRESET_AVATARS = ['🌴', '🏝️', '⛰️', '🌊', '🍉', '🚲', '⛺', '🏮', '🐠', '🌸', '🍵', '📷']

interface Notice {
  type: 'success' | 'error' | 'info'
  text: string
}

export default function Settings() {
  const { message } = App.useApp()

  // --- 账户设置状态 ---------------------------------------------------------
  const [me, setMe] = useState<MeInfo | null>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [username, setUsername] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // --- 模型接口状态 ---------------------------------------------------------
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [loadingModel, setLoadingModel] = useState(true)
  const [provider, setProvider] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 首次进入：拉账户信息与已保存的模型配置（Key 只有掩码）
  useEffect(() => {
    let cancelled = false

    fetchMe()
      .then((info) => {
        if (cancelled) return
        setMe(info)
        setUsername(info.username)
      })
      .catch(() => undefined)

    fetchModelStatus()
      .then((data) => {
        if (cancelled) return
        setStatus(data)
        setProvider(data.provider || 'DeepSeek')
        setBaseUrl(data.baseUrl || 'https://api.deepseek.com/v1')
        setModelName(data.modelName || 'deepseek-chat')
      })
      .catch((error) => {
        if (!cancelled) setNotice({ type: 'error', text: extractError(error, '读取配置失败') })
      })
      .finally(() => {
        if (!cancelled) setLoadingModel(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  /** me 变了就广播，让顶栏头像与用户名立刻刷新 */
  function applyMe(next: MeInfo) {
    setMe(next)
    setUsername(next.username)
    window.dispatchEvent(new Event(ME_UPDATED_EVENT))
  }

  // --- 头像 -------------------------------------------------------------------

  async function choosePreset(emoji: string) {
    setSavingAvatar(true)
    try {
      applyMe(await saveAvatar(`emoji:${emoji}`))
      message.success('头像已更新')
    } catch (error) {
      message.error(extractError(error, '头像设置失败'))
    } finally {
      setSavingAvatar(false)
    }
  }

  // 选完文件：压缩成 256×256 的方图再上传，避免几 MB 的原图直接塞给服务端
  async function handleUploadFile(file: File) {
    setSavingAvatar(true)
    try {
      const dataUrl = await compressImage(file, 256)
      const { user } = await uploadAvatar(dataUrl)
      applyMe(user)
      message.success('头像已更新')
    } catch (error) {
      message.error(extractError(error, '头像上传失败'))
    } finally {
      setSavingAvatar(false)
    }
  }

  // --- 用户名 -------------------------------------------------------------------

  async function handleSaveUsername() {
    if (username === me?.username) {
      message.info('用户名没有变化')
      return
    }
    setSavingName(true)
    try {
      const { token, user } = await updateUsername(username.trim())
      setToken(token) // 改名后旧凭证里的用户名过期了，换上新的
      applyMe(user)
      message.success('用户名已更新')
    } catch (error) {
      message.error(extractError(error, '用户名修改失败'))
    } finally {
      setSavingName(false)
    }
  }

  // --- 密码 -------------------------------------------------------------------

  async function handleSavePassword() {
    if (newPassword !== confirmPassword) {
      message.error('两次输入的新密码不一致')
      return
    }
    if (newPassword === oldPassword) {
      message.warning('新密码不能与当前密码相同')
      return
    }
    setSavingPassword(true)
    try {
      await updatePassword(oldPassword, newPassword)
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      message.success('密码已更新')
    } catch (error) {
      message.error(extractError(error, '密码修改失败'))
    } finally {
      setSavingPassword(false)
    }
  }

  // --- 模型接口 ---------------------------------------------------------------

  const activeProvider = PROVIDERS.find((item) => item.key === provider)

  // 切换厂商：带出该厂商的默认接口地址；模型名留空时也一并填上推荐值
  function handleProviderChange(next: string) {
    setProvider(next)
    const preset = PROVIDERS.find((item) => item.key === next)
    if (preset) {
      setBaseUrl(preset.baseUrl)
      if (!modelName.trim() || !preset.models.includes(modelName)) {
        setModelName(preset.models[0] ?? '')
      }
    }
  }

  // 保存。apiKey 为空时不提交该字段，表示保持原 Key 不变
  async function handleSave() {
    setSaving(true)
    setNotice(null)
    try {
      const next = await saveModelConfig({
        provider,
        baseUrl,
        modelName,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setStatus(next)
      setApiKey('')
      setNotice({
        type: 'success',
        text: next.hasApiKey
          ? '配置已保存，API Key 已用 AES-256-GCM 加密后存储'
          : '配置已保存。尚未填写 API Key',
      })
    } catch (error) {
      setNotice({ type: 'error', text: extractError(error, '保存失败') })
    } finally {
      setSaving(false)
    }
  }

  // 测试连接。优先用输入框里正在编辑的 Key，没有则用服务端已保存的那把
  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    setNotice(null)
    try {
      const result = await testModelConnection({
        baseUrl,
        modelName,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, message: extractError(error, '测试失败'), latencyMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  async function handleClear() {
    setNotice(null)
    setTestResult(null)
    try {
      const next = await clearModelConfig()
      setStatus(next)
      setApiKey('')
      setNotice({ type: 'info', text: '已清除模型配置' })
    } catch (error) {
      setNotice({ type: 'error', text: extractError(error, '清除失败') })
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <Typography.Title level={4}>个人设置</Typography.Title>

      {/* ---------------- 账户设置 ---------------- */}
      <Card
        title={
          <Space size={8}>
            <UserOutlined />
            账户设置
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
          <Descriptions.Item label="当前账号">{me?.username ?? '加载中…'}</Descriptions.Item>
        </Descriptions>

        {/* 头像：预设 emoji + 自定义上传 */}
        <Field label="头像" hint="选一个系统形象，或上传自己的图片（会自动裁成方形并压缩）">
          <Space size={20} wrap align="start">
            <div style={{ textAlign: 'center' }}>
              <UserAvatar avatar={me?.avatar} username={me?.username} size={72} style={{ display: 'block', margin: '0 auto 8px' }} />
              <Button
                size="small"
                icon={<UploadOutlined />}
                loading={savingAvatar}
                data-testid="avatar-upload-btn"
                onClick={() => fileRef.current?.click()}
              >
                自定义上传
              </Button>
              {/* 隐藏的原生文件输入：样式交给上面的按钮 */}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleUploadFile(file)
                  event.target.value = '' // 允许连续选同一张文件也能触发
                }}
              />
            </div>

            <div style={{ maxWidth: 340 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 44px)', gap: 8 }}>
                {PRESET_AVATARS.map((emoji) => {
                  const active = me?.avatar === `emoji:${emoji}`
                  return (
                    <Button
                      key={emoji}
                      data-testid={`avatar-option-${emoji}`}
                      style={{ fontSize: 22, height: 44, padding: 0 }}
                      variant={active ? 'solid' : 'outlined'}
                      color={active ? 'primary' : 'default'}
                      loading={savingAvatar && active}
                      onClick={() => void choosePreset(emoji)}
                    >
                      {emoji}
                    </Button>
                  )
                })}
              </div>
            </div>
          </Space>
        </Field>

        {/* 用户名 */}
        <Field label="用户名" hint="3-32 位字母、数字或下划线。修改后当前登录凭证会自动换新，无需重新登录">
          <Space.Compact style={{ width: 320 }}>
            <Input
              data-testid="username-input"
              value={username}
              maxLength={32}
              onChange={(event) => setUsername(event.target.value)}
            />
            <Button
              type="primary"
              data-testid="save-username-btn"
              loading={savingName}
              onClick={() => void handleSaveUsername()}
            >
              保存
            </Button>
          </Space.Compact>
        </Field>

        {/* 密码 */}
        <Field label="修改密码" hint="至少 8 位。修改成功后需要用新密码重新登录（当前会话仍有效）">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
            <Input.Password
              data-testid="old-password"
              placeholder="当前密码"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
            />
            <Input.Password
              data-testid="new-password"
              placeholder="新密码（至少 8 位）"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <Input.Password
              data-testid="confirm-password"
              placeholder="再输一遍新密码"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <Button
              type="primary"
              data-testid="save-password-btn"
              loading={savingPassword}
              disabled={!oldPassword || !newPassword || !confirmPassword}
              onClick={() => void handleSavePassword()}
            >
              更新密码
            </Button>
          </div>
        </Field>
      </Card>

      {/* ---------------- 模型接口 ---------------- */}
      <Card
        title={
          <Space size={8}>
            <KeyOutlined />
            模型接口
          </Space>
        }
        loading={loadingModel}
        style={{ marginBottom: 16 }}
        extra={
          status?.hasApiKey ? (
            <Tag color="green" data-testid="key-badge">
              已配置
            </Tag>
          ) : (
            <Tag data-testid="key-badge">未配置</Tag>
          )
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="模型厂商" hint="选择后会自动带出该厂商的接口地址与推荐模型">
            <Select
              data-testid="model-provider"
              value={provider || undefined}
              placeholder="请选择模型厂商"
              style={{ width: 260 }}
              onChange={handleProviderChange}
              options={PROVIDERS.map((item) => ({ value: item.key, label: item.key }))}
            />
          </Field>

          <Field label="接口地址" hint="OpenAI 兼容地址，系统会在其末尾拼接 /chat/completions">
            <Input
              data-testid="model-base-url"
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>

          <Field label="模型名称" hint="填写厂商控制台里显示的模型标识">
            <Input
              data-testid="model-name"
              value={modelName}
              placeholder="deepseek-chat"
              onChange={(event) => setModelName(event.target.value)}
            />
            {activeProvider && activeProvider.models.length > 0 && (
              // 推荐模型改成「可点即填」的胶囊列表：比纯 Tag 更容易看出哪些能点
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {activeProvider.models.map((item) => {
                  const active = modelName === item
                  return (
                    <Tag
                      key={item}
                      style={{
                        cursor: 'pointer',
                        marginInlineEnd: 0,
                        padding: '3px 10px',
                        borderRadius: 999,
                      }}
                      color={active ? 'blue' : undefined}
                      onClick={() => setModelName(item)}
                    >
                      {item}
                      {active ? ' ✓' : ''}
                    </Tag>
                  )
                })}
              </div>
            )}
          </Field>

          <Field
            label="API Key"
            hint={
              status?.hasApiKey
                ? `当前已保存：${status.maskedKey}（留空表示不修改）`
                : '尚未配置。填入后点击保存即可加密存储'
            }
          >
            <Input.Password
              data-testid="model-api-key"
              value={apiKey}
              placeholder={status?.hasApiKey ? '如需更换，请粘贴新的 Key' : 'sk-...'}
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>

          {status?.fallbackAvailable && !status.hasApiKey && (
            <Alert
              type="info"
              showIcon
              title="服务端已配置全局默认 Key"
              description="你可以先不填，AI 排程会暂时使用服务端配置的默认 Key。填入自己的 Key 后将优先使用你自己的。"
            />
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Button
              type="primary"
              data-testid="save-model-btn"
              loading={saving}
              onClick={handleSave}
            >
              保存配置
            </Button>
            <Button data-testid="test-model-btn" loading={testing} onClick={handleTest}>
              测试连接
            </Button>
            <Popconfirm
              title="确定清除模型配置？"
              description="API Key 与接口设置都会被删除，AI 排程将不可用。"
              okText="确定清除"
              cancelText="取消"
              onConfirm={handleClear}
            >
              <Button danger data-testid="clear-model-btn">
                清除配置
              </Button>
            </Popconfirm>
          </div>

          {notice && <Alert type={notice.type} showIcon title={notice.text} />}

          {testResult && (
            <Alert
              data-testid="test-model-result"
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              title={testResult.message}
              description={testResult.reply ? `模型回复：${testResult.reply}` : undefined}
            />
          )}
        </div>
      </Card>

      {/* 密钥保护的说明。早先是两段并列的灰字，信息密度不均、也没有视觉层次。
          改成三张带图标的小卡：每张只说一件事，扫一眼就知道系统做了什么 */}
      <Card title="密钥是怎么被保护的" size="small">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 10,
          }}
        >
          <SecurityNote
            icon={<LockOutlined />}
            title="加密后入库"
            text="API Key 提交后先用 AES-256-GCM 算法加密，再写入数据库。加密用的主密钥只存在于服务器的环境变量里，不随代码或数据库一起泄露。"
          />
          <SecurityNote
            icon={<SafetyCertificateOutlined />}
            title="完整性校验"
            text="GCM 模式自带完整性校验。密文被改动一个字节就会解密失败并报错，而不是悄悄读出错误的内容。"
          />
          <SecurityNote
            icon={<EyeInvisibleOutlined />}
            title="明文不出服务器"
            text="页面上的查询接口只返回类似 sk-abc••••••••klmn 的掩码。明文永远不会再回到浏览器。"
          />
        </div>
      </Card>
    </div>
  )
}

/**
 * 安全说明的一条。
 * 图标 + 标题 + 正文的三层结构，比原来两段并列的灰字更容易扫读。
 */
function SecurityNote({
  icon,
  title,
  text,
}: {
  icon: ReactNode
  title: string
  text: string
}) {
  const { token } = antdTheme.useToken()
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: token.borderRadius,
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 6,
          color: token.colorPrimary,
          fontWeight: 500,
          fontSize: 13,
        }}
      >
        {icon}
        {title}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    </div>
  )
}

/**
 * 把用户选的图片压缩成 size×size 的方图，返回 dataURL 文本。
 * 为什么要在前端压：手机随手拍一张就几 MB，直接传既慢又浪费服务器磁盘；
 * 头像本来就只需要一个小方图。Canvas 是浏览器自带的画布，可以缩放绘制图片。
 */
function compressImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('浏览器不支持图片处理'))
          return
        }
        // 居中裁剪：取图片中间最大的正方形区域，缩放绘制到画布上
        const side = Math.min(img.width, img.height)
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size,
        )
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

// 表单行：标题 + 说明 + 控件，统一间距。
// hint 的颜色取自主题 token —— 早先写死 rgba(128,128,128,.85)，
// 在黑夜模式那种深底上会糊得看不清
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  const { token } = antdTheme.useToken()
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && (
        <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextTertiary }}>{hint}</div>
      )}
    </div>
  )
}
