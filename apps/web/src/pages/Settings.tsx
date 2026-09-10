// 个人设置页：管理模型厂商与 API Key。
//
// 安全原则：明文 Key 只在提交那一刻存在于浏览器内存里，
// 保存后页面立即清空输入框，界面上只展示服务端返回的掩码。

import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, Card, Descriptions, Input, Popconfirm, Select, Tag, Typography } from 'antd'
import { getUsernameFromToken } from '../auth'
import { extractError } from '../api/client'
import {
  clearModelConfig,
  fetchModelStatus,
  saveModelConfig,
  testModelConnection,
  type ModelStatus,
  type TestResult,
} from '../api/settings'

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

interface Notice {
  type: 'success' | 'error' | 'info'
  text: string
}

export default function Settings() {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [loading, setLoading] = useState(true)

  // 表单状态
  const [provider, setProvider] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 首次进入时把已保存的配置读出来填充表单（Key 只有掩码）
  useEffect(() => {
    let cancelled = false
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
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="当前账号">
            {getUsernameFromToken() ?? '未登录'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="模型配置"
        loading={loading}
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
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeProvider.models.map((item) => (
                  <Tag
                    key={item}
                    style={{ cursor: 'pointer' }}
                    color={modelName === item ? 'blue' : undefined}
                    onClick={() => setModelName(item)}
                  >
                    {item}
                  </Tag>
                ))}
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

      <Card title="密钥是怎么被保护的" size="small">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          API Key 提交后会用 AES-256-GCM 算法加密再写入数据库，加密用的主密钥只存在于服务器
          的环境变量里，不随代码或数据库一起泄露。GCM 模式还会附带完整性校验，密文被改动一个
          字节就会解密失败，而不是悄悄读出错误内容。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          页面上的查询接口只返回类似 <code>sk-abc••••••••klmn</code> 的掩码，明文永远不会再
          回到浏览器。
        </Typography.Paragraph>
      </Card>
    </div>
  )
}

// 表单行：标题 + 说明 + 控件，统一间距
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <div style={{ marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{hint}</div>
      )}
    </div>
  )
}
