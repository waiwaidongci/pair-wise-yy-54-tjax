export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
  version: number
  recalc?: boolean
  recalcReason?: string
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  content: string
  condition?: string
  status: '待处理' | '已接受' | '已退回'
  recalc?: boolean
}

// 共用路段：相邻两个路线点确定一条路段，可被多个阶段经过
export interface RoadSection {
  id: string
  name: string
  points: [number, number][]
  version: number
  source: 'legacy' | 'handover'
  stageIds: string[]
}

// 路段改占值
export interface SectionValue {
  sectionId: string
  value: string
}

// 现场记录：带阶段版本与现场单号
export interface SiteRecord {
  id: string
  handoverId: string
  stageId: string
  stageVersion: number
  party: 'site' | 'duty'
  changes: SectionValue[]
  status: '已确认' | '待核' | '已关闭'
  confirmedSectionIds: string[]
  submittedAt: string
}

// 两边都改了同一路段：保留现场值，登记冲突
export interface SectionConflict {
  sectionId: string
  siteValue: string
  dutyValue: string
  resolution: '保留现场值'
}

// 后到内容待核
export interface PendingItem {
  id: string
  handoverId: string
  recordId: string
  party: 'site' | 'duty'
  changes: SectionValue[]
  reason: string
  submittedAt: string
}

// 交接账
export interface Handover {
  id: string
  stageId: string
  status: '进行中' | '已交接' | '待核'
  siteRecordId?: string
  dutyRecordId?: string
  effective: Record<string, string>
  conflicts: SectionConflict[]
  confirmedSectionIds: string[]
  createdAt: string
  closedAt?: string
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
  sections: RoadSection[]
  handovers: Handover[]
  siteRecords: SiteRecord[]
  pendingItems: PendingItem[]
}
