/**
 * <CorrectionModal> 读数订正弹窗
 * 采集订正后读数、订正人、订正原因；提交后由 correctionStore 走订正链路
 *（留痕 → 重算累计变化与日速率 → 联动未闭环预警）。
 * 被观测录入页消费。
 */
import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Alert, Descriptions, Form, Input, InputNumber, Modal, Tag } from 'antd'
import AlarmTag from '@/components/common/AlarmTag'
import { useCorrectionStore } from '@/stores/correctionStore'
import type { Point } from '@/types/point'
import type { ObservationRow } from '@/utils/db'
import type { CorrectionEffect } from '@/types/correction'
import { alarmLevelOf, cumulativeOf, dailyRateOf, daysBetween, ratioOf } from '@/utils/threshold'

export interface CorrectionModalProps {
  open: boolean
  point: Point | null
  observation: ObservationRow | null
  /** 该测点按日期升序的观测序列，用于预览订正后的日速率 */
  series: ObservationRow[]
  onClose: () => void
  /** 订正成功回调，参数为联动处置结果，页面用于明细提示 */
  onApplied?: (effect: CorrectionEffect) => void
}

interface CorrectionFormValues {
  readingAfter: number
  corrector: string
  reason: string
}

export function CorrectionModal({ open, point, observation, series, onClose, onApplied }: CorrectionModalProps) {
  const { message } = AntdApp.useApp()
  const correctionStore = useCorrectionStore()
  const [form] = Form.useForm<CorrectionFormValues>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open && observation) {
      form.setFieldsValue({
        readingAfter: observation.reading,
        corrector: '',
        reason: ''
      })
    }
  }, [open, observation, form])

  const readingAfter = Form.useWatch('readingAfter', form)

  const preview = useMemo(() => {
    if (!point || !observation || typeof readingAfter !== 'number' || !Number.isFinite(readingAfter)) return null
    const cumulative = cumulativeOf(readingAfter, point.initialValue)
    const ratio = ratioOf(cumulative, point.threshold)
    const level = alarmLevelOf(cumulative, point.threshold)
    const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date))
    const index = sorted.findIndex((row) => row.id === observation.id)
    const previous = index > 0 ? sorted[index - 1] : null
    const dailyRate = previous ? dailyRateOf(readingAfter, previous.reading, daysBetween(previous.date, observation.date)) : 0
    return { cumulative, ratio, level, dailyRate, hasPrevious: previous !== null }
  }, [point, observation, series, readingAfter])

  const sameAsBefore = typeof readingAfter === 'number' && observation !== null && readingAfter === observation.reading

  const submit = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null)
    if (!values || !point || !observation) return
    if (values.readingAfter === observation.reading) {
      message.warning('订正后读数与原读数相同，无需订正')
      return
    }
    setSubmitting(true)
    try {
      const { effect } = await correctionStore.applyCorrection({
        observationId: observation.id,
        pointId: point.id,
        date: observation.date,
        readingBefore: observation.reading,
        readingAfter: Number(values.readingAfter),
        corrector: values.corrector,
        reason: values.reason
      })
      message.success(
        `读数已订正并重算 ${effect.recalculated} 条观测` +
          (effect.revokedAlarms > 0 ? `，${effect.revokedAlarms} 张待处置预警已撤销` : '') +
          (effect.flaggedAlarms > 0 ? `，${effect.flaggedAlarms} 张处置中预警待人工重判` : '')
      )
      onApplied?.(effect)
      onClose()
    } catch (error) {
      message.error(`订正失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={point && observation ? `读数订正 · ${point.code} · ${observation.date}` : '读数订正'}
      onCancel={onClose}
      onOk={submit}
      okText="提交订正"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ danger: true }}
      destroyOnClose
      width={560}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message="订正将留痕并从当日起重算后续累计变化与日速率；未闭环预警会按新值联动，已闭环预警保留当时内容。"
      />
      {point && observation ? (
        <Descriptions size="small" bordered column={1} style={{ marginBottom: 14 }}>
          <Descriptions.Item label="测点 / 日期">
            {point.code}（{point.type}） · {observation.date}
          </Descriptions.Item>
          <Descriptions.Item label="原读数">
            <span style={{ color: '#b03a2e' }}>
              {observation.reading.toFixed(3)} {point.unit}
            </span>
            <span className="muted"> ｜ 原累计 {observation.cumulative.toFixed(3)} ｜ 原日速率 {observation.dailyRate.toFixed(4)}</span>
          </Descriptions.Item>
        </Descriptions>
      ) : null}

      <Form form={form} layout="vertical">
        <Form.Item
          name="readingAfter"
          label={`订正后读数（${point ? point.unit : ''}）`}
          rules={[{ required: true, message: '请填写订正后读数' }]}
          extra={sameAsBefore ? '与原读数相同，无需订正' : undefined}
          validateStatus={sameAsBefore ? 'warning' : undefined}
        >
          <InputNumber step={0.1} style={{ width: '100%' }} autoFocus />
        </Form.Item>
        <Form.Item name="corrector" label="订正人" rules={[{ required: true, message: '请填写订正人' }]}>
          <Input placeholder="如 陈文" />
        </Form.Item>
        <Form.Item name="reason" label="订正原因" rules={[{ required: true, message: '请填写订正原因' }]}>
          <Input.TextArea rows={3} placeholder="如 现场记录笔误，经复测核对原读数应为……" />
        </Form.Item>
        {preview ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="muted">
              订正后累计 {preview.cumulative.toFixed(3)} · 日速率 {preview.dailyRate.toFixed(4)} · 占阈值{' '}
              {(preview.ratio * 100).toFixed(1)}%
              {preview.hasPrevious ? '' : '（序列首条，日速率为 0）'}
            </span>
            {preview.level ? <AlarmTag level={preview.level} size="small" /> : <Tag color="green">订正后正常</Tag>}
          </div>
        ) : null}
      </Form>
    </Modal>
  )
}

export default CorrectionModal
