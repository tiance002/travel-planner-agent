// 个人设置页。
// 模型选择与 API Key 填写属于 P2 阶段的内容，这里先给出占位说明，
// 让导航结构完整、用户知道这个入口将来是做什么的。

import { Alert, Card, Descriptions, Typography } from 'antd'
import { getUsernameFromToken } from '../auth'

export default function Settings() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Typography.Title level={4}>个人设置</Typography.Title>

      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="当前账号">
            {getUsernameFromToken() ?? '未登录'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Alert
        type="info"
        showIcon
        message="模型配置尚未开放"
        description={
          <span>
            下一阶段将在这里提供模型厂商选择、接口地址、模型名称与 API Key 的填写入口。
            密钥会经 AES-256-GCM 加密后存放在服务端，界面上只显示掩码、不回显明文。
          </span>
        }
      />
    </div>
  )
}
