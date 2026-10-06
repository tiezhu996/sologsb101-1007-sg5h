/** 预警：观测值越限生成的预警单 */
export type AlarmLevel = '蓝' | '黄' | '橙' | '红'
export type AlarmState = '待处置' | '处置中' | '已闭环' | '已撤销'

export interface Alarm {
  id: string
  pointId: string
  /** 冗余坝体 id，便于按坝体筛选 */
  damId: string
  level: AlarmLevel
  /** 触发值（累计变化量） */
  triggerValue: number
  triggerDate: string
  state: AlarmState
  /** 处置人 */
  handler: string
  /** 处置措施 */
  measure: string
  /** 读数订正标记：触发依据已被订正，处置中预警保留状态等人工重判 */
  readingCorrected?: boolean
  /** 撤销说明：待处置预警因订正后不再越限自动撤销时留痕 */
  canceledReason?: string
  createdAt: number
  updatedAt: number
}

export const ALARM_LEVELS: AlarmLevel[] = ['蓝', '黄', '橙', '红']
/** 全部处置状态（含订正联动产生的「已撤销」终态） */
export const ALARM_STATES: AlarmState[] = ['待处置', '处置中', '已闭环', '已撤销']
/** 仍在处置链路中的状态（待处置 / 处置中）；已闭环与已撤销为终态 */
export const OPEN_ALARM_STATES: AlarmState[] = ['待处置', '处置中']

/** 预警状态机：待处置 → 处置中 → 已闭环；订正后不再越限的待处置预警自动转为已撤销 */
export const ALARM_STATE_FLOW: Record<AlarmState, AlarmState | null> = {
  待处置: '处置中',
  处置中: '已闭环',
  已闭环: null,
  已撤销: null
}

export const ALARM_LEVEL_WEIGHT: Record<AlarmLevel, number> = { 红: 40, 橙: 30, 黄: 20, 蓝: 10 }

export interface AlarmDraft {
  pointId: string
  level: AlarmLevel
  triggerValue: number
  triggerDate: string
  state: AlarmState
  handler: string
  measure: string
}

export const EMPTY_ALARM_DRAFT: AlarmDraft = {
  pointId: '',
  level: '蓝',
  triggerValue: 0,
  triggerDate: '',
  state: '待处置',
  handler: '',
  measure: ''
}

export function createEmptyAlarmDraft(): AlarmDraft {
  return { ...EMPTY_ALARM_DRAFT }
}

/** 是否为终态（不可再推进处置） */
export function isAlarmTerminal(state: AlarmState): boolean {
  return state === '已闭环' || state === '已撤销'
}
