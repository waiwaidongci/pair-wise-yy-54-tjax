/**
 * 施工阶段执行交接账 · 领域类型
 *
 * 交接账把「阶段执行、共用路段、绕行条件、会签」四者接到同一本可续作的账上：
 * - 现场记录携带阶段版本与现场单号，回传后只与同一路段合并；
 * - 两边都改同一段时保留现场值并登记冲突；
 * - 路段变化只令经过该段的后续阶段与已接受条件失效重算，其余保留。
 */

export type Point = [number, number]

/** 阶段执行状态。「待重算」表示其经过的路段被上游改坏，需重新核算后才继续。 */
export type ExecStatus = '执行中' | '待执行' | '待重算' | '已完成'

/** 记录来源：现场 / 值班室。 */
export type ChangeSource = '现场' | '值班室'

/** 绕行通道类别：公交、急救为强制会签通道。 */
export type DetourKind = '公交' | '急救' | '普通'

/** 会签条件状态。「失效待重算」表示所锚定阶段经过的路段已变化。 */
export type ConditionStatus = '待处理' | '已接受' | '已退回' | '失效待重算'

/** 冲突处理结论。 */
export type ConflictResolution = '维持现场值' | '采用值班室值'

export interface SegmentState {
  /** 规范化、与方向无关的路段编号，两个端点相同即同一路段。 */
  id: string
  /** 原始端点，顺序按路线点给出，仅用于展示。 */
  endpoints: [Point, Point]
  /** 当前占路范围描述（权威值）。 */
  occupation: string
  /** 当前权威值由谁最近一次改动。 */
  occupiedBy: ChangeSource
  /** 最近一次改动对应的阶段版本。 */
  occupiedStageVersion: number
  /** 经过该路段的阶段（共用路段）。 */
  stageIds: string[]
  /** 使用该路段绕行的通道。 */
  detourIds: string[]
  history: SegmentChange[]
}

export interface SegmentChange {
  at: string
  source: ChangeSource
  /** 现场记录携带的阶段版本；值班室调整取当前阶段版本。 */
  stageVersion: number
  /** 现场单号；值班室调整为空。 */
  siteTicket?: string
  before: string
  after: string
}

export interface StageExec {
  id: string
  name: string
  start: string
  end: string
  status: ExecStatus
  /** 阶段自身的占路版本号，几何每次调整 +1，现场回传不改它。 */
  version: number
  route: Point[]
  segmentIds: string[]
  /** 值班室尚未并账的临时调整。 */
  pendingDuty?: string
  /** 因上游路段变化而失效时，记录受影响的路段。 */
  invalidatedBySegment?: string
  /** 迁移自旧方案（原无路段编号，按路线点生成首版）。 */
  migrated?: boolean
}

export interface DetourState {
  id: string
  name: string
  kind: DetourKind
  distance: number
  extraMinutes: number
  coordinates: Point[]
  segmentIds: string[]
  /** 所经路段变化后置 true，待重新核算绕行。 */
  needsRecompute: boolean
  invalidatedBySegment?: string
}

export interface ConditionState {
  id: string
  /** 旧方案意见直接锚定阶段；保留原时间与意见原文。 */
  stageId: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  content: string
  condition?: string
  status: ConditionStatus
  createdAt: string
  /** 失效前的状态，重算通过时恢复。 */
  priorStatus?: '已接受'
}

export interface SiteRecord {
  siteTicket: string
  stageId: string
  /** 现场记录基于的阶段版本。 */
  stageVersion: number
  /** 规范化路段编号；为空时按两端点现场计算。 */
  segmentId?: string
  /** 与路段端点不一致时用于定位同一路段。 */
  endpoints?: [Point, Point]
  occupation: string
  at: string
}

export type ConflictOutcome =
  | 'applied'
  | 'conflict'
  | 'duplicate'
  | 'closed_noop'
  | 'written_pending'
  | 'stage_version_stale'
  | 'segment_not_found'

export interface MergeOutcome {
  recordIndex: number
  siteTicket: string
  segmentId: string
  result: ConflictOutcome
  detail: string
  /** 该段是否已确认（可作为断点续传位置）。 */
  confirmed: boolean
}

export interface MergeConflict {
  id: string
  siteTicket: string
  segmentId: string
  stageId: string
  stageVersion: number
  /** 现场值并账后为权威值。 */
  siteValue: string
  /** 值班室在同一段上的新调整，等待核裁。 */
  dutyValue: string
  /** 冲突被并账覆盖前的值班室占路值。 */
  dutyBefore?: string
  status: '待核' | '已核裁'
  resolution?: ConflictResolution
  at: string
}

/** 交接单状态：开立 → 传输中（出现写入失败）→ 已关闭。 */
export type TicketStatus = '已开立' | '传输中' | '已关闭'
/** 后到提交的处置：先到生效、后到待核。 */
export type PendingKind = '后到待核' | '无主路段待核'

export interface PendingSubmission {
  id: string
  kind: PendingKind
  siteTicket: string
  stageId?: string
  segmentId?: string
  occupation?: string
  payload: unknown
  reason: string
  at: string
}

export interface AuditEntry {
  at: string
  action: string
  detail: string
}

export interface HandoffLedger {
  schemeId: string
  revision: number
  createdAt: string
  stages: StageExec[]
  segments: Record<string, SegmentState>
  detours: DetourState[]
  conditions: ConditionState[]
  tickets: HandoffTicket[]
  conflicts: MergeConflict[]
  pending: PendingSubmission[]
  audit: AuditEntry[]
}

export interface HandoffTicket {
  id: string
  status: TicketStatus
  openedAt: string
  closedAt?: string
  /** 本次交接期望并账的全部现场记录。 */
  records: SiteRecord[]
  /** 已经处理过（并账或转待核）的记录索引，重试时重放为 duplicate。 */
  processedIndices: number[]
  /** 已确认（成功并账）的记录索引——断点续传从这里之后继续。 */
  confirmedIndices: number[]
  /** 最近一次写入失败的索引与原因。 */
  failedAt?: { index: number; reason: string; at: string }
  outcomes: MergeOutcome[]
}
