// 登录 / 注册页。两个模式共用一个表单，注册成功后直接进入已登录状态。

import { App, Button, Card, Form, Input, Tabs, Typography } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, extractError } from '../api/client'
import { setToken } from '../auth'

type Mode = 'login' | 'register'

interface FormValues {
  username: string
  password: string
}

export default function Login() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('login')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(values: FormValues) {
    setLoading(true)
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register'
      const { data } = await api.post<{ token: string }>(path, values)
      setToken(data.token)
      message.success(mode === 'login' ? '登录成功' : '注册成功，已自动登录')
      navigate('/trips', { replace: true })
    } catch (error) {
      message.error(extractError(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <Card className="login-card">
        <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 4 }}>
          旅游规划助手
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          以住宿为锚点，让 AI 帮你安排每天的行程
        </Typography.Paragraph>

        <Tabs
          centered
          activeKey={mode}
          onChange={(key) => setMode(key as Mode)}
          items={[
            { key: 'login', label: '登录' },
            { key: 'register', label: '注册' },
          ]}
        />

        <Form<FormValues> layout="vertical" requiredMark={false} onFinish={handleSubmit}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="3-32 位字母、数字或下划线" autoComplete="username" />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder={mode === 'register' ? '至少 8 位' : '请输入密码'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </Form.Item>

          <Button type="primary" htmlType="submit" block loading={loading}>
            {mode === 'login' ? '登录' : '注册并登录'}
          </Button>
        </Form>
      </Card>
    </div>
  )
}
