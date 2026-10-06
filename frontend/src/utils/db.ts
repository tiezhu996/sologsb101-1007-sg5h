/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Dam } from '@/types/dam'
import type { Section } from '@/types/section'
import type { Point } from '@/types/point'
import type { Observation } from '@/types/observation'
import type { Alarm } from '@/types/alarm'
import type { Pool } from '@/types/pool'
import type { ReadingCorrection } from '@/types/correction'
import { isAlarmTerminal } from '@/types/alarm'
import {
  alarmLevelOf,
  cumulativeOf,
  dailyRateOf,
  daysBetween,
  formatRatio,
  ratioOf
} from '@/utils/threshold'

export const DB_NAME = 'gbtaildam'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbtaildam:db-version',
  lastBackupAt: 'gbtaildam:last-backup-at',
  uiPrefs: 'gbtaildam:ui-prefs'
} as const

export interface UiPrefs {
  lastDamId: string | null
  alarmOnlyOpen: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastDamId: null, alarmOnlyOpen: false }

export interface BackupPayload {
  app: 'gbtaildam'
  dbVersion: number
  exportedAt: string
  dams: Dam[]
  sections: Section[]
  points: Point[]
  observations: Observation[]
  alarms: Alarm[]
  pools: Pool[]
  corrections?: ReadingCorrection[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type DamRow = Dam & Revisioned
export type SectionRow = Section & Revisioned
export type PointRow = Point & Revisioned
export type ObservationRow = Observation & Revisioned
export type AlarmRow = Alarm & Revisioned
export type PoolRow = Pool & Revisioned
export type CorrectionRow = ReadingCorrection & Revisioned

class TailDamDatabase extends Dexie {
  dams!: Table<DamRow, string>
  sections!: Table<SectionRow, string>
  points!: Table<PointRow, string>
  observations!: Table<ObservationRow, string>
  alarms!: Table<AlarmRow, string>
  pools!: Table<PoolRow, string>
  corrections!: Table<CorrectionRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      dams: 'id, name, damType, grade',
      sections: 'id, damId, stakeNo',
      points: 'id, sectionId, code, type',
      observations: 'id, pointId, date',
      alarms: 'id, pointId, level, state',
      pools: 'id, damId, date'
    })

    // v2：测点/预警补 damId 冗余列（按坝体筛选免联表）；全部表补 revision 行修订号
    this.version(2)
      .stores({
        dams: 'id, name, damType, grade, updatedAt',
        sections: 'id, damId, stakeNo, updatedAt',
        points: 'id, sectionId, damId, code, type, updatedAt',
        observations: 'id, pointId, date, observer, updatedAt',
        alarms: 'id, pointId, damId, level, state, updatedAt',
        pools: 'id, damId, date, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：为全部业务行补齐 revision
        for (const name of ['dams', 'sections', 'points', 'observations', 'alarms', 'pools']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = 2
            })
        }

        // 迁移 2：测点缺少 damId 时用所属断面回填
        const sections = (await tx.table('sections').toArray()) as Array<{ id: string; damId: string }>
        const damOfSection = new Map(sections.map((section) => [section.id, section.damId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.damId !== 'string' || point.damId.length === 0) {
              point.damId = damOfSection.get(String(point.sectionId)) ?? ''
            }
            if (typeof point.threshold !== 'number' || !Number.isFinite(point.threshold)) {
              point.threshold = 25
            }
          })

        // 迁移 3：预警缺少 damId 时用测点回填；补齐 handler / measure 字段
        const points = (await tx.table('points').toArray()) as Array<{ id: string; damId: string }>
        const damOfPoint = new Map(points.map((point) => [point.id, point.damId]))
        await tx
          .table('alarms')
          .toCollection()
          .modify((alarm: Record<string, unknown>) => {
            if (typeof alarm.damId !== 'string' || alarm.damId.length === 0) {
              alarm.damId = damOfPoint.get(String(alarm.pointId)) ?? ''
            }
            if (typeof alarm.handler !== 'string') alarm.handler = ''
            if (typeof alarm.measure !== 'string') alarm.measure = ''
          })
      })

    // v3：新增 readings 订正记录表；预警补 readingCorrected / canceledReason，状态新增「已撤销」
    // 历史库订正表为空即天然兼容，预警新字段在订正联动时按需补齐，无需 upgrade 改写。
    this.version(DB_VERSION).stores({
      dams: 'id, name, damType, grade, updatedAt',
      sections: 'id, damId, stakeNo, updatedAt',
      points: 'id, sectionId, damId, code, type, updatedAt',
      observations: 'id, pointId, date, observer, updatedAt',
      alarms: 'id, pointId, damId, level, state, updatedAt',
      pools: 'id, damId, date, updatedAt',
      corrections: 'id, pointId, observationId, date, createdAt'
    })
  }
}

export const db = new TailDamDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-12T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_DAMS: DamRow[] = [
  { id: 'dam-1', name: '尾矿库 A 坝', damType: '上游式', finalHeightM: 68, grade: '三等', commissionDate: '2012-06-30', createdAt: stamp(-400), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dam-2', name: '尾矿库 B 坝', damType: '中线式', finalHeightM: 45, grade: '四等', commissionDate: '2018-09-15', createdAt: stamp(-360), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_SECTIONS: SectionRow[] = [
  { id: 'sec-1', damId: 'dam-1', stakeNo: '0+120', slopeRatio: 2.5, elevationM: 712.5, createdAt: stamp(-390), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'sec-2', damId: 'dam-1', stakeNo: '0+260', slopeRatio: 2.8, elevationM: 713.2, createdAt: stamp(-389), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'sec-3', damId: 'dam-2', stakeNo: '0+080', slopeRatio: 2.2, elevationM: 645.0, createdAt: stamp(-350), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'sec-4', damId: 'dam-2', stakeNo: '0+180', slopeRatio: 2.4, elevationM: 645.6, createdAt: stamp(-349), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', sectionId: 'sec-1', damId: 'dam-1', code: 'DB-01', type: '表面位移', initialValue: 0, threshold: 25, unit: 'mm', installDate: '2021-03-18', createdAt: stamp(-380), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', sectionId: 'sec-1', damId: 'dam-1', code: 'CX-01', type: '测斜', initialValue: 0, threshold: 30, unit: 'mm', installDate: '2021-03-18', createdAt: stamp(-380), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', sectionId: 'sec-1', damId: 'dam-1', code: 'JR-01', type: '浸润线', initialValue: 12.6, threshold: 2, unit: 'm', installDate: '2021-04-02', createdAt: stamp(-379), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'pt-4', sectionId: 'sec-2', damId: 'dam-1', code: 'DB-02', type: '表面位移', initialValue: 0, threshold: 25, unit: 'mm', installDate: '2021-03-20', createdAt: stamp(-378), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', sectionId: 'sec-2', damId: 'dam-1', code: 'SY-01', type: '渗压', initialValue: 45, threshold: 8, unit: 'kPa', installDate: '2021-04-06', createdAt: stamp(-377), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-6', sectionId: 'sec-2', damId: 'dam-1', code: 'JR-02', type: '浸润线', initialValue: 13.1, threshold: 2, unit: 'm', installDate: '2021-04-06', createdAt: stamp(-377), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', sectionId: 'sec-3', damId: 'dam-2', code: 'DB-03', type: '表面位移', initialValue: 0, threshold: 20, unit: 'mm', installDate: '2022-05-11', createdAt: stamp(-340), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', sectionId: 'sec-3', damId: 'dam-2', code: 'CX-02', type: '测斜', initialValue: 0, threshold: 24, unit: 'mm', installDate: '2022-05-11', createdAt: stamp(-340), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', sectionId: 'sec-4', damId: 'dam-2', code: 'SY-02', type: '渗压', initialValue: 38.5, threshold: 6, unit: 'kPa', installDate: '2022-05-18', createdAt: stamp(-339), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的观测原始行：[测点, 日期, 读数, 观测人] */
const SEED_OBSERVATION_ROWS: Array<[string, string, number, string]> = [
  ['pt-1', '2024-04-10', 8.2, '刘振国'],
  ['pt-1', '2024-05-10', 15.4, '刘振国'],
  ['pt-1', '2024-06-09', 27.4, '陈文'],
  ['pt-2', '2024-04-10', 9.6, '刘振国'],
  ['pt-2', '2024-05-10', 16.2, '陈文'],
  ['pt-2', '2024-06-09', 27.9, '陈文'],
  ['pt-3', '2024-04-11', 12.8, '王丽'],
  ['pt-3', '2024-05-11', 13.4, '王丽'],
  ['pt-3', '2024-06-10', 14.7, '王丽'],
  ['pt-4', '2024-04-11', 5.4, '刘振国'],
  ['pt-4', '2024-06-10', 11.2, '刘振国'],
  ['pt-5', '2024-04-12', 46.8, '王丽'],
  ['pt-5', '2024-06-11', 51.6, '王丽'],
  ['pt-6', '2024-04-12', 13.3, '陈文'],
  ['pt-6', '2024-06-11', 13.9, '陈文'],
  ['pt-7', '2024-04-13', 6.8, '赵鹏'],
  ['pt-7', '2024-06-11', 14.2, '赵鹏'],
  ['pt-8', '2024-04-13', 7.5, '赵鹏'],
  ['pt-8', '2024-06-11', 18.4, '赵鹏'],
  ['pt-9', '2024-04-14', 39.6, '赵鹏'],
  ['pt-9', '2024-06-11', 43.5, '赵鹏']
]

const SEED_ALARMS: AlarmRow[] = [
  { id: 'al-1', pointId: 'pt-1', damId: 'dam-1', level: '橙', triggerValue: 27.4, triggerDate: '2024-06-09', state: '待处置', handler: '', measure: '', createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'al-2', pointId: 'pt-3', damId: 'dam-1', level: '黄', triggerValue: 2.1, triggerDate: '2024-06-10', state: '处置中', handler: '王丽', measure: '加密浸润线观测至每周一次，同时降低库水位', readingCorrected: true, createdAt: stamp(-2), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-3', pointId: 'pt-9', damId: 'dam-2', level: '黄', triggerValue: 5.0, triggerDate: '2024-06-11', state: '已撤销', handler: '', measure: '', canceledReason: '2024-06-11 读数由 44.200 订正为 43.500，订正后累计变化 5.000 kPa（占阈值 83.3%）不再越限，待处置预警自动撤销', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-4', pointId: 'pt-2', damId: 'dam-1', level: '黄', triggerValue: 27.9, triggerDate: '2024-06-09', state: '已闭环', handler: '陈文', measure: '复核测斜孔，补充人工观测，位移稳定后闭环', createdAt: stamp(-2), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-5', pointId: 'pt-5', damId: 'dam-1', level: '蓝', triggerValue: 6.6, triggerDate: '2024-06-11', state: '已闭环', handler: '王丽', measure: '渗压计校核后复测，读数正常', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'al-6', pointId: 'pt-7', damId: 'dam-2', level: '蓝', triggerValue: 14.2, triggerDate: '2024-06-11', state: '待处置', handler: '', measure: '', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POOLS: PoolRow[] = [
  { id: 'pl-1', damId: 'dam-1', date: '2024-04-10', waterLevelM: 709.8, beachLengthM: 132, freeboardM: 2.7, createdAt: stamp(-63), updatedAt: stamp(-63), revision: ROW_REVISION },
  { id: 'pl-2', damId: 'dam-1', date: '2024-05-10', waterLevelM: 710.4, beachLengthM: 118, freeboardM: 2.1, createdAt: stamp(-33), updatedAt: stamp(-33), revision: ROW_REVISION },
  { id: 'pl-3', damId: 'dam-1', date: '2024-06-09', waterLevelM: 711.1, beachLengthM: 96, freeboardM: 1.4, createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pl-4', damId: 'dam-2', date: '2024-05-10', waterLevelM: 642.1, beachLengthM: 88, freeboardM: 2.9, createdAt: stamp(-33), updatedAt: stamp(-33), revision: ROW_REVISION },
  { id: 'pl-5', damId: 'dam-2', date: '2024-06-09', waterLevelM: 643.4, beachLengthM: 74, freeboardM: 1.8, createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION }
]

/** 由原始行派生累计变化量与日速率 */
function buildSeedObservations(): ObservationRow[] {
  const previousByPoint = new Map<string, { date: string; reading: number }>()
  return SEED_OBSERVATION_ROWS.map(([pointId, date, reading, observer], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const initialValue = point ? point.initialValue : 0
    const previous = previousByPoint.get(pointId)
    const dailyRate = previous ? dailyRateOf(reading, previous.reading, daysBetween(previous.date, date)) : 0
    previousByPoint.set(pointId, { date, reading })
    return {
      id: `ob-${index + 1}`,
      pointId,
      date,
      reading,
      cumulative: cumulativeOf(reading, initialValue),
      dailyRate,
      observer,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

/**
 * 播种用订正记录：以观测列表中「同测点同日」的现存行为基准，
 * readingBefore 是订正前误录读数，readingAfter 必须与现存读数一致（订正已生效）。
 */
const SEED_CORRECTIONS: Array<{ pointId: string; date: string; before: number; corrector: string; reason: string }> = [
  { pointId: 'pt-3', date: '2024-06-10', before: 14.9, corrector: '王丽', reason: '人工复测发现水位测尺读数误录，按现场复测值订正' },
  { pointId: 'pt-9', date: '2024-06-11', before: 44.2, corrector: '赵鹏', reason: '渗压计基准点换算错误，复核后订正读数' }
]

function buildSeedCorrections(observations: ObservationRow[]): CorrectionRow[] {
  return SEED_CORRECTIONS.map((item, index) => {
    const target = observations.find((row) => row.pointId === item.pointId && row.date === item.date)
    if (!target) {
      throw new Error(`播种订正记录缺少对应观测：${item.pointId} @ ${item.date}`)
    }
    return {
      id: `cor-${index + 1}`,
      pointId: item.pointId,
      observationId: target.id,
      date: item.date,
      readingBefore: item.before,
      readingAfter: target.reading,
      corrector: item.corrector,
      reason: item.reason,
      createdAt: stamp(-1 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  const observations = buildSeedObservations()
  const corrections = buildSeedCorrections(observations)
  await db.transaction('rw', [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.corrections], async () => {
    await db.dams.bulkPut(SEED_DAMS)
    await db.sections.bulkPut(SEED_SECTIONS)
    await db.points.bulkPut(SEED_POINTS)
    await db.observations.bulkPut(observations)
    await db.alarms.bulkPut(SEED_ALARMS)
    await db.pools.bulkPut(SEED_POOLS)
    await db.corrections.bulkPut(corrections)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.dams.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteDamCascade(damId: string): Promise<void> {
  await db.transaction('rw', [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.corrections], async () => {
    const sections = await db.sections.where('damId').equals(damId).toArray()
    await deletePointsOfSections(sections.map((section) => section.id))
    if (sections.length > 0) await db.sections.bulkDelete(sections.map((section) => section.id))
    await db.pools.where('damId').equals(damId).delete()
    await db.dams.delete(damId)
  })
}

export async function deleteSectionCascade(sectionId: string): Promise<void> {
  await db.transaction('rw', db.sections, db.points, db.observations, db.alarms, db.corrections, async () => {
    await deletePointsOfSections([sectionId])
    await db.sections.delete(sectionId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction('rw', db.points, db.observations, db.alarms, db.corrections, async () => {
    await db.observations.where('pointId').equals(pointId).delete()
    await db.alarms.where('pointId').equals(pointId).delete()
    await db.corrections.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

async function deletePointsOfSections(sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return
  const points = await db.points.where('sectionId').anyOf(sectionIds).toArray()
  const pointIds = points.map((point) => point.id)
  if (pointIds.length > 0) {
    await db.observations.where('pointId').anyOf(pointIds).delete()
    await db.alarms.where('pointId').anyOf(pointIds).delete()
    await db.corrections.where('pointId').anyOf(pointIds).delete()
    await db.points.bulkDelete(pointIds)
  }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [dams, sections, points, observations, alarms, pools, corrections] = await Promise.all([
    db.dams.count(),
    db.sections.count(),
    db.points.count(),
    db.observations.count(),
    db.alarms.count(),
    db.pools.count(),
    db.corrections.count()
  ])
  return { dams, sections, points, observations, alarms, pools, corrections }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [dams, sections, points, observations, alarms, pools, corrections] = await Promise.all([
    db.dams.toArray(),
    db.sections.toArray(),
    db.points.toArray(),
    db.observations.toArray(),
    db.alarms.toArray(),
    db.pools.toArray(),
    db.corrections.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbtaildam',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    dams: dams.map(strip),
    sections: sections.map(strip),
    points: points.map(strip),
    observations: observations.map(strip),
    alarms: alarms.map(strip),
    pools: pools.map(strip),
    corrections: corrections.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction('rw', [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.corrections], async () => {
    await Promise.all([
      db.dams.clear(),
      db.sections.clear(),
      db.points.clear(),
      db.observations.clear(),
      db.alarms.clear(),
      db.pools.clear(),
      db.corrections.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.dams.bulkPut((payload.dams ?? []).map(rev))
    await db.sections.bulkPut((payload.sections ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.observations.bulkPut((payload.observations ?? []).map(rev))
    await db.alarms.bulkPut((payload.alarms ?? []).map(rev))
    await db.pools.bulkPut((payload.pools ?? []).map(rev))
    await db.corrections.bulkPut((payload.corrections ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.dams, db.sections, db.points, db.observations, db.alarms, db.pools, db.corrections], async () => {
    await Promise.all([
      db.dams.clear(),
      db.sections.clear(),
      db.points.clear(),
      db.observations.clear(),
      db.alarms.clear(),
      db.pools.clear(),
      db.corrections.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/** 观测录入：写入读数并重算当日及以后全部观测的累计变化量与日速率 */
export async function putObservation(
  row: Omit<Observation, 'cumulative' | 'dailyRate'> & { cumulative?: number; dailyRate?: number }
): Promise<ObservationRow> {
  return db.transaction('rw', db.points, db.observations, async () => {
    const next = await db.observations.put({
      ...row,
      cumulative: 0,
      dailyRate: 0,
      revision: ROW_REVISION
    } as ObservationRow)
    await recomputePointFrom(row.pointId, row.date)
    return (await db.observations.get(next)) as ObservationRow
  })
}

/**
 * 重算某测点自 fromDate（含）起的累计变化量与日速率。
 * 订正读数后只需重算订正日及以后：此前观测的累计/速率不受影响。
 * 调用方需自行开启包含 points / observations 的事务。
 */
async function recomputePointFrom(pointId: string, fromDate: string): Promise<number> {
  const point = await db.points.get(pointId)
  const initialValue = point ? point.initialValue : 0
  const rows = (await db.observations.where('pointId').equals(pointId).toArray()).sort((a, b) =>
    a.date.localeCompare(b.date)
  )
  const startIndex = rows.findIndex((row) => row.date >= fromDate)
  if (startIndex === -1) return 0
  const now = Date.now()
  const patches: ObservationRow[] = []
  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index]
    const previous = index === 0 ? null : rows[index - 1]
    patches.push({
      ...row,
      cumulative: cumulativeOf(row.reading, initialValue),
      dailyRate: previous ? dailyRateOf(row.reading, previous.reading, daysBetween(previous.date, row.date)) : 0,
      updatedAt: now
    })
  }
  await db.observations.bulkPut(patches)
  return patches.length
}

/** 重算某测点全部观测的累计变化量与日速率（初值/阈值变更后使用） */
export async function recalculateObservations(pointId: string): Promise<void> {
  await db.transaction('rw', db.points, db.observations, async () => {
    const first = (await db.observations.where('pointId').equals(pointId).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0]
    if (first) await recomputePointFrom(pointId, first.date)
  })
}

/** 订正后单张未闭环预警的处置结果 */
export interface CorrectionAlarmResult {
  alarmId: string
  level: Alarm['level']
  triggerValue: number
  state: Alarm['state']
  /** 处置中预警标记读数已订正，等人工重判 */
  readingCorrected: boolean
  canceledReason: string
}

export interface ReadingCorrectionResult {
  correction: CorrectionRow
  observation: ObservationRow
  /** 触发联动的未闭环预警（已闭环的保留当时内容，不出现在此） */
  alarms: CorrectionAlarmResult[]
}

/**
 * 读数订正（录错读数的正式入口）：
 * 1. 同一测点同一天允许多次订正，订正记录追加留痕，以最后一次订正为准；
 * 2. 用订正后读数覆盖观测，自订正日期起重算该测点后续累计变化与日速率；
 * 3. 联动该测点未闭环预警——
 *    - 已闭环：保留当时级别/触发值/处置内容，不做任何改动；
 *    - 待处置且订正后不再越限：自动转为「已撤销」并记录原因；
 *    - 仍越限（待处置/处置中）：按新值更新级别与触发值；处置中的保留状态并标记「读数已订正」等人工重判。
 */
export async function applyReadingCorrection(input: {
  pointId: string
  observationId: string
  readingAfter: number
  corrector: string
  reason: string
}): Promise<ReadingCorrectionResult> {
  const pointId = input.pointId
  const observationId = input.observationId
  const readingAfter = Number(input.readingAfter)
  if (!Number.isFinite(readingAfter)) {
    throw new Error('订正后读数不是有效数字')
  }
  const corrector = input.corrector.trim()
  const reason = input.reason.trim()
  if (!corrector) throw new Error('请填写订正人')
  if (!reason) throw new Error('请填写订正原因')

  return db.transaction('rw', db.points, db.observations, db.alarms, db.corrections, async () => {
    const target = await db.observations.get(observationId)
    if (!target || target.pointId !== pointId) {
      throw new Error('待订正的观测记录不存在')
    }
    const readingBefore = target.reading
    const now = Date.now()

    // 1. 追加订正留痕（同测点同日多次订正均保留，按时间排序后以最后一次为准）
    const correctionRow: CorrectionRow = {
      id: createId('cor'),
      pointId,
      observationId,
      date: target.date,
      readingBefore,
      readingAfter,
      corrector,
      reason,
      createdAt: now,
      revision: ROW_REVISION
    }
    await db.corrections.put(correctionRow)

    // 2. 覆盖读数并重算订正日及以后的累计变化与日速率
    await db.observations.update(observationId, { reading: readingAfter, updatedAt: now })
    await recomputePointFrom(pointId, target.date)

    // 3. 联动未闭环预警（已闭环/已撤销的终态单原样保留）
    const point = await db.points.get(pointId)
    const threshold = point ? point.threshold : 0
    const unit = point ? point.unit : ''
    const rowsAfter = (await db.observations.where('pointId').equals(pointId).toArray()).sort((a, b) =>
      a.date.localeCompare(b.date)
    )
    const obsByDate = new Map(rowsAfter.map((row) => [row.date, row]))
    const alarms = await db.alarms.where('pointId').equals(pointId).toArray()
    const results: CorrectionAlarmResult[] = []

    for (const alarm of alarms) {
      if (isAlarmTerminal(alarm.state)) continue
      // 仅重判触发日不早于订正日的预警：更早的预警其触发依据不受本次订正影响
      if (alarm.triggerDate < target.date) continue
      const triggerObs = obsByDate.get(alarm.triggerDate)
      if (!triggerObs) continue

      const newLevel = alarmLevelOf(triggerObs.cumulative, threshold)
      const ratio = ratioOf(triggerObs.cumulative, threshold)
      const patch: Partial<AlarmRow> = { updatedAt: now }

      if (newLevel === null) {
        if (alarm.state === '待处置') {
          // 订正后不再越限：待处置预警自动撤销
          patch.state = '已撤销'
          patch.triggerValue = triggerObs.cumulative
          patch.readingCorrected = false
          patch.canceledReason =
            `${target.date} 读数由 ${readingBefore.toFixed(3)} 订正为 ${readingAfter.toFixed(3)}，` +
            `订正后累计变化 ${triggerObs.cumulative.toFixed(3)} ${unit}（占阈值 ${formatRatio(ratio)}）不再越限，待处置预警自动撤销`
        } else {
          // 处置中：不自动关闭，保留处置状态并标记「读数已订正」等人工重判
          patch.triggerValue = triggerObs.cumulative
          patch.readingCorrected = true
        }
      } else {
        // 仍越限：按新值更新级别与触发值；处置中保留状态并标记待人工重判
        patch.level = newLevel
        patch.triggerValue = triggerObs.cumulative
        patch.readingCorrected = alarm.state === '处置中'
      }

      await db.alarms.update(alarm.id, patch)
      const updated = (await db.alarms.get(alarm.id)) as AlarmRow
      results.push({
        alarmId: alarm.id,
        level: updated.level,
        triggerValue: updated.triggerValue,
        state: updated.state,
        readingCorrected: updated.readingCorrected === true,
        canceledReason: updated.canceledReason ?? ''
      })
    }

    const observation = (await db.observations.get(observationId)) as ObservationRow
    return { correction: correctionRow, observation, alarms: results }
  })
}

/** 删除单条观测时同步删除其订正记录（仅本记录，不影响其他日期） */
export async function deleteObservationCascade(observationId: string): Promise<void> {
  await db.transaction('rw', db.observations, db.corrections, async () => {
    await db.corrections.where('observationId').equals(observationId).delete()
    await db.observations.delete(observationId)
  })
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastDamId: typeof parsed.lastDamId === 'string' ? parsed.lastDamId : null,
      alarmOnlyOpen: parsed.alarmOnlyOpen === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
