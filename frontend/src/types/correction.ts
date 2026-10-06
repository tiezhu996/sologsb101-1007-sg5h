/**
 * 订正记录：录错读数后重新订正留痕。
 * 同一测点同一天以最后一次订正为准；订正前读数、订正后读数、订正人与原因全部留痕。
 */

/** 订正入参（由观测录入页弹窗收集） */
export interface CorrectionDraft {
  observationId: string
  pointId: string
  /** 观测日期 YYYY-MM-DD（与被订正观测一致） */
  date: string
  /** 订正前读数（留痕，取自原观测） */
  readingBefore: number
  /** 订正后读数 */
  readingAfter: number
  /** 订正人 */
  corrector: string
  /** 订正原因 */
  reason: string
}

export const EMPTY_CORRECTION_DRAFT: CorrectionDraft = {
  observationId: '',
  pointId: '',
  date: '',
  readingBefore: 0,
  readingAfter: 0,
  corrector: '',
  reason: ''
}

export interface Correction {
  id: string
  observationId: string
  pointId: string
  /** 冗余坝体 id，便于按坝体筛选 */
  damId: string
  /** 观测日期 YYYY-MM-DD */
  date: string
  /** 订正前读数 */
  readingBefore: number
  /** 订正后读数（同一测点同一天以最后一次订正为准） */
  readingAfter: number
  /** 订正人 */
  corrector: string
  /** 订正原因 */
  reason: string
  correctedAt: number
}

/** 订正动作对后续链路的处置结果（用于页面提示） */
export interface CorrectionEffect {
  /** 本次重算的观测条数（含被订正当日） */
  recalculated: number
  /** 按新值更新的未闭环预警条数 */
  updatedAlarms: number
  /** 订正后不再越限、转为已撤销的待处置预警条数 */
  revokedAlarms: number
  /** 标记“读数已订正”待人工重判的处置中预警条数 */
  flaggedAlarms: number
  /** 已闭环保留当时内容的预警条数 */
  untouchedClosedAlarms: number
}

export function createEmptyCorrectionDraft(): CorrectionDraft {
  return { ...EMPTY_CORRECTION_DRAFT }
}
