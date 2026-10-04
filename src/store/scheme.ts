import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ClosureStage, Handover, RoadSection, Scheme, SectionValue, SegmentComment, SiteRecord } from '../types'

const STORAGE_KEY = 'yy54-road-scheme-v2'

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`
}
function pointKey(p: [number, number]) { return `${p[0]},${p[1]}` }
function now() { return new Date().toISOString() }

const seed: Scheme = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
  stages: [
    { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', version: 1, route: [[121.470,31.228],[121.482,31.231],[121.496,31.235]] },
    { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', version: 1, route: [[121.496,31.235],[121.508,31.238],[121.516,31.242]] },
    { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', version: 1, route: [[121.452,31.224],[121.462,31.226],[121.470,31.228],[121.482,31.231]] },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470,31.228],[121.478,31.214],[121.502,31.218],[121.516,31.242]] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452,31.224],[121.462,31.219],[121.496,31.235]] },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理' },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受' },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回' },
    { id: 'CM-44', segmentId: 'ST-03', unit: '应急', author: '夏川', content: '西半幅恢复期间，云河路—江海大道口应急通道须保持净宽。', condition: '保留 4 米应急通道，不得占用。', status: '已接受' },
  ],
  sections: [],
  handovers: [],
  siteRecords: [],
  pendingItems: [],
}

// 旧方案缺路段编号：按路线点生成首版路段，原时间与意见原样保留
function generateSections(stages: ClosureStage[]): RoadSection[] {
  const edgeMap = new Map<string, RoadSection>()
  let counter = 1
  for (const stage of stages) {
    for (let i = 0; i < stage.route.length - 1; i++) {
      const a = stage.route[i], b = stage.route[i + 1]
      const ka = pointKey(a), kb = pointKey(b)
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      const existing = edgeMap.get(key)
      if (existing) {
        if (!existing.stageIds.includes(stage.id)) existing.stageIds.push(stage.id)
      } else {
        const id = `RS-${String(counter).padStart(2, '0')}`
        counter += 1
        edgeMap.set(key, { id, name: `路段 ${id}`, points: [a, b], version: 1, source: 'legacy', stageIds: [stage.id] })
      }
    }
  }
  return [...edgeMap.values()]
}

export type SubmitOutcome = '已生效' | '待核' | '已续作' | '重复提交' | '写入失败'

export interface HandoverInput {
  handoverId?: string
  stageId: string
  party: 'site' | 'duty'
  changes: SectionValue[]
  recordId?: string
  forceFail?: boolean
}

export interface HandoverResult {
  handover: Handover
  record: SiteRecord
  outcome: SubmitOutcome
  failedSectionId?: string
  confirmedCount: number
}

export const useSchemeStore = defineStore('scheme', () => {
  const scheme = ref<Scheme>(structuredClone(seed))
  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  const history = ref<string[]>([])
  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))
  const conflicts = computed(() => [
    ...(scheme.value.stages.some((stage) => stage.id === 'ST-02') ? [{ id: 'CF-01', level: '高', segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }] : []),
    { id: 'CF-02', level: '高', segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'CF-03', level: '中', segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'CF-04', level: '中', segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])
  const dirty = computed(() => history.value.length > 0)

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme.value)) }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      scheme.value = JSON.parse(raw)
      // 旧方案迁移：缺路段编号则按路线点生成首版，时间与意见不动
      if (!scheme.value.sections || scheme.value.sections.length === 0) {
        scheme.value.sections = generateSections(scheme.value.stages)
        persist()
      }
    }
  }
  function commit() { history.value.push(JSON.stringify(scheme.value)); persist() }

  // 首版路段（幂等）：旧方案按路线点生成，保留原时间与意见
  function ensureSections() {
    if (scheme.value.sections.length === 0) {
      scheme.value.sections = generateSections(scheme.value.stages)
      persist()
    }
  }

  function sectionsForStage(stageId: string): RoadSection[] {
    return scheme.value.sections.filter((section) => section.stageIds.includes(stageId))
  }

  function handoverForStage(stageId: string): Handover | undefined {
    return scheme.value.handovers.find((item) => item.stageId === stageId && item.status === '进行中')
  }

  function findRecord(handoverId: string, party: 'site' | 'duty'): SiteRecord | undefined {
    return scheme.value.siteRecords.find((item) => item.handoverId === handoverId && item.party === party)
  }

  // 路段一变：只让经过该路段的后续阶段与已接受条件失效重算，其他阶段保留
  function cascadeInvalidation(handover: Handover) {
    const stage = scheme.value.stages.find((item) => item.id === handover.stageId)
    if (!stage) return
    const confirmed = new Set(handover.confirmedSectionIds)
    const affectedStageIds = new Set<string>()
    for (const sectionId of confirmed) {
      const section = scheme.value.sections.find((item) => item.id === sectionId)
      if (!section) continue
      for (const id of section.stageIds) {
        if (id !== handover.stageId) affectedStageIds.add(id)
      }
    }
    for (const id of affectedStageIds) {
      const target = scheme.value.stages.find((item) => item.id === id)
      if (!target) continue
      if (target.start > stage.start) {
        target.recalc = true
        target.recalcReason = `共用路段调整，需重算绕行与占路安排`
      }
    }
    for (const comment of scheme.value.comments) {
      if (comment.status !== '已接受') continue
      const target = scheme.value.stages.find((item) => item.id === comment.segmentId)
      if (target && target.recalc) comment.recalc = true
    }
  }

  function submitHandover(input: HandoverInput): HandoverResult {
    ensureSections()
    const stage = scheme.value.stages.find((item) => item.id === input.stageId)
    if (!stage) throw new Error('阶段不存在')

    // 定位或新建交接账
    let handover = input.handoverId ? scheme.value.handovers.find((item) => item.id === input.handoverId) : undefined
    if (!handover) handover = handoverForStage(input.stageId)
    if (!handover) {
      handover = {
        id: uid('HO'), stageId: input.stageId, status: '进行中',
        effective: {}, conflicts: [], confirmedSectionIds: [],
        createdAt: now(),
      }
      scheme.value.handovers.push(handover)
    }

    // 定位记录：原单号续作优先
    let record: SiteRecord | undefined = input.recordId
      ? scheme.value.siteRecords.find((item) => item.id === input.recordId)
      : findRecord(handover.id, input.party)

    const isResume = !!record && record.status === '待核' && record.id === input.recordId
    if (record && record.status !== '待核' && record.id === input.recordId) {
      // 重复提交不重复关闭
      return { handover, record, outcome: '重复提交', confirmedCount: record.confirmedSectionIds.length }
    }

    if (!record) {
      record = {
        id: uid('SR'), handoverId: handover.id, stageId: input.stageId,
        stageVersion: stage.version, party: input.party,
        changes: input.changes, status: '待核',
        confirmedSectionIds: [], submittedAt: now(),
      }
      scheme.value.siteRecords.push(record)
      if (input.party === 'site') handover.siteRecordId = record.id
      else handover.dutyRecordId = record.id
    }

    // 交接已关闭：后到内容待核
    if (handover.status === '已交接' && !isResume) {
      record.status = '待核'
      mergeConflicts(handover, record)
      scheme.value.pendingItems.push({
        id: uid('PI'), handoverId: handover.id, recordId: record.id,
        party: input.party, changes: input.changes,
        reason: '交接已关闭，后到内容待核', submittedAt: now(),
      })
      persist()
      return { handover, record, outcome: '待核', confirmedCount: record.confirmedSectionIds.length }
    }

    // 逐路段写入：只合并同一路段；失败则从已确认路段续作
    const changes = record.changes.length ? record.changes : input.changes
    let failedSectionId: string | undefined
    for (const change of changes) {
      if (record.confirmedSectionIds.includes(change.sectionId)) continue
      // 模拟写入失败（仅首次提交）
      if (input.forceFail && !input.recordId) { failedSectionId = change.sectionId; break }
      applyChange(handover, record, change)
    }

    if (failedSectionId) {
      record.status = '待核'
      persist()
      return { handover, record, outcome: '写入失败', failedSectionId, confirmedCount: record.confirmedSectionIds.length }
    }

    record.status = '已确认'
    record.submittedAt = now()

    // 先到生效：首份提交即关闭交接
    if (handover.status === '进行中') {
      handover.status = '已交接'
      handover.closedAt = now()
      stage.version += 1
      stage.status = '条件通过'
      scheme.value.version += 1
      cascadeInvalidation(handover)
    }

    persist()
    return {
      handover, record,
      outcome: isResume ? '已续作' : '已生效',
      confirmedCount: record.confirmedSectionIds.length,
    }
  }

  function applyChange(handover: Handover, record: SiteRecord, change: SectionValue) {
    const section = scheme.value.sections.find((item) => item.id === change.sectionId)
    if (!section) return
    const otherParty: 'site' | 'duty' = record.party === 'site' ? 'duty' : 'site'
    const otherRecord = otherParty === 'site'
      ? scheme.value.siteRecords.find((item) => item.id === handover.siteRecordId)
      : scheme.value.siteRecords.find((item) => item.id === handover.dutyRecordId)
    const otherChange = otherRecord?.changes.find((item) => item.sectionId === change.sectionId)
    if (otherChange && otherChange.value !== change.value) {
      // 两边都改了同一段：保留现场值，登记冲突
      const siteValue = record.party === 'site' ? change.value : otherChange.value
      const dutyValue = record.party === 'site' ? otherChange.value : change.value
      handover.conflicts.push({ sectionId: change.sectionId, siteValue, dutyValue, resolution: '保留现场值' })
      handover.effective[change.sectionId] = siteValue
    } else {
      handover.effective[change.sectionId] = change.value
    }
    if (!handover.confirmedSectionIds.includes(change.sectionId)) handover.confirmedSectionIds.push(change.sectionId)
    if (!record.confirmedSectionIds.includes(change.sectionId)) record.confirmedSectionIds.push(change.sectionId)
  }

  function mergeConflicts(handover: Handover, record: SiteRecord) {
    for (const change of record.changes) {
      const existing = handover.conflicts.find((item) => item.sectionId === change.sectionId)
      if (existing) continue
      const effective = handover.effective[change.sectionId]
      if (effective !== undefined && effective !== change.value) {
        const siteValue = record.party === 'site' ? change.value : effective
        const dutyValue = record.party === 'site' ? effective : change.value
        handover.conflicts.push({ sectionId: change.sectionId, siteValue, dutyValue, resolution: '保留现场值' })
        handover.effective[change.sectionId] = siteValue
      }
    }
  }

  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2) {
      const stage = selectedStage.value
      if (stage) { commit(); stage.route = [...draftRoute.value]; stage.status = '待协商'; scheme.value.version += 1; persist() }
    }
    drawing.value = false
    draftRoute.value = []
  }
  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    commit(); Object.assign(stage, patch); stage.status = '待协商'; scheme.value.version += 1; persist()
  }
  function resolveComment(id: string, status: SegmentComment['status']) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    commit(); comment.status = status; scheme.value.version += 1; persist()
  }
  function undo() {
    const previous = history.value.pop()
    if (previous) { scheme.value = JSON.parse(previous); persist() }
  }
  watch(selectedStageId, () => {})
  restore()
  ensureSections()
  return {
    scheme, selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, conflicts, dirty,
    sectionsForStage, handoverForStage, submitHandover, ensureSections,
    startDraw, addPoint, finishDraw, updateStage, resolveComment, undo,
  }
})
