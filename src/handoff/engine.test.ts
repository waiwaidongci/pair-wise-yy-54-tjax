import { describe, expect, it } from 'vitest'
import {
  applyDutyAdjustment, createLedger, recomputeDetour, recomputeStage,
  reverifyCondition, resolveConflict, routeSegments, segmentIdOf, submitHandoff,
} from './engine'
import type { SiteRecord } from './types'
import type { CreateLedgerInput, EngineEnv } from './engine'

const A: [number, number] = [121.470, 31.228]
const B: [number, number] = [121.482, 31.231]
const C: [number, number] = [121.496, 31.235]
const D: [number, number] = [121.508, 31.238]
const E: [number, number] = [121.452, 31.224]
const F: [number, number] = [121.462, 31.226]
const K: [number, number] = [121.478, 31.214]
const L: [number, number] = [121.516, 31.242]
const M: [number, number] = [121.462, 31.219]
const N: [number, number] = [121.480, 31.222]

const BC = segmentIdOf(B, C)

function testEnv(): EngineEnv {
  let n = 0
  let id = 0
  return {
    now: () => `2026-10-09T08:${String(++n).padStart(2, '0')}.000Z`,
    nextId: (prefix: string) => `${prefix}-T${++id}`,
  }
}

function legacyInput(): CreateLedgerInput {
  return {
    schemeId: 'RC-2026-0918',
    stages: [
      { id: 'ST-01', name: '东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 收窄为 2', version: 2, route: [A, B, C] },
      { id: 'ST-02', name: '路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', version: 1, route: [B, C, D] },
      { id: 'ST-03', name: '西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '占用西侧公交专用道', version: 1, route: [E, F] },
    ],
    detours: [
      { id: 'DR-01', name: '急救绕行', kind: '急救', distance: 4.8, extraMinutes: 11, coordinates: [K, B, C, L] },
      { id: 'DR-02', name: '公交辅道', kind: '公交', distance: 2.3, extraMinutes: 6, coordinates: [M, N] },
    ],
    conditions: [
      { id: 'CM-42', stageId: 'ST-02', unit: '应急', author: '夏川', content: '南门通道被切断', condition: '保留 4 米应急通道', status: '已接受', createdAt: '2026-10-05T10:00:00Z' },
      { id: 'CM-43', stageId: 'ST-03', unit: '交通', author: '郑航', content: '延误增加 19 分钟', condition: '缩减围挡 1.5 米', status: '已接受', createdAt: '2026-10-05T11:00:00Z' },
      { id: 'CM-41', stageId: 'ST-01', unit: '公交', author: '顾敏', content: '临时站超步行距离', condition: '增设临时站', status: '待处理', createdAt: '2026-10-05T12:00:00Z' },
    ],
  }
}

function siteRecord(partial: Partial<SiteRecord> & Pick<SiteRecord, 'siteTicket' | 'occupation'>): SiteRecord {
  return { stageId: 'ST-01', stageVersion: 2, segmentId: BC, at: '2026-10-09T08:00:00Z', ...partial }
}

describe('路段编号', () => {
  it('与方向无关：正反端点生成同一编号', () => {
    expect(segmentIdOf(B, C)).toBe(segmentIdOf(C, B))
    expect(segmentIdOf(A, B)).not.toBe(segmentIdOf(B, C))
  })
})

describe('旧方案迁移', () => {
  it('缺路段编号时按路线点生成首版，保留原时间与意见', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    expect(ledger.stages[0].migrated).toBe(true)
    expect(ledger.stages[0].segmentIds).toHaveLength(2)
    expect(ledger.segments[BC].stageIds).toEqual(['ST-01', 'ST-02']) // 共用路段
    const cm42 = ledger.conditions.find((c) => c.id === 'CM-42')!
    expect(cm42.createdAt).toBe('2026-10-05T10:00:00Z')
    expect(cm42.content).toBe('南门通道被切断')
    expect(cm42.condition).toBe('保留 4 米应急通道')
    expect(cm42.status).toBe('已接受')
    expect(ledger.stages[0].start).toBe('2026-10-08')
  })

  it('已有路段编号的方案不标记迁移', () => {
    const input = legacyInput()
    input.stages[0].segmentIds = routeSegments(input.stages[0].route).map((p) => p.id)
    const ledger = createLedger(input, testEnv())
    expect(ledger.stages[0].migrated).toBe(false)
    expect(ledger.stages[1].migrated).toBe(true)
  })
})

describe('现场回传只合并同一路段', () => {
  it('无主路段记录不并入任何路段，转待核', () => {
    const ledger = createLedger(legacyInput(), testEnv())
    const rev0 = ledger.revision
    const summary = submitHandoff(ledger, 'HX-1', [
      siteRecord({ siteTicket: 'XD-9', occupation: '新围挡', segmentId: 'SEG-UNKNOWN' }),
    ], testEnv())
    expect(summary.outcomes[0].result).toBe('segment_not_found')
    expect(ledger.pending[0].kind).toBe('无主路段待核')
    expect(ledger.segments[BC].occupation).toBe('双向 4 收窄为 2')
    expect(ledger.revision).toBeGreaterThan(rev0) // 仅审计与待核记账，不改动权威路段
  })

  it('现场记录用反向端点也能定位同一路段', () => {
    const ledger = createLedger(legacyInput(), testEnv())
    submitHandoff(ledger, 'HX-2', [
      siteRecord({ siteTicket: 'XD-10', occupation: '3 车道', segmentId: undefined, endpoints: [C, B] }),
    ], testEnv())
    expect(ledger.segments[BC].occupation).toBe('3 车道')
  })
})

describe('两边都改同一段：保留现场值 + 冲突', () => {
  it('值班室先调、现场晚回：现场值生效，值班室值入冲突待核', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    applyDutyAdjustment(ledger, { stageId: 'ST-01', segmentId: BC, occupation: '值班室夜间方案' }, env)
    expect(ledger.stages[0].version).toBe(3)

    const summary = submitHandoff(ledger, 'HX-3', [
      siteRecord({ siteTicket: 'XD-11', stageVersion: 2, occupation: '现场实测范围' }),
    ], env)
    expect(summary.outcomes[0].result).toBe('conflict')
    expect(ledger.segments[BC].occupation).toBe('现场实测范围')
    expect(ledger.segments[BC].occupiedBy).toBe('现场')
    const conflict = ledger.conflicts[0]
    expect(conflict.siteValue).toBe('现场实测范围')
    expect(conflict.dutyValue).toBe('值班室夜间方案')
    expect(conflict.status).toBe('待核')

    resolveConflict(ledger, conflict.id, '维持现场值', env)
    expect(ledger.conflicts[0].status).toBe('已核裁')
    expect(ledger.segments[BC].occupation).toBe('现场实测范围')
  })

  it('核裁采用值班室值时回写并重新级联', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    applyDutyAdjustment(ledger, { stageId: 'ST-01', segmentId: BC, occupation: '值班室方案B' }, env)
    submitHandoff(ledger, 'HX-4', [siteRecord({ siteTicket: 'XD-12', stageVersion: 2, occupation: '现场值A' })], env)
    const conflict = ledger.conflicts[0]
    resolveConflict(ledger, conflict.id, '采用值班室值', env)
    expect(ledger.segments[BC].occupation).toBe('值班室方案B')
    expect(ledger.stages[0].version).toBe(4)
  })
})

describe('路段变化的级联范围', () => {
  it('只令经过该段的后续阶段、绕行与已接受条件失效，其余保留', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    submitHandoff(ledger, 'HX-5', [
      siteRecord({ siteTicket: 'XD-13', stageVersion: 2, occupation: '现场收窄 1 车道' }),
    ], env)

    const st2 = ledger.stages.find((s) => s.id === 'ST-02')!
    const st3 = ledger.stages.find((s) => s.id === 'ST-03')!
    expect(st2.status).toBe('待重算')
    expect(st2.invalidatedBySegment).toBe(BC)
    expect(st3.status).toBe('待执行') // 不经过 B-C，保留
    expect(st3.invalidatedBySegment).toBeUndefined()

    const emergency = ledger.detours.find((d) => d.id === 'DR-01')!
    const bus = ledger.detours.find((d) => d.id === 'DR-02')!
    expect(emergency.needsRecompute).toBe(true)
    expect(bus.needsRecompute).toBe(false)

    expect(ledger.conditions.find((c) => c.id === 'CM-42')!.status).toBe('失效待重算')
    expect(ledger.conditions.find((c) => c.id === 'CM-43')!.status).toBe('已接受')
    expect(ledger.conditions.find((c) => c.id === 'CM-41')!.status).toBe('待处理')
  })

  it('重算通过后恢复，其他阶段不受影响', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    submitHandoff(ledger, 'HX-6', [siteRecord({ siteTicket: 'XD-14', occupation: '新范围' })], env)
    recomputeStage(ledger, 'ST-02', env)
    recomputeDetour(ledger, 'DR-01', env)
    reverifyCondition(ledger, 'CM-42', true, env)
    expect(ledger.stages[1].status).toBe('待执行')
    expect(ledger.detours[0].needsRecompute).toBe(false)
    expect(ledger.conditions[0].status).toBe('已接受')
    expect(ledger.stages[2].status).toBe('待执行')
  })
})

describe('并发提交：先到生效，后到待核', () => {
  it('处理中另一人提交不同内容：后到整体待核，不改已确认路段', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    const first = [
      siteRecord({ siteTicket: 'XD-20', occupation: '先到-路段1' }),
      siteRecord({ siteTicket: 'XD-21', occupation: '先到-路段2' }),
    ]
    const fail = submitHandoff(ledger, 'HX-7', first, env, { failAt: { index: 1, reason: '网络中断' } })
    expect(fail.closed).toBe(false)
    expect(ledger.tickets[0].status).toBe('传输中')
    expect(ledger.segments[BC].occupation).toBe('先到-路段1')

    const later = [
      siteRecord({ siteTicket: 'XD-20', occupation: '后到想覆盖-路段1' }),
      siteRecord({ siteTicket: 'XD-99', occupation: '后到-其他' }),
    ]
    const second = submitHandoff(ledger, 'HX-7', later, env)
    expect(second.outcomes.every((o) => o.result === 'written_pending')).toBe(true)
    expect(ledger.segments[BC].occupation).toBe('先到-路段1') // 先到未被覆盖
    expect(ledger.pending.filter((p) => p.kind === '后到待核')).toHaveLength(2)
  })

  it('先到关闭后另一批内容到达：仍转待核，先到内容保持', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    submitHandoff(ledger, 'HX-8', [siteRecord({ siteTicket: 'XD-30', occupation: '先到值' })], env)
    const after = submitHandoff(ledger, 'HX-8', [siteRecord({ siteTicket: 'XD-31', occupation: '另一批值' })], env)
    expect(after.closed).toBe(true)
    expect(after.outcomes[0].result).toBe('written_pending')
    expect(ledger.segments[BC].occupation).toBe('先到值')
  })
})

describe('写入失败断点续传与幂等', () => {
  it('按原单号从已确认路段继续，已处理记录不重复并账', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    const records = [
      siteRecord({ siteTicket: 'XD-40', occupation: '第一段' }),
      siteRecord({ siteTicket: 'XD-41', occupation: '第二段' }),
    ]
    const first = submitHandoff(ledger, 'HX-9', records, env, { failAt: { index: 1, reason: '写入超时' } })
    expect(first.failed?.index).toBe(1)
    expect(ledger.tickets[0].confirmedIndices).toEqual([0])
    const historyLen = ledger.segments[BC].history.length

    const retry = submitHandoff(ledger, 'HX-9', records, env)
    expect(retry.closed).toBe(true)
    expect(retry.outcomes.map((o) => o.result)).toEqual(['duplicate', 'applied'])
    expect(ledger.segments[BC].occupation).toBe('第二段')
    // 第一段只并账一次，重放不产生重复历史
    expect(ledger.segments[BC].history.filter((h) => h.siteTicket === 'XD-40')).toHaveLength(1)
    expect(ledger.segments[BC].history.length).toBe(historyLen + 1)
  })

  it('交接单关闭后重复提交：幂等不重复关闭、不重复改动', () => {
    const env = testEnv()
    const ledger = createLedger(legacyInput(), env)
    const records = [siteRecord({ siteTicket: 'XD-50', occupation: '终值' })]
    submitHandoff(ledger, 'HX-10', records, env)
    const closedAt = ledger.tickets[0].closedAt
    const historyLen = ledger.segments[BC].history.length
    const revBefore = ledger.revision

    const again = submitHandoff(ledger, 'HX-10', records, env)
    expect(again.outcomes[0].result).toBe('closed_noop')
    expect(ledger.tickets[0].closedAt).toBe(closedAt)
    expect(ledger.segments[BC].history.length).toBe(historyLen)
    expect(ledger.segments[BC].occupation).toBe('终值')
    // 只有一条审计，没有新的路段改动审计
    expect(ledger.audit.filter((a) => a.action === '现场并账')).toHaveLength(1)
    expect(ledger.revision - revBefore).toBe(1) // 仅「重复提交」审计一条
  })
})
