/**
 * /corrections 读数订正记录
 * 列表展示每次订正的测点、日期、订正前/后读数、订正人、原因，以及订正触发的预警联动结果。
 * 同一测点同一天以最后一次订正为准（观测与速率排行均读新值），本页保留全部订正留痕。
 * 消费 Correction、Observation、Point、Alarm；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react'
import { Button, Space, Table, Tag, Tooltip } from 'antd'
import type { TableColumnsType } from 'antd'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import { useCorrectionStore } from '@/stores/correctionStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AlarmRow, type ObservationRow } from '@/utils/db'
import { POINT_TYPES, type PointType } from '@/types/point'
import type { Correction } from '@/types/correction'
import { isTerminalAlarm } from '@/types/alarm'

interface CorrectionRowView {
  correction: Correction
  pointCode: string
  pointType: string
  unit: string
  damName: string
  stakeNo: string
  /** 该测点当天是否存在观测行（观测被删时留痕仍保留） */
  observationExists: boolean
  /** 是否为该观测（测点+当日）当前生效的最后一次订正 */
  isLatest: boolean
  /** 本次订正当日对应的未闭环预警（按 pointId + date） */
  alarms: AlarmRow[]
}

function formatDateTime(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const d = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function CorrectionList() {
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const correctionStore = useCorrectionStore()
  const observationTable = useIdbTable<ObservationRow>(db.observations, { sortByUpdatedAt: false })
  const alarmTable = useIdbTable<AlarmRow>(db.alarms, { sortByUpdatedAt: false })

  const [keyword, setKeyword] = useState('')
  const [damId, setDamId] = useState('')
  const [types, setTypes] = useState<PointType[]>([])
  const [onlyLatest, setOnlyLatest] = useState(false)

  const filterSelects = useMemo(
    () => [
      {
        key: 'damId',
        label: '坝体',
        multiple: false,
        options: damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))
      },
      { key: 'types', label: '测点类型', options: POINT_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [damStore.dams]
  )

  const model: FilterModel = { keyword, damId, types, onlyLatest }

  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    setDamId(typeof next.damId === 'string' ? next.damId : '')
    setTypes((Array.isArray(next.types) ? next.types : []) as PointType[])
  }

  /** observationId → 最后一次订正（同一测点同一天以最后一次为准） */
  const latestMap = useMemo(
    () => {
      const map = new Map<string, Correction>()
      correctionStore.corrections.forEach((item) => {
        const current = map.get(item.observationId)
        if (!current || item.correctedAt >= current.correctedAt) map.set(item.observationId, item)
      })
      return map
    },
    [correctionStore.corrections]
  )

  const rows = useMemo<CorrectionRowView[]>(() => {
    const text = keyword.trim().toLowerCase()
    return correctionStore.corrections
      .map((correction) => {
        const point = pointStore.points.find((item) => item.id === correction.pointId)
        const section = point ? damStore.sections.find((item) => item.id === point.sectionId) : undefined
        const dam = damStore.dams.find((item) => item.id === (point ? point.damId : correction.damId))
        const observationExists = observationTable.rows.some((row) => row.id === correction.observationId)
        const alarms = alarmTable.rows.filter(
          (alarm) => alarm.pointId === correction.pointId && alarm.triggerDate === correction.date
        )
        return {
          correction,
          pointCode: point ? point.code : '测点已删除',
          pointType: point ? point.type : '—',
          unit: point ? point.unit : '',
          damName: dam ? dam.name : '—',
          stakeNo: section ? section.stakeNo : '—',
          observationExists,
          isLatest: latestMap.get(correction.observationId)?.id === correction.id,
          alarms
        }
      })
      .filter((view) => {
        if (damId) {
          const point = pointStore.points.find((item) => item.id === view.correction.pointId)
          if ((point ? point.damId : view.correction.damId) !== damId) return false
        }
        if (types.length > 0 && !types.includes(view.pointType as PointType)) return false
        if (onlyLatest && !view.isLatest) return false
        if (text.length === 0) return true
        return (
          view.pointCode.toLowerCase().includes(text) ||
          view.correction.corrector.toLowerCase().includes(text) ||
          view.correction.reason.toLowerCase().includes(text)
        )
      })
  }, [
    correctionStore.corrections,
    pointStore.points,
    damStore.sections,
    damStore.dams,
    observationTable.rows,
    alarmTable.rows,
    latestMap,
    keyword,
    damId,
    types,
    onlyLatest
  ])

  /** 被订正联动过的预警数（去重）：已撤销/已闭环为已办结，其余为待处置或待人工重判 */
  const linkedAlarmStats = useMemo(() => {
    const linked = alarmTable.rows.filter((alarm) => Boolean(alarm.lastCorrectionId))
    return {
      finished: linked.filter((alarm) => isTerminalAlarm(alarm.state)).length,
      pending: linked.filter((alarm) => !isTerminalAlarm(alarm.state)).length
    }
  }, [alarmTable.rows])

  const columns: TableColumnsType<CorrectionRowView> = [
    { title: '订正时间', width: 150, render: (_v, r) => formatDateTime(r.correction.correctedAt) },
    {
      title: '坝体 / 测点',
      width: 210,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>
            <strong>{r.pointCode}</strong>
            <span className="muted"> · {r.pointType}</span>
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {r.damName} / {r.stakeNo}
          </span>
        </Space>
      )
    },
    { title: '观测日期', dataIndex: ['correction', 'date'], width: 115 },
    {
      title: '订正前读数',
      width: 130,
      render: (_v, r) => <span style={{ color: '#b03a2e', textDecoration: 'line-through' }}>{r.correction.readingBefore.toFixed(3)} {r.unit}</span>
    },
    {
      title: '订正后读数',
      width: 130,
      render: (_v, r) => (
        <Space size={4}>
          <span style={{ color: '#2f7a4f', fontWeight: 600 }}>
            {r.correction.readingAfter.toFixed(3)} {r.unit}
          </span>
          {r.isLatest ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>现行</Tag> : null}
        </Space>
      )
    },
    { title: '订正人', dataIndex: ['correction', 'corrector'], width: 90 },
    {
      title: '订正原因',
      width: 220,
      render: (_v, r) => (
        <Tooltip title={r.correction.reason}>
          <span
            style={{
              display: 'inline-block',
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom'
            }}
          >
            {r.correction.reason}
          </span>
        </Tooltip>
      )
    },
    {
      title: '观测行',
      width: 100,
      render: (_v, r) =>
        r.observationExists ? (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            已按新值重算
          </Tag>
        ) : (
          <Tooltip title="该观测记录已被删除，订正留痕仍保留用于审计">
            <Tag style={{ marginInlineEnd: 0 }}>观测已删除</Tag>
          </Tooltip>
        )
    },
    {
      title: '当日预警联动',
      width: 260,
      render: (_v, r) => {
        if (r.alarms.length === 0) return <span className="muted">无当日预警</span>
        return (
          <Space size={4} wrap>
            {r.alarms.map((alarm) => {
              const linked = alarm.lastCorrectionId === r.correction.id
              const color = alarm.state === '已闭环' ? 'green' : alarm.state === '已撤销' ? 'default' : alarm.state === '处置中' ? 'blue' : 'orange'
              return (
                <Tooltip
                  key={alarm.id}
                  title={
                    linked
                      ? `本次订正${alarm.state === '已撤销' ? '后预警撤销' : '更新了级别与触发值'}`
                      : '同日另有订正，当前显示该预警最新状态'
                  }
                >
                  <Tag color={color} style={{ marginInlineEnd: 0 }}>
                    {alarm.level}色 · {alarm.state}
                    {alarm.readingCorrected ? ' · 待重判' : ''}
                  </Tag>
                </Tooltip>
              )
            })}
          </Space>
        )
      }
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">读数订正记录</h2>
          <p className="page-head__desc">
            录错读数后在此留痕：同一测点同一天以最后一次订正为准，从订正当日起重算后续累计变化与日速率；
            待处置预警不再越限自动撤销，处置中预警标记“读数已订正”等人工重判，已闭环预警保留当时内容。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => setOnlyLatest((value) => !value)}>{onlyLatest ? '查看全部订正' : '只看现行订正'}</Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="订正记录" value={correctionStore.corrections.length} suffix="条" tone="primary" />
        <StatBadge
          label="涉及测点"
          value={new Set(correctionStore.corrections.map((item) => item.pointId)).size}
          suffix="个"
          tone="info"
        />
        <StatBadge label="现行订正" value={latestMap.size} suffix="条" tone="warning" />
        <StatBadge
          label="联动已办结预警"
          value={linkedAlarmStats.finished}
          suffix="张"
          tone="default"
          hint={`订正联动过的预警中，已闭环或已撤销 ${linkedAlarmStats.finished} 张；仍待处置/待人工重判 ${linkedAlarmStats.pending} 张`}
        />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索测点编号 / 订正人 / 原因"
        onModelChange={onModelChange}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            订正台账（{rows.length} / {correctionStore.corrections.length}）
          </h3>
          <span className="muted">列表保留全部订正留痕；观测明细与速率排行读取订正后的新结果</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="暂无订正记录"
            description="在观测录入页对录错的读数点「订正」，填写订正人与原因后会在此留痕。"
            compact
          />
        ) : (
          <Table<CorrectionRowView>
            rowKey={(record) => record.correction.id}
            size="small"
            bordered
            dataSource={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>
    </div>
  )
}
