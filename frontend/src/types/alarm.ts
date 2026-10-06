/** 预警：观测值越限生成的预警单 */
export type AlarmLevel = '蓝' | '黄' | '橙' | '红'
/**
 * 待处置：等待处置
 * 处置中：已开始处置
 * 已闭环：处置完成归档
 * 已撤销：读数订正后不再越限（仅待处置预警可被自动撤销）
 */
export type AlarmState = '待处置' | '处置中' | '已闭环' | '已撤销'

export interface Alarm {
  id: string
  pointId: string
  /** 冗余坝体 id，便于按坝体筛选 */
  damId: string
  level: AlarmLevel
  /** 触发值（累计变化量，读数订正后按新值更新） */
  triggerValue: number
  triggerDate: string
  state: AlarmState
  /** 处置人 */
  handler: string
  /** 处置措施 */
  measure: string
  /** 读数订正标记：处置中的预警受订正影响，等待人工重判 */
  readingCorrected?: boolean
  /** 最近一次影响该预警的订正记录 id（留痕，便于追溯） */
  lastCorrectionId?: string
  createdAt: number
  updatedAt: number
}

export const ALARM_LEVELS: AlarmLevel[] = ['蓝', '黄', '橙', '红']
export const ALARM_STATES: AlarmState[] = ['待处置', '处置中', '已闭环', '已撤销']

/** 仍需处置、会随读数订正联动的状态 */
export const OPEN_ALARM_STATES: AlarmState[] = ['待处置', '处置中']

/** 已终结状态（闭环归档 / 订正撤销），不再参与状态机推进与订正联动 */
export const TERMINAL_ALARM_STATES: AlarmState[] = ['已闭环', '已撤销']

/** 预警状态机：待处置 → 处置中 → 已闭环；已闭环 / 已撤销为终态 */
export const ALARM_STATE_FLOW: Record<AlarmState, AlarmState | null> = {
  待处置: '处置中',
  处置中: '已闭环',
  已闭环: null,
  已撤销: null
}

export const ALARM_LEVEL_WEIGHT: Record<AlarmLevel, number> = { 红: 40, 橙: 30, 黄: 20, 蓝: 10 }

/** 是否仍待处置（读数订正时需要按新值联动） */
export function isOpenAlarm(state: AlarmState): boolean {
  return state === '待处置' || state === '处置中'
}

/** 是否已终结（不再计入未闭环预警） */
export function isTerminalAlarm(state: AlarmState): boolean {
  return state === '已闭环' || state === '已撤销'
}

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
