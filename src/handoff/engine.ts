/**
 * 交接账引擎：阶段执行 / 共用路段 / 绕行条件 / 会签并账。
 *
 * 设计约定（对应交接规则）：
 * 1. 并账只按规范化路段编号合并，晚回记录不会整体盖掉值班室的新调整；
 * 2. 两边都改同一段：现场值保留为权威值，值班室值登记为冲突待核；
 * 3. 任一路段变化，只令「经过该路段的后续阶段 / 绕行 / 已接受条件」失效重算，其余原样保留；
 * 4. 同一交接单先到生效、后到待核；写入失败按原单号 + 已确认路段断点续传；重复提交不重复关闭；
 * 5. 旧方案缺路段编号时按路线点生成首版，原时间与意见原样保留。
 *
 * 本文件不依赖 Vue / DOM，可直接在 Node 下单测。
 */
import type {
  AuditEntry, ChangeSource, ConditionState, ConflictResolution, DetourKind, DetourState,
  HandoffLedger, HandoffTicket, MergeConflict, MergeOutcome, PendingSubmission, Point,
  SegmentChange, SegmentState, SiteRecord, StageExec,
} from './types'

const COORD_K = 6

/** 时钟与序号环境；测试可注入固定实现保证结果可复现。 */
export interface EngineEnv { now: () => string; nextId: (prefix: string) => string }

export function createEnv(): EngineEnv {
  let seq = 0
  return {
    now: () => new Date().toISOString(),
    nextId: (prefix) => `${prefix}-${(++seq).toString(36).toUpperCase().padStart(4, '0')}`,
  }
}

function round(n: number) { return Number(n.toFixed(COORD_K)) }
function pointKey(p: Point) { return `${round(p[0])},${round(p[1])}` }

function fnv1a(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** 与方向无关的规范化路段编号：两端点相同（顺序可互换）即同一路段。 */
export function segmentIdOf(a: Point, b: Point): string {
  const [x, y] = [pointKey(a), pointKey(b)].sort()
  return `SEG-${fnv1a(`${x}|${y}`).toString(36).toUpperCase().padStart(7, '0').slice(-7)}`
}

/** 按路线点顺序拆分连续路段（相邻重复点自动去重）。 */
export function routeSegments(route: Point[]): { id: string; endpoints: [Point, Point] }[] {
  const out: { id: string; endpoints: [Point, Point] }[] = []
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1]
    if (pointKey(a) === pointKey(b)) continue
    out.push({ id: segmentIdOf(a, b), endpoints: [a, b] })
  }
  return out
}

function digestRecords(records: SiteRecord[]) {
  return fnv1a(JSON.stringify(records.map((r) => [r.siteTicket, r.stageId, r.stageVersion, r.segmentId ?? '', r.occupation, r.at]))).toString(36)
}

/* ---------------- 建账（含旧方案迁移） ---------------- */

export interface LegacyCondition {
  id: string
  stageId: string
  unit: ConditionState['unit']
  author: string
  content: string
  condition?: string
  status: ConditionState['status']
  createdAt?: string
}

export interface LegacyStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status?: string
  version?: number
  route: Point[]
  /** 已有路段编号时直接沿用；为空视为旧方案，按路线点生成首版。 */
  segmentIds?: string[]
}

export interface LegacyDetour {
  id: string
  name: string
  kind?: DetourKind
  distance: number
  extraMinutes: number
  coordinates: Point[]
}

export interface CreateLedgerInput {
  schemeId: string
  stages: LegacyStage[]
  detours: LegacyDetour[]
  conditions: LegacyCondition[]
}

export function createLedger(input: CreateLedgerInput, env: EngineEnv = createEnv()): HandoffLedger {
  const ledger: HandoffLedger = {
    schemeId: input.schemeId, revision: 0, createdAt: env.now(),
    stages: [], segments: {}, detours: [], conditions: [], tickets: [], conflicts: [], pending: [], audit: [],
  }

  input.stages.forEach((raw, order) => {
    const pairs = routeSegments(raw.route)
    const hasIds = raw.segmentIds && raw.segmentIds.length === pairs.length
    const migrated = !hasIds
    const version = raw.version ?? 1
    const stage: StageExec = {
      id: raw.id, name: raw.name, start: raw.start, end: raw.end,
      status: order === 0 ? '执行中' : '待执行',
      version, route: raw.route,
      segmentIds: pairs.map((p) => p.id),
      migrated,
    }
    ledger.stages.push(stage)
    pairs.forEach((pair) => {
      const seg = ledger.segments[pair.id] ?? {
        id: pair.id, endpoints: pair.endpoints, occupation: raw.lanes,
        occupiedBy: '现场' as ChangeSource, occupiedStageVersion: version,
        stageIds: [], detourIds: [], history: [],
      }
      if (!seg.stageIds.includes(raw.id)) seg.stageIds.push(raw.id)
      ledger.segments[pair.id] = seg
    })
  })

  input.detours.forEach((raw) => {
    const pairs = routeSegments(raw.coordinates)
    const detour: DetourState = {
      id: raw.id, name: raw.name, kind: raw.kind ?? '普通',
      distance: raw.distance, extraMinutes: raw.extraMinutes,
      coordinates: raw.coordinates, segmentIds: pairs.map((p) => p.id),
      needsRecompute: false,
    }
    ledger.detours.push(detour)
    pairs.forEach((pair) => {
      const seg = ledger.segments[pair.id]
      if (seg) { if (!seg.detourIds.includes(raw.id)) seg.detourIds.push(raw.id) }
      else {
        ledger.segments[pair.id] = {
          id: pair.id, endpoints: pair.endpoints, occupation: '（绕行路段）',
          occupiedBy: '现场', occupiedStageVersion: 0, stageIds: [], detourIds: [raw.id], history: [],
        }
      }
    })
  })

  // 旧意见：锚点、原文、原时间一律保留，不因迁移而改写。
  input.conditions.forEach((c) => {
    ledger.conditions.push({
      id: c.id, stageId: c.stageId, unit: c.unit, author: c.author,
      content: c.content, condition: c.condition,
      status: c.status === '已接受' || c.status === '已退回' || c.status === '待处理' ? c.status : '待处理',
      createdAt: c.createdAt ?? '（旧方案原始时间未登记）',
    })
  })

  const migratedCount = ledger.stages.filter((s) => s.migrated).length
  pushAudit(ledger, env, '建账', `建立执行交接账；${migratedCount} 个阶段无路段编号，已按路线点生成首版，原时间与意见保留。`)
  return ledger
}

/* ---------------- 审计 ---------------- */

function pushAudit(ledger: HandoffLedger, env: EngineEnv, action: string, detail: string) {
  ledger.revision += 1
  ledger.audit.unshift({ at: env.now(), action, detail })
}

/* ---------------- 路段定位与变化级联 ---------------- */

function resolveSegmentId(ledger: HandoffLedger, record: SiteRecord): string | undefined {
  if (record.segmentId && ledger.segments[record.segmentId]) return record.segmentId
  if (record.endpoints) {
    const id = segmentIdOf(record.endpoints[0], record.endpoints[1])
    if (ledger.segments[id]) return id
  }
  return undefined
}

function stageOrder(ledger: HandoffLedger, stageId: string) {
  return ledger.stages.findIndex((s) => s.id === stageId)
}

/**
 * 路段变化级联：仅令经过该段的「后续阶段 / 绕行 / 已接受条件」失效重算。
 * 变化发生的当前阶段与不经过该段的其他阶段原样保留。
 */
function invalidateDownstream(ledger: HandoffLedger, segmentId: string, changedStageId: string, env: EngineEnv) {
  const changedOrder = stageOrder(ledger, changedStageId)
  const changedStage = ledger.stages[changedOrder]

  ledger.detours.forEach((d) => {
    if (!d.needsRecompute && d.segmentIds.includes(segmentId)) {
      d.needsRecompute = true
      d.invalidatedBySegment = segmentId
      pushAudit(ledger, env, '绕行失效', `${d.name}（${d.kind}）经过 ${segmentId}，标记重算。`)
    }
  })

  ledger.stages.forEach((s, order) => {
    if (s.id === changedStageId || order <= changedOrder) return
    if (s.status === '已完成' || s.status === '待重算') return
    if (s.segmentIds.includes(segmentId)) {
      s.status = '待重算'
      s.invalidatedBySegment = segmentId
      pushAudit(ledger, env, '阶段失效', `${s.name} 经过 ${segmentId}，自${changedStage?.id ?? ''}路段变化后待重算；其他阶段保留。`)
    }
  })

  ledger.conditions.forEach((c) => {
    if (c.status !== '已接受') return
    const owner = ledger.stages.find((s) => s.id === c.stageId)
    const order = stageOrder(ledger, c.stageId)
    if (owner && order > changedOrder && owner.segmentIds.includes(segmentId)) {
      c.status = '失效待重算'
      c.priorStatus = '已接受'
      pushAudit(ledger, env, '条件失效', `${c.unit}${c.author}的已接受条件锚定 ${c.stageId}（经过 ${segmentId}），转入失效待重算。`)
    }
  })
}

function applySegmentChange(
  ledger: HandoffLedger, segment: SegmentState, after: string, source: ChangeSource,
  stageVersion: number, siteTicket: string | undefined, env: EngineEnv,
): SegmentChange | undefined {
  if (segment.occupation === after) return undefined
  const change: SegmentChange = {
    at: env.now(), source, stageVersion, siteTicket, before: segment.occupation, after,
  }
  segment.occupation = after
  segment.occupiedBy = source
  segment.occupiedStageVersion = stageVersion
  segment.history.unshift(change)
  return change
}

/* ---------------- 值班室调整 ---------------- */

export interface DutyAdjustment { stageId: string; segmentId: string; occupation: string }

/** 值班室直接改占路范围：版本 +1，并对下游级联失效；内容不变则空操作。 */
export function applyDutyAdjustment(ledger: HandoffLedger, adj: DutyAdjustment, env: EngineEnv = createEnv()) {
  const stage = ledger.stages.find((s) => s.id === adj.stageId)
  const seg = stage && ledger.segments[adj.segmentId]
  if (!stage || !seg) throw new Error(`路段未找到：${adj.stageId}/${adj.segmentId}`)
  if (!stage.segmentIds.includes(adj.segmentId)) throw new Error(`${adj.segmentId} 不属于 ${adj.stageId}`)
  if (seg.occupation === adj.occupation) return stage.version

  stage.version += 1
  const change = applySegmentChange(ledger, seg, adj.occupation, '值班室', stage.version, undefined, env)
  if (change) {
    pushAudit(ledger, env, '值班室调整', `${stage.id} v${stage.version}：${seg.id}「${change.before}」→「${change.after}」。`)
    invalidateDownstream(ledger, seg.id, stage.id, env)
  }
  return stage.version
}

/* ---------------- 现场回传并账 ---------------- */

/**
 * 合并单条现场记录。返回结果语义：
 * - applied        现场值已并账（无冲突）；
 * - conflict       两边都改了同一段：保留现场值为权威值，值班室值登记冲突待核；
 * - duplicate      该记录此前已确认（断点续传重放）；
 * - segment_not_found / stage_version_stale：无法并账，转待核队列。
 */
function mergeRecord(ledger: HandoffLedger, record: SiteRecord, env: EngineEnv): MergeOutcome {
  const base: MergeOutcome = {
    recordIndex: -1, siteTicket: record.siteTicket, segmentId: record.segmentId ?? '',
    result: 'applied', detail: '', confirmed: false,
  }
  const stage = ledger.stages.find((s) => s.id === record.stageId)
  if (!stage) return { ...base, result: 'segment_not_found', detail: `阶段 ${record.stageId} 不存在` }

  const segId = resolveSegmentId(ledger, record)
  base.segmentId = segId ?? ''
  if (!segId) {
    queuePending(ledger, {
      kind: '无主路段待核', siteTicket: record.siteTicket, stageId: record.stageId,
      segmentId: record.segmentId, occupation: record.occupation, payload: record,
      reason: `回传路段在本方案中不存在（${record.segmentId ?? '端点未匹配'}），不并入任何路段。`,
    }, env)
    return { ...base, result: 'segment_not_found', detail: '路段不在本方案，转待核' }
  }
  const seg = ledger.segments[segId]

  if (record.stageVersion > stage.version) {
    queuePending(ledger, {
      kind: '后到待核', siteTicket: record.siteTicket, stageId: record.stageId,
      segmentId: segId, occupation: record.occupation, payload: record,
      reason: `现场记录基于 v${record.stageVersion}，本账阶段仅到 v${stage.version}，版本超前，先到内容保持生效。`,
    }, env)
    return { ...base, result: 'stage_version_stale', detail: '版本超前，转待核' }
  }

  // 值班室在现场记录所基于的版本之后改过同一段，即「两边都改了同一段」。
  const dutyChange = seg.history.find((h) => h.source === '值班室' && h.stageVersion > record.stageVersion)
  const bothEdited = !!dutyChange && dutyChange.after !== record.occupation

  if (bothEdited && seg.occupation !== record.occupation) {
    const dutyValue = seg.occupation
    const change = applySegmentChange(ledger, seg, record.occupation, '现场', record.stageVersion, record.siteTicket, env)
    const conflict: MergeConflict = {
      id: env.nextId('CF'), siteTicket: record.siteTicket, segmentId: segId,
      stageId: record.stageId, stageVersion: record.stageVersion,
      siteValue: record.occupation, dutyValue, dutyBefore: dutyChange.before,
      status: '待核', at: env.now(),
    }
    ledger.conflicts.unshift(conflict)
    if (change) invalidateDownstream(ledger, segId, record.stageId, env)
    pushAudit(
      ledger, env, '冲突并账',
      `${record.siteTicket} 回传 ${segId}：保留现场值「${record.occupation}」，值班室值「${dutyValue}」登记冲突 ${conflict.id} 待核。`,
    )
    return { ...base, result: 'conflict', detail: `现场值保留，值班室值进入冲突 ${conflict.id}`, confirmed: true }
  }

  const change = applySegmentChange(ledger, seg, record.occupation, '现场', record.stageVersion, record.siteTicket, env)
  if (change) {
    pushAudit(ledger, env, '现场并账', `${record.siteTicket}（${record.stageId} v${record.stageVersion}）并入 ${segId}：「${change.before}」→「${change.after}」。`)
    invalidateDownstream(ledger, segId, record.stageId, env)
    return { ...base, result: 'applied', detail: '现场值已并入同一路段', confirmed: true }
  }
  return { ...base, result: 'applied', detail: '与当前值一致，确认路段', confirmed: true }
}

function queuePending(ledger: HandoffLedger, p: Omit<PendingSubmission, 'id' | 'at'>, env: EngineEnv) {
  ledger.pending.unshift({ ...p, id: env.nextId('PD'), at: env.now() })
}

/* ---------------- 交接单提交（并发 / 断点续传 / 幂等） ---------------- */

export interface SubmitSummary {
  ticket: HandoffTicket
  /** 本轮处理的结果（含重放的 duplicate）。 */
  outcomes: MergeOutcome[]
  failed?: { index: number; reason: string }
  closed: boolean
}

export interface SubmitOptions {
  /** 模拟在处理到某索引前发生写入失败（断点续传测试/演示用）。 */
  failAt?: { index: number; reason: string }
}

/**
 * 提交（或按原单号重试）一张交接单。
 * - 同一批次内容（按现场记录摘要判断）：失败后再次提交即从首个未确认路段续作；
 * - 交接单已关闭后原样重提：幂等不重复关闭；
 * - 交接单处理期间另一人提交不同内容：先到内容生效，后到整体转待核，不改已确认路段。
 */
export function submitHandoff(
  ledger: HandoffLedger, ticketId: string, records: SiteRecord[],
  env: EngineEnv = createEnv(), opts: SubmitOptions = {},
): SubmitSummary {
  const digest = digestRecords(records)
  let ticket = ledger.tickets.find((t) => t.id === ticketId)

  if (!ticket) {
    ticket = {
      id: ticketId, status: '已开立', openedAt: env.now(), records,
      processedIndices: [], confirmedIndices: [], outcomes: [],
    }
    ledger.tickets.unshift(ticket)
    pushAudit(ledger, env, '交接开立', `${ticketId} 开立，含 ${records.length} 条现场记录。`)
  }

  // 已关闭：同内容幂等；不同内容为后到提交，待核且不重新关闭。
  if (ticket.status === '已关闭') {
    if ((ticket as HandoffTicket & { digest?: string }).digest === digest) {
      const outcomes = records.map((r, i) => ({
        recordIndex: i, siteTicket: r.siteTicket, segmentId: r.segmentId ?? '',
        result: 'closed_noop' as const, detail: '交接单已关闭，重复提交不重复关闭', confirmed: true,
      }))
      pushAudit(ledger, env, '重复提交', `${ticketId} 已关闭，原单号重复提交，幂等忽略。`)
      return { ticket, outcomes, closed: true }
    }
    records.forEach((r) => queuePending(ledger, {
      kind: '后到待核', siteTicket: r.siteTicket, stageId: r.stageId, segmentId: r.segmentId,
      occupation: r.occupation, payload: r,
      reason: `交接单 ${ticketId} 已关闭后到达的另一批内容，先到内容保持生效。`,
    }, env))
    pushAudit(ledger, env, '后到待核', `${ticketId} 关闭后收到另一批 ${records.length} 条记录，整体待核。`)
    return {
      ticket,
      outcomes: records.map((r, i) => ({
        recordIndex: i, siteTicket: r.siteTicket, segmentId: r.segmentId ?? '',
        result: 'written_pending' as const, detail: '后到内容待核', confirmed: false,
      })),
      closed: true,
    }
  }

  const t = ticket as HandoffTicket & { digest?: string }
  if (!t.digest) t.digest = digest

  // 处理中另一人提交不同内容：先到生效，后到整体待核。
  if (t.digest !== digest) {
    records.forEach((r) => queuePending(ledger, {
      kind: '后到待核', siteTicket: r.siteTicket, stageId: r.stageId, segmentId: r.segmentId,
      occupation: r.occupation, payload: r,
      reason: `交接单 ${ticketId} 已有先到提交在并账，后到内容不改已确认路段。`,
    }, env))
    pushAudit(ledger, env, '后到待核', `${ticketId} 处理中收到另一人提交的 ${records.length} 条不同记录，整体待核。`)
    return {
      ticket,
      outcomes: records.map((r, i) => ({
        recordIndex: i, siteTicket: r.siteTicket, segmentId: r.segmentId ?? '',
        result: 'written_pending' as const, detail: '先到生效，后到待核', confirmed: false,
      })),
      closed: false,
    }
  }

  const outcomes: MergeOutcome[] = []
  for (let i = 0; i < records.length; i++) {
    if (ticket.processedIndices.includes(i)) {
      const prev = ticket.outcomes.find((o) => o.recordIndex === i)
      outcomes.push({
        recordIndex: i, siteTicket: records[i].siteTicket, segmentId: prev?.segmentId ?? records[i].segmentId ?? '',
        result: 'duplicate', detail: '已确认路段，断点续传跳过', confirmed: true,
      })
      continue
    }
    if (opts.failAt?.index === i) {
      ticket.status = '传输中'
      ticket.failedAt = { index: i, reason: opts.failAt.reason, at: env.now() }
      pushAudit(ledger, env, '写入失败', `${ticketId} 写入到第 ${i + 1}/${records.length} 条（${records[i].siteTicket}）失败：${opts.failAt.reason}；已确认 ${ticket.confirmedIndices.length} 段，可按原单号续传。`)
      return { ticket, outcomes, failed: { index: i, reason: opts.failAt.reason }, closed: false }
    }

    const outcome = { ...mergeRecord(ledger, records[i], env), recordIndex: i }
    ticket.outcomes = ticket.outcomes.filter((o) => o.recordIndex !== i)
    ticket.outcomes.push(outcome)
    ticket.processedIndices.push(i)
    if (outcome.confirmed) ticket.confirmedIndices.push(i)
    outcomes.push(outcome)
  }

  ticket.status = '已关闭'
  ticket.closedAt = env.now()
  ticket.failedAt = undefined
  pushAudit(
    ledger, env, '交接关闭',
    `${ticketId} 并账完成：确认 ${ticket.confirmedIndices.length} 段，待核 ${ticket.outcomes.filter((o) => !o.confirmed).length} 条。`,
  )
  return { ticket, outcomes, closed: true }
}

/* ---------------- 冲突核裁 / 重算恢复 ---------------- */

/** 核裁冲突：维持现场值则只销账；采用值班室值则回写并再次级联。 */
export function resolveConflict(ledger: HandoffLedger, conflictId: string, resolution: ConflictResolution, env: EngineEnv = createEnv()) {
  const conflict = ledger.conflicts.find((c) => c.id === conflictId)
  if (!conflict || conflict.status === '已核裁') return
  conflict.status = '已核裁'
  conflict.resolution = resolution
  if (resolution === '采用值班室值') {
    const seg = ledger.segments[conflict.segmentId]
    const stage = ledger.stages.find((s) => s.id === conflict.stageId)
    if (seg && stage) {
      stage.version += 1
      applySegmentChange(ledger, seg, conflict.dutyValue, '值班室', stage.version, undefined, env)
      invalidateDownstream(ledger, seg.id, stage.id, env)
    }
  }
  pushAudit(ledger, env, '冲突核裁', `${conflictId} 结论：${resolution}。`)
}

export function recomputeStage(ledger: HandoffLedger, stageId: string, env: EngineEnv = createEnv()) {
  const stage = ledger.stages.find((s) => s.id === stageId)
  if (!stage || stage.status !== '待重算') return
  stage.status = '待执行'
  stage.invalidatedBySegment = undefined
  pushAudit(ledger, env, '阶段重算', `${stage.name} 已按新路段重算，恢复待执行。`)
}

export function recomputeDetour(ledger: HandoffLedger, detourId: string, env: EngineEnv = createEnv()) {
  const detour = ledger.detours.find((d) => d.id === detourId)
  if (!detour || !detour.needsRecompute) return
  detour.needsRecompute = false
  detour.invalidatedBySegment = undefined
  pushAudit(ledger, env, '绕行重算', `${detour.name}（${detour.kind}）绕行已重新核算可用。`)
}

/** 失效条件重新会签：通过则恢复「已接受」，否则退回。 */
export function reverifyCondition(ledger: HandoffLedger, conditionId: string, accepted: boolean, env: EngineEnv = createEnv()) {
  const c = ledger.conditions.find((x) => x.id === conditionId)
  if (!c || c.status !== '失效待重算') return
  c.status = accepted ? c.priorStatus ?? '已接受' : '已退回'
  c.priorStatus = undefined
  pushAudit(ledger, env, '条件重签', `${c.unit}${c.author}的条件${accepted ? '重算通过，恢复已接受' : '重算后退回'}。`)
}
