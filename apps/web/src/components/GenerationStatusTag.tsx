import { Tag } from 'antd'
import type { GenerationRunPhase } from '../api/trips'

interface Props {
  status: string
  phase?: GenerationRunPhase
}

export function generationStatus(status: string, phase?: GenerationRunPhase) {
  if (phase === 'recovery') return { label: '需要恢复', color: 'warning' }
  if (phase === 'commit_pending') return { label: '保存待重试', color: 'warning' }
  if (status === 'generating' && phase === 'waiting') return { label: '等待确认', color: 'warning' }
  if (status === 'generating' && phase === 'reviewing') return { label: '正在处理确认', color: 'processing' }
  if (status === 'generating') return { label: '正在生成', color: 'processing' }
  if (status === 'partial') return { label: '部分完成', color: 'warning' }
  if (status === 'failed') return { label: '生成失败', color: 'error' }
  if (status === 'ready') return { label: '已完成', color: 'success' }
  return { label: '草稿', color: undefined }
}

export default function GenerationStatusTag({ status, phase }: Props) {
  const display = generationStatus(status, phase)
  return <Tag color={display.color}>{display.label}</Tag>
}
