/**
 * 订正记录：观测读数录错后的留痕单据。
 * 同一测点同一天允许多次订正，按 createdAt 排序后以最后一次订正为准；
 * 每次订正都会从订正日期起重算该测点后续观测的累计变化与日速率，
 * 并联动重判该测点尚未闭环的预警单。
 */
export interface ReadingCorrection {
  id: string
  pointId: string
  /** 关联的观测记录 id（同一测点同一天唯一） */
  observationId: string
  /** 观测日期 YYYY-MM-DD */
  date: string
  /** 订正前读数 */
  readingBefore: number
  /** 订正后读数 */
  readingAfter: number
  /** 订正人 */
  corrector: string
  /** 订正原因 */
  reason: string
  createdAt: number
}

export interface ReadingCorrectionDraft {
  readingAfter: number
  corrector: string
  reason: string
}

export const EMPTY_CORRECTION_DRAFT: ReadingCorrectionDraft = {
  readingAfter: 0,
  corrector: '',
  reason: ''
}
