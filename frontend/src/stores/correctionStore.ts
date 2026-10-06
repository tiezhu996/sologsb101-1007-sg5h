/**
 * 订正记录状态（Zustand）
 * 维护订正留痕列表与订正动作；订正动作在 utils/correction 内单事务完成，
 * 写库后由 liveQuery 自动回流，观测累计量、日速率与预警联动均在同一事务内处理。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type CorrectionRow } from '@/utils/db'
import { applyReadingCorrection } from '@/utils/correction'
import type { Correction, CorrectionDraft, CorrectionEffect } from '@/types/correction'

interface CorrectionState {
  corrections: Correction[]
  ready: boolean
  applyCorrection: (draft: CorrectionDraft) => Promise<{ correction: Correction; effect: CorrectionEffect }>
  removeCorrection: (id: string) => Promise<void>
}

export const useCorrectionStore = create<CorrectionState>(() => ({
  corrections: [],
  ready: false,

  async applyCorrection(draft) {
    const { correction, effect } = await applyReadingCorrection(draft)
    return { correction, effect }
  },

  async removeCorrection(id) {
    // 订正留痕仅作审计，不提供普通删除入口；保留方法以保持表操作封装一致
    await db.corrections.delete(id)
  }
}))

liveQuery(async () =>
  (await db.corrections.toArray()).sort((a, b) =>
    b.correctedAt === a.correctedAt
      ? b.date.localeCompare(a.date)
      : b.correctedAt - a.correctedAt
  )
).subscribe({
  next: (rows: CorrectionRow[]) => useCorrectionStore.setState({ corrections: rows, ready: true }),
  error: () => useCorrectionStore.setState({ ready: true })
})
