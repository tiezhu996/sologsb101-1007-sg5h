/**
 * 读数订正链路：订正留痕 → 从订正当日起重算后续累计变化与日速率 → 联动未闭环预警。
 *
 * 规则：
 * - 同一测点同一天以最后一次订正为准：observation.reading 始终被更新为最新订正后读数；
 *   每次订正都写入一条 Correction 留痕（前后值、订正人、原因）。
 * - 重算口径：累计量 = 读数 − 初值；日速率 = |本次读数 − 上次读数| ÷ 间隔天数。
 *   为保证间隔边界正确，整条序列都参与重算，但仅回写派生值变化的行（未受影响行保留时间戳）。
 * - 预警联动（按 pointId + triggerDate 精确匹配当日触发的预警）：
 *   · 已闭环：保留当时内容，不动；
 *   · 已撤销：终态，不再随订正复活；
 *   · 待处置：按新值更新级别与触发值；新值不再越限则转为「已撤销」；
 *   · 处置中：按新值更新级别与触发值，并标记 readingCorrected「读数已订正」，等人工重判。
 */
import { db, createId, ROW_REVISION, type AlarmRow, type CorrectionRow, type ObservationRow } from '@/utils/db'
import type { Correction, CorrectionDraft, CorrectionEffect } from '@/types/correction'
import { isOpenAlarm } from '@/types/alarm'
import { alarmLevelOf, recomputeSeries } from '@/utils/threshold'

/** 从一组留痕中取出每个 observationId（测点+当日）的最后一次订正（以订正时间为准） */
export function latestCorrectionByObservation(corrections: Correction[]): Map<string, Correction> {
  const map = new Map<string, Correction>()
  corrections.forEach((item) => {
    const current = map.get(item.observationId)
    if (!current || item.correctedAt >= current.correctedAt) {
      map.set(item.observationId, item)
    }
  })
  return map
}

/** 订正后的预警联动结果（便于页面给出明细提示） */
export interface CorrectionAlarmChange {
  alarmId: string
  kind: 'updated' | 'revoked' | 'flagged' | 'closed-untouched'
  levelBefore: AlarmRow['level'] | null
  levelAfter: AlarmRow['level'] | null
}

/**
 * 执行一次读数订正（单事务）。
 * @throws 当观测不存在、订正后读数与原读数相同，或数值非法时抛出错误
 */
export async function applyReadingCorrection(
  draft: CorrectionDraft,
  now: number = Date.now()
): Promise<{ correction: CorrectionRow; effect: CorrectionEffect; alarmChanges: CorrectionAlarmChange[] }> {
  if (!draft.observationId) throw new Error('缺少被订正的观测记录')
  if (!Number.isFinite(draft.readingAfter)) throw new Error('订正后读数必须为数字')
  if (!draft.corrector.trim()) throw new Error('请填写订正人')
  if (!draft.reason.trim()) throw new Error('请填写订正原因')

  const effect: CorrectionEffect = {
    recalculated: 0,
    updatedAlarms: 0,
    revokedAlarms: 0,
    flaggedAlarms: 0,
    untouchedClosedAlarms: 0
  }
  const alarmChanges: CorrectionAlarmChange[] = []

  const result = await db.transaction(
    'rw',
    [db.points, db.observations, db.alarms, db.corrections],
    async (): Promise<CorrectionRow> => {
      const observation = await db.observations.get(draft.observationId)
      if (!observation) throw new Error('被订正的观测记录不存在或已被删除')
      const point = await db.points.get(observation.pointId)
      if (!point) throw new Error('测点不存在，无法订正')
      if (observation.pointId !== draft.pointId) {
        throw new Error('订正记录与观测测点不一致')
      }
      if (observation.date !== draft.date) {
        throw new Error('订正记录与观测日期不一致')
      }
      // 同一测点同一天以最后一次订正为准：有效读数即当前 observation.reading
      if (observation.reading === draft.readingAfter) {
        throw new Error('订正后读数与当前读数相同，无需订正')
      }

      // 1) 写订正留痕（readingBefore 以当前生效读数为准；readingAfter 为最新订正值）
      const correction: CorrectionRow = {
        id: createId('cr'),
        observationId: observation.id,
        pointId: observation.pointId,
        damId: point.damId,
        date: observation.date,
        readingBefore: observation.reading,
        readingAfter: draft.readingAfter,
        corrector: draft.corrector.trim(),
        reason: draft.reason.trim(),
        correctedAt: now,
        revision: ROW_REVISION
      }
      await db.corrections.put(correction)

      // 2) 更新观测读数（同测点同日以最后一次订正为准），再重算整条序列（仅回写变化行）
      //    先在内存中构造订正后序列，保证后续回写与预警判定共用同一份新结果
      const series = await db.observations.where('pointId').equals(observation.pointId).toArray()
      const updatedSeries: ObservationRow[] = series.map((row) =>
        row.id === observation.id ? { ...row, reading: draft.readingAfter, updatedAt: now } : row
      )
      const recomputed = recomputeSeries(updatedSeries, point.initialValue)
      const changedRows: ObservationRow[] = []
      updatedSeries.forEach((row) => {
        const target = recomputed.get(row.id)
        if (!target) return
        if (row.id === observation.id) {
          // 被订正行：reading 已更新，这里同步最终派生值
          changedRows.push({ ...row, cumulative: target.cumulative, dailyRate: target.dailyRate })
        } else if (row.cumulative !== target.cumulative || row.dailyRate !== target.dailyRate) {
          changedRows.push({ ...row, cumulative: target.cumulative, dailyRate: target.dailyRate, updatedAt: now })
        }
      })
      if (changedRows.length > 0) await db.observations.bulkPut(changedRows)
      effect.recalculated = changedRows.length

      // 3) 联动当日触发的未闭环预警（新累计量/级别取自重算结果）
      const newCumulative = recomputed.get(observation.id)?.cumulative
      const newLevel = newCumulative === undefined ? null : alarmLevelOf(newCumulative, point.threshold)

      const alarms = await db.alarms
        .where('pointId')
        .equals(observation.pointId)
        .filter((alarm) => alarm.triggerDate === observation.date)
        .toArray()

      for (const alarm of alarms) {
        if (alarm.state === '已闭环') {
          // 已闭环：保留当时内容
          effect.untouchedClosedAlarms += 1
          alarmChanges.push({
            alarmId: alarm.id,
            kind: 'closed-untouched',
            levelBefore: alarm.level,
            levelAfter: alarm.level
          })
          continue
        }
        if (alarm.state === '已撤销' || !isOpenAlarm(alarm.state)) {
          // 已撤销为终态，不复活
          continue
        }

        const levelBefore = alarm.level
        if (alarm.state === '待处置' && newLevel === null) {
          // 订正后不再越限：待处置 → 已撤销（保留当时级别，仅更新触发值留痕）
          await db.alarms.put({
            ...alarm,
            level: levelBefore,
            triggerValue: newCumulative ?? alarm.triggerValue,
            readingCorrected: false,
            lastCorrectionId: correction.id,
            state: '已撤销',
            updatedAt: now
          })
          effect.revokedAlarms += 1
          effect.updatedAlarms += 1
          alarmChanges.push({ alarmId: alarm.id, kind: 'revoked', levelBefore, levelAfter: null })
          continue
        }

        // 其余未闭环预警：触发值一律按新累计更新；仍越限时更新级别。
        const nextPatch: Partial<AlarmRow> = {
          triggerValue: newCumulative ?? alarm.triggerValue,
          lastCorrectionId: correction.id,
          updatedAt: now
        }
        if (newLevel !== null) nextPatch.level = newLevel
        if (alarm.state === '处置中') {
          // 处置中：无论是否仍越限都标记“读数已订正”，等人工重判（不自动改状态/撤销）
          nextPatch.readingCorrected = true
          effect.flaggedAlarms += 1
          alarmChanges.push({ alarmId: alarm.id, kind: 'flagged', levelBefore, levelAfter: newLevel })
        } else {
          alarmChanges.push({ alarmId: alarm.id, kind: 'updated', levelBefore, levelAfter: newLevel })
        }
        effect.updatedAlarms += 1
        await db.alarms.put({ ...alarm, ...nextPatch } as AlarmRow)
      }

      return correction
    }
  )

  return { correction: result, effect, alarmChanges }
}
