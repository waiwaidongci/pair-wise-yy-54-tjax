import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  applyDutyAdjustment as engineDuty, createLedger, createEnv, recomputeDetour,
  recomputeStage, reverifyCondition, resolveConflict, submitHandoff,
} from '../handoff/engine'
import { useSchemeStore } from './scheme'
import type { ConflictResolution, DetourKind, HandoffLedger, SiteRecord } from '../handoff/types'

const STORAGE_KEY = 'yy54-handoff-ledger-v1'

function inferKind(name: string): DetourKind {
  if (/急救|救护|应急/.test(name)) return '急救'
  if (/公交/.test(name)) return '公交'
  return '普通'
}

/** 从封路方案种子构建/迁移执行交接账（旧方案无路段编号 → 按路线点生成首版）。 */
function buildFromScheme(): HandoffLedger {
  const scheme = useSchemeStore().scheme
  return createLedger({
    schemeId: scheme.id,
    stages: scheme.stages.map((s) => ({
      id: s.id, name: s.name, start: s.start, end: s.end, lanes: s.lanes,
      status: s.status, version: scheme.version, route: s.route,
    })),
    detours: scheme.detours.map((d) => ({ ...d, kind: inferKind(d.name) })),
    conditions: scheme.comments.map((c) => ({
      id: c.id, stageId: c.segmentId, unit: c.unit, author: c.author,
      content: c.content, condition: c.condition, status: c.status,
    })),
  }, createEnv())
}

export const useHandoffStore = defineStore('handoff', () => {
  const ledger = ref<HandoffLedger>(buildFromScheme())
  const env = createEnv()

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger.value)) }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) { try { ledger.value = JSON.parse(raw) } catch { /* 损坏则重建 */ } }
  }
  function reset() { localStorage.removeItem(STORAGE_KEY); ledger.value = buildFromScheme(); persist() }

  const sharedSegments = computed(() =>
    Object.values(ledger.value.segments)
      .filter((seg) => seg.stageIds.length > 1 || seg.detourIds.length > 0)
      .sort((a, b) => b.stageIds.length + b.detourIds.length - a.stageIds.length - a.detourIds.length),
  )
  const openConflicts = computed(() => ledger.value.conflicts.filter((c) => c.status === '待核'))
  const pendingItems = computed(() => ledger.value.pending)
  const failedTicket = computed(() => ledger.value.tickets.find((t) => t.status === '传输中'))

  function dutyAdjust(stageId: string, segmentId: string, occupation: string) {
    engineDuty(ledger.value, { stageId, segmentId, occupation }, env)
    persist()
  }

  /** 值班室提交一批现场记录（模拟交接单）。failAtIndex 用于演示写入失败。 */
  function submit(ticketId: string, records: SiteRecord[], failAtIndex?: number, reason = '网络中断') {
    const summary = submitHandoff(
      ledger.value, ticketId, records, env,
      failAtIndex === undefined ? {} : { failAt: { index: failAtIndex, reason } },
    )
    persist()
    return summary
  }

  function decideConflict(id: string, resolution: ConflictResolution) { resolveConflict(ledger.value, id, resolution, env); persist() }
  function recompute(stageId: string) { recomputeStage(ledger.value, stageId, env); persist() }
  function fixDetour(id: string) { recomputeDetour(ledger.value, id, env); persist() }
  function reverify(id: string, accepted: boolean) { reverifyCondition(ledger.value, id, accepted, env); persist() }

  restore()
  return {
    ledger, sharedSegments, openConflicts, pendingItems, failedTicket,
    persist, restore, reset, dutyAdjust, submit, decideConflict, recompute, fixDetour, reverify,
  }
})
