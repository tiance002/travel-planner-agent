// 新建行程页。
// 完整形态是四步向导：基本信息 → 内嵌地图选住宿 → AI 生成 → 结果确认。
// 该功能依赖高德 Key 与 Agent 编排，将在 P3 / P4 阶段实现，这里先占位。

import { Alert, Card, Steps, Typography } from 'antd'

export default function NewTrip() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Typography.Title level={4}>新建行程</Typography.Title>

      <Card style={{ marginBottom: 16 }}>
        <Steps
          direction="vertical"
          current={-1}
          items={[
            {
              title: '基本信息',
              description: '目的地、出发日期、天数、团队人数、旅游偏好、预算范围、额外需求',
            },
            {
              title: '选定住宿',
              description: '在页面内嵌的高德地图上搜索并点选酒店，作为每日行程的锚点；也可以选择「还没定」，由 AI 推荐交通便利的中心区域',
            },
            {
              title: 'AI 生成行程',
              description: '以住宿为圆心，按直线距离排序聚类，每天安排不超过 3 个景点，餐厅就近插在相邻景点之间',
            },
            {
              title: '查看结果',
              description: '按天查看时段顺序，地图上展示真实路线，行程中可对景点打卡',
            },
          ]}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        message="该功能尚未开放"
        description="四步向导将在后续阶段逐步实现，目前已完成账号体系与行程列表骨架。"
      />
    </div>
  )
}
