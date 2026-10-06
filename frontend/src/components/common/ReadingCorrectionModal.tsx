/**
 * <ReadingCorrectionModal> 读数订正弹窗
 * 录入读数错误时的正式订正入口：填写订正后读数、订正人与订正原因，
 * 提交后写入订正留痕、自订正日起重算累计变化与日速率，并联动未闭环预警。
 * 被观测录入页、速率计算页消费。
 */
import { useEffect } from 'react'
import { Alert, Form, Input, InputNumber, Modal, Tag } from 'antd'
import type { Point } from '@/types/point'
import type { Observation } from '@/types/observation'
import type { ReadingCorrectionDraft } from '@/types/correction'
import { EMPTY_CORRECTION_DRAFT } from '@/types/correction'
import AlarmTag from '@/components/common/AlarmTag'
import { useAlarmLevel } from '@/hooks/useAlarmLevel'

export interface ReadingCorrectionModalProps {
  open: boolean
  point: Point | null
  observation: Observation | null
  confirmLoading?: boolean
  onCancel: () => void
  onSubmit: (draft: Required<ReadingCorrectionDraft>) => Promise<void> | void
}

export default function ReadingCorrectionModal({
  open,
  point,
  observation,
  confirmLoading = false,
  onCancel,
  onSubmit
}: ReadingCorrectionModalProps) {
  const [form] = Form.useForm<ReadingCorrectionDraft>()
  const alarmLevel = useAlarmLevel()
  const readingAfter = Form.useWatch('readingAfter', form)

  useEffect(() => {
    if (open && observation) {
      form.setFieldsValue({ ...EMPTY_CORRECTION_DRAFT, readingAfter: observation.reading })
    }
  }, [open, observation, form])

  const preview = point && typeof readingAfter === 'number' ? alarmLevel.evaluate(point, readingAfter) : null
  const beforeEvaluation = point && observation ? alarmLevel.evaluate(point, observation.reading) : null

  const handleOk = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    await onSubmit({
      readingAfter: Number(values.readingAfter),
      corrector: values.corrector.trim(),
      reason: values.reason.trim()
    })
  }

  return (
    <Modal
      open={open}
      title={point && observation ? `读数订正 · ${point.code} · ${observation.date}` : '读数订正'}
      onCancel={onCancel}
      onOk={handleOk}
      okText="提交订正"
      cancelText="取消"
      confirmLoading={confirmLoading}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message="订正将留痕并重算预警"
        description="同一测点同一天以最后一次订正为准；自订正日起重算后续累计变化与日速率。已闭环预警保留当时内容，未闭环预警按新值联动重判。"
      />
      <Form form={form} layout="vertical" initialValues={EMPTY_CORRECTION_DRAFT}>
        <Form.Item label="订正前读数">
          <Tag color="orange">
            {observation ? `${observation.reading.toFixed(3)} ${point ? point.unit : ''}` : '—'}
          </Tag>
          {beforeEvaluation?.level ? <AlarmTag level={beforeEvaluation.level} size="small" /> : <Tag color="green">正常</Tag>}
        </Form.Item>
        <Form.Item
          name="readingAfter"
          label={`订正后读数（${point ? point.unit : ''}）`}
          rules={[{ required: true, message: '请填写订正后的读数' }]}
        >
          <InputNumber step={0.1} style={{ width: '100%' }} autoFocus />
        </Form.Item>
        {preview ? (
          <Form.Item label="订正后判定">
            <span style={{ marginRight: 10 }} className="muted">
              累计变化 {preview.cumulative.toFixed(3)} · 占阈值 {(preview.ratio * 100).toFixed(1)}%
            </span>
            {preview.level ? <AlarmTag level={preview.level} size="small" /> : <Tag color="green">正常</Tag>}
          </Form.Item>
        ) : null}
        <Form.Item name="corrector" label="订正人" rules={[{ required: true, message: '请填写订正人' }]}>
          <Input placeholder="如 王丽" />
        </Form.Item>
        <Form.Item name="reason" label="订正原因" rules={[{ required: true, message: '请填写订正原因' }]}>
          <Input.TextArea rows={3} placeholder="如 人工复测发现测尺读数误录，按复测值订正" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
