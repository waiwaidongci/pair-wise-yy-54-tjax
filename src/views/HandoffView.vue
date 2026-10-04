<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useHandoffStore } from '../store/handoff'
import { segmentIdOf } from '../handoff/engine'
import type { MergeOutcome, SiteRecord } from '../handoff/types'

const store = useHandoffStore()
const { ledger } = store

/* ---------------- 现场回传单表单 ---------------- */
const ticketId = ref('HX-20261009-01')
const siteTicket = ref('XD-2601')
const stageId = ref('ST-01')
const baseVersion = ref<number>(ledger.stages[0]?.version ?? 1)
const occupation = ref('现场实测：夜间围挡东移 6 米，保留 3 米人非混行道')
const simulateFail = ref(false)
const lastOutcomes = ref<MergeOutcome[]>([])

const stageSegments = computed(() => {
  const stage = ledger.stages.find((s) => s.id === stageId.value)
  if (!stage) return []
  return stage.segmentIds.map((id) => ledger.segments[id]).filter(Boolean)
})
const segmentId = ref<string>('')
function syncSegment() {
  const list = stageSegments.value
  if (!list.some((s) => s.id === segmentId.value)) segmentId.value = list[0]?.id ?? ''
  baseVersion.value = ledger.stages.find((s) => s.id === stageId.value)?.version ?? 1
}
syncSegment()

function nowText() { return new Date().toLocaleString('zh-CN', { hour12: false }) }
function buildRecord(): SiteRecord {
  return {
    siteTicket: siteTicket.value, stageId: stageId.value, stageVersion: baseVersion.value,
    segmentId: segmentId.value, occupation: occupation.value, at: nowText(),
  }
}

function doSubmit(resume = false) {
  const failed = store.failedTicket
  const records = resume ? failed?.records ?? [] : [buildRecord()]
  if (resume && !failed) { Message.warning('暂无可续传的交接单'); return }
  const id = resume ? failed!.id : ticketId.value
  const summary = store.submit(id, records, !resume && simulateFail.value ? records.length - 1 : undefined, '现场回传写入超时')
  lastOutcomes.value = summary.outcomes
  if (summary.failed) Message.warning(`第 ${summary.failed.index + 1} 条写入失败：${summary.failed.reason}，可按原单号 ${id} 续传`)
  else if (summary.closed) Message.success(`交接单 ${id} 已并账关闭`)
  else Message.info('交接单处理中')
}

/* ---------------- 预置演示脚本（对应四类规则） ---------------- */
function scenarioConflict() {
  const seg = segmentId.value || segmentIdOf([121.482, 31.231], [121.496, 31.235])
  store.dutyAdjust('ST-01', seg, '值班室夜间管制：占路东移 8 米（v+1）')
  const stage = ledger.stages.find((s) => s.id === 'ST-01')!
  const record: SiteRecord = {
    siteTicket: 'XD-LATE-01', stageId: 'ST-01', stageVersion: stage.version - 1,
    segmentId: seg, occupation: '现场实测：维持原围挡，夜间收窄为 1 车道', at: nowText(),
  }
  const summary = store.submit('HX-CONFLICT', [record])
  lastOutcomes.value = summary.outcomes
  Message.info('值班室先调、现场晚回：现场值保留，值班室值进入冲突待核')
}

function scenarioFailure() {
  const stage = ledger.stages.find((s) => s.id === 'ST-01')!
  const [ab, bc] = stage.segmentIds
  const records: SiteRecord[] = [
    { siteTicket: 'XD-RESUME-1', stageId: 'ST-01', stageVersion: stage.version, segmentId: ab, occupation: '现场改：A-B 段保留 2 条机动车道', at: nowText() },
    { siteTicket: 'XD-RESUME-2', stageId: 'ST-01', stageVersion: stage.version, segmentId: bc, occupation: '现场改：B-C 段改夜间 1 车道', at: nowText() },
  ]
  const summary = store.submit('HX-RESUME', records, 1, '回传链路中断')
  lastOutcomes.value = summary.outcomes
  Message.warning('写入在第 2 条中断，第 1 段已确认。点击「按原单号续传」')
}

function scenarioConcurrent() {
  const stage = ledger.stages.find((s) => s.id === 'ST-01')!
  const seg = stage.segmentIds[0]
  const first: SiteRecord[] = [
    { siteTicket: 'XD-A', stageId: 'ST-01', stageVersion: stage.version, segmentId: seg, occupation: '先到：甲班记录', at: nowText() },
    { siteTicket: 'XD-B', stageId: 'ST-01', stageVersion: stage.version, segmentId: stage.segmentIds[1] ?? seg, occupation: '先到：甲班记录2', at: nowText() },
  ]
  store.submit('HX-RACE', first, 1, '甲班写入中断')
  const later: SiteRecord[] = [
    { siteTicket: 'XD-A', stageId: 'ST-01', stageVersion: stage.version, segmentId: seg, occupation: '后到：乙班想盖回', at: nowText() },
    { siteTicket: 'XD-C', stageId: 'ST-01', stageVersion: stage.version, segmentId: seg, occupation: '后到：乙班新增', at: nowText() },
  ]
  const summary = store.submit('HX-RACE', later)
  lastOutcomes.value = summary.outcomes
  Message.info('两人同交一单：先到生效，后到整体待核')
}

const statusColor: Record<string, string> = {
  执行中: 'green', 待执行: 'gray', 待重算: 'red', 已完成: 'arcoblue',
}
const kindColor: Record<string, string> = { 急救: 'red', 公交: 'orange', 普通: 'gray' }
const condColor: Record<string, string> = { 待处理: 'orange', 已接受: 'green', 已退回: 'red', 失效待重算: 'red' }

function short(p: [number, number]) { return `${p[0].toFixed(3)},${p[1].toFixed(3)}` }
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">阶段执行 · 共用路段 · 绕行条件 · 会签并账</p>
      <h1>施工执行交接账</h1>
      <p>现场记录带阶段版本与现场单号，回传只并同一路段；同段双改保留现场值并登记冲突；路段变化只让经过该段的后续阶段与已接受条件失效重算。</p>
    </div>
    <a-space>
      <a-button @click="scenarioConflict">演示：晚回盖回冲突</a-button>
      <a-button @click="scenarioFailure">演示：写入失败</a-button>
      <a-button @click="scenarioConcurrent">演示：两人同交</a-button>
      <a-button status="danger" @click="store.reset()">重置账本</a-button>
    </a-space>
  </section>

  <!-- 阶段执行时间轴 -->
  <article class="card mb16">
    <div class="panel-head">
      <div><h2>阶段执行（带阶段版本）</h2><p>路段变化后仅「经过该段的后续阶段」转待重算，其余阶段保留</p></div>
      <a-tag color="red">{{ ledger.stages.filter((s) => s.status === '待重算').length }} 个待重算</a-tag>
    </div>
    <div class="stage-row" v-for="stage in ledger.stages" :key="stage.id">
      <div class="stage-main">
        <a-tag :color="statusColor[stage.status]">{{ stage.status }}</a-tag>
        <b>{{ stage.id }} · {{ stage.name }}</b>
        <small>{{ stage.start }} → {{ stage.end }} · v{{ stage.version }}<em v-if="stage.migrated">（旧方案按路线点生成首版）</em></small>
      </div>
      <div class="stage-segs">
        <a-tag v-for="id in stage.segmentIds" :key="id" :class="{ hot: ledger.segments[id]?.detourIds.length }" size="small">{{ id }}</a-tag>
      </div>
      <a-button v-if="stage.status === '待重算'" size="mini" type="primary" @click="store.recompute(stage.id)">重算通过，恢复</a-button>
      <small v-else-if="stage.invalidatedBySegment" class="muted">失效于 {{ stage.invalidatedBySegment }}</small>
    </div>
  </article>

  <div class="handoff-grid">
    <div class="col">
      <!-- 交接单提交 -->
      <article class="card mb16">
        <div class="panel-head"><div><h2>现场回传并账</h2><p>记录携带交接单号 / 现场单号 / 阶段版本</p></div></div>
        <a-form layout="vertical" :model="{ ticketId, siteTicket, occupation }">
          <div class="form-two">
            <a-form-item label="交接单号"><a-input v-model="ticketId" /></a-form-item>
            <a-form-item label="现场单号"><a-input v-model="siteTicket" /></a-form-item>
          </div>
          <div class="form-two">
            <a-form-item label="阶段">
              <a-select v-model="stageId" @change="syncSegment">
                <a-option v-for="s in ledger.stages" :key="s.id" :value="s.id">{{ s.id }} v{{ s.version }}</a-option>
              </a-select>
            </a-form-item>
            <a-form-item label="基于阶段版本">
              <a-input-number v-model="baseVersion" :min="1" :max="999" style="width:100%" />
            </a-form-item>
          </div>
          <a-form-item label="只并这一路段">
            <a-select v-model="segmentId">
              <a-option v-for="seg in stageSegments" :key="seg.id" :value="seg.id">{{ seg.id }}（{{ short(seg.endpoints[0]) }} → {{ short(seg.endpoints[1]) }}）</a-option>
            </a-select>
          </a-form-item>
          <a-form-item label="现场占路范围"><a-textarea v-model="occupation" :auto-size="{ minRows: 2 }" /></a-form-item>
          <a-space>
            <a-checkbox v-model="simulateFail">模拟最后一条写入失败</a-checkbox>
            <a-button type="primary" @click="doSubmit(false)">提交回传</a-button>
            <a-button :disabled="!store.failedTicket" @click="doSubmit(true)">按原单号续传</a-button>
          </a-space>
        </a-form>
        <div v-if="lastOutcomes.length" class="outcomes">
          <div v-for="o in lastOutcomes" :key="o.recordIndex + o.siteTicket" class="outcome" :class="o.result">
            <a-tag size="small" :color="o.result === 'conflict' ? 'red' : o.result === 'applied' ? 'green' : o.result === 'duplicate' || o.result === 'closed_noop' ? 'gray' : 'orange'">{{ o.result }}</a-tag>
            <span>{{ o.siteTicket }} · {{ o.segmentId || '—' }}：{{ o.detail }}</span>
          </div>
        </div>
        <a-alert v-if="store.failedTicket" type="warning" class="mt12"
          :title="`交接单 ${store.failedTicket.id} 传输中：已确认 ${store.failedTicket.confirmedIndices.length}/${store.failedTicket.records.length} 段，失败于第 ${(store.failedTicket.failedAt?.index ?? 0) + 1} 条，续传从已确认路段之后继续`" />
      </article>

      <!-- 冲突核裁 -->
      <article class="card mb16">
        <div class="panel-head"><div><h2>同段双改 · 冲突待核</h2><p>现场值保留为权威值，值班室值留存核裁，不会被晚回静默盖掉</p></div><a-tag color="red">{{ store.openConflicts.length }} 待核</a-tag></div>
        <div v-for="c in ledger.conflicts" :key="c.id" class="conflict-card" :class="{ done: c.status === '已核裁' }">
          <div class="cv">
            <span class="cv-tag site">现场值（生效）</span><b>{{ c.siteValue }}</b>
          </div>
          <div class="cv">
            <span class="cv-tag duty">值班室值（待核）</span><b>{{ c.dutyValue }}</b>
          </div>
          <div class="cf-foot">
            <small>{{ c.segmentId }} · {{ c.stageId }} 基于 v{{ c.stageVersion }} · {{ c.siteTicket }} · {{ c.at.slice(11, 19) }}</small>
            <template v-if="c.status === '待核'">
              <a-button size="mini" @click="store.decideConflict(c.id, '采用值班室值')">采用值班室值</a-button>
              <a-button size="mini" type="primary" @click="store.decideConflict(c.id, '维持现场值')">维持现场值</a-button>
            </template>
            <a-tag v-else color="green">已核裁：{{ c.resolution }}</a-tag>
          </div>
        </div>
        <a-empty v-if="!ledger.conflicts.length" description="暂无冲突" />
      </article>

      <!-- 后到待核 / 无主路段 -->
      <article class="card">
        <div class="panel-head"><div><h2>待核队列</h2><p>先到生效，后到内容不改已确认路段</p></div><a-tag color="orange">{{ store.pendingItems.length }}</a-tag></div>
        <div v-for="p in ledger.pending" :key="p.id" class="pending-row">
          <a-tag size="small" color="orange">{{ p.kind }}</a-tag>
          <div><b>{{ p.siteTicket }}</b><small>{{ p.reason }}</small><small v-if="p.occupation">内容：{{ p.occupation }}</small></div>
        </div>
        <a-empty v-if="!store.pendingItems.length" description="暂无待核内容" />
      </article>
    </div>

    <div class="col">
      <!-- 共用路段 -->
      <article class="card mb16">
        <div class="panel-head"><div><h2>共用路段</h2><p>现场 / 值班室调整都落在同编号路段上</p></div><a-tag>{{ store.sharedSegments.length }} 段被共用</a-tag></div>
        <div v-for="seg in store.sharedSegments" :key="seg.id" class="seg-card">
          <div class="seg-head">
            <b>{{ seg.id }}</b>
            <a-tag size="small" :color="seg.occupiedBy === '现场' ? 'green' : 'arcoblue'">{{ seg.occupiedBy }} v{{ seg.occupiedStageVersion }}</a-tag>
          </div>
          <p class="occ">{{ seg.occupation }}</p>
          <div class="seg-refs">
            <span v-for="id in seg.stageIds" :key="'s' + id" class="ref stage">阶段 {{ id }}</span>
            <span v-for="id in seg.detourIds" :key="'d' + id" class="ref detour">绕行 {{ id }}</span>
          </div>
          <div class="seg-duty">
            <a-input size="small" :placeholder="'值班室直接调 ' + seg.id" @press-enter="(e: any) => { store.dutyAdjust(seg.stageIds[0], seg.id, e.target.value); e.target.value = ''; Message.success('值班室已调整，阶段版本 +1 并级联失效') }" />
          </div>
        </div>
      </article>

      <!-- 绕行条件 -->
      <article class="card mb16">
        <div class="panel-head"><div><h2>公交 / 急救绕行</h2><p>所经路段变化即标记重算，其他绕行保留</p></div></div>
        <div v-for="d in ledger.detours" :key="d.id" class="detour-row" :class="{ bad: d.needsRecompute }">
          <a-tag size="small" :color="kindColor[d.kind]">{{ d.kind }}</a-tag>
          <div class="grow"><b>{{ d.name }}</b><small>{{ d.distance }} km · +{{ d.extraMinutes }} 分钟 · {{ d.segmentIds.length }} 个路段</small></div>
          <a-tag v-if="d.needsRecompute" color="red">因 {{ d.invalidatedBySegment }} 失效待重算</a-tag>
          <a-button v-if="d.needsRecompute" size="mini" type="primary" @click="store.fixDetour(d.id)">绕行重算</a-button>
          <a-tag v-else color="green">可用</a-tag>
        </div>
        <a-divider style="margin:10px 0" />
        <div v-for="c in ledger.conditions" :key="c.id" class="cond-row">
          <a-tag size="small" :color="condColor[c.status]">{{ c.status }}</a-tag>
          <div class="grow">
            <b>{{ c.unit }} · {{ c.author }} 的条件（锚定 {{ c.stageId }}）</b>
            <small>原时间 {{ c.createdAt }} 保留：{{ c.condition }}</small>
          </div>
          <template v-if="c.status === '失效待重算'">
            <a-button size="mini" status="danger" @click="store.reverify(c.id, false)">重算退回</a-button>
            <a-button size="mini" type="primary" @click="store.reverify(c.id, true)">重算通过</a-button>
          </template>
        </div>
      </article>

      <!-- 审计交接账 -->
      <article class="card">
        <div class="panel-head"><div><h2>交接流水账</h2><p>所有并账、冲突、失效、续传动作留痕，可续作</p></div><a-tag>修订 #{{ ledger.revision }}</a-tag></div>
        <div class="audit-list">
          <div v-for="(a, i) in ledger.audit.slice(0, 14)" :key="i" class="audit-row">
            <a-tag size="small">{{ a.action }}</a-tag><span>{{ a.detail }}</span><small>{{ a.at.slice(11, 19) }}</small>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.handoff-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.col{min-width:0}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.panel-head h2{font-size:16px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}
.mb16{margin-bottom:16px}.mt12{margin-top:12px}.muted{color:#94a3b8}
.form-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stage-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid #eef1f5;flex-wrap:wrap}
.stage-main{display:flex;align-items:center;gap:8px;min-width:260px}.stage-main small{color:#7a8798}.stage-main em{color:#94a3b8;font-style:normal}
.stage-segs{display:flex;gap:5px;flex-wrap:wrap;flex:1}.stage-segs .hot{background:#fff1f2;color:#e11d48;border-color:#fecdd3}
.outcomes{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.outcome{display:flex;gap:8px;align-items:center;font-size:13px;padding:6px 8px;border-radius:6px;background:#f7f9fc}
.outcome.conflict{background:#fff1f2}.outcome.applied{background:#f0fdf4}.outcome.written_pending,.outcome.segment_not_found,.outcome.stage_version_stale{background:#fff7ed}
.conflict-card{border:1px solid #fecdd3;background:#fff8f9;border-radius:8px;padding:11px;margin-bottom:10px}
.conflict-card.done{opacity:.62}.cv{display:flex;align-items:center;gap:8px;margin-bottom:6px}.cv b{font-size:13px;font-weight:600}
.cv-tag{font-size:11px;padding:1px 7px;border-radius:5px}.cv-tag.site{background:#dcfce7;color:#15803d}.cv-tag.duty{background:#fee2e2;color:#b91c1c}
.cf-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}.cf-foot small{color:#94a3b8;margin-right:auto}
.pending-row{display:flex;gap:10px;padding:9px;border:1px solid #fde8c8;background:#fffbf3;border-radius:7px;margin-bottom:8px}
.pending-row b,.pending-row small{display:block}.pending-row small{color:#8a94a6;margin-top:2px}
.seg-card{border:1px solid #e7ebf1;border-radius:8px;padding:11px;margin-bottom:10px}
.seg-head{display:flex;justify-content:space-between;align-items:center}.occ{margin:7px 0;color:#334155;font-size:13px}
.seg-refs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.ref{font-size:11px;padding:1px 7px;border-radius:5px}.ref.stage{background:#eef4ff;color:#2563eb}.ref.detour{background:#fff1f2;color:#e11d48}
.detour-row,.cond-row{display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid #eef1f5;flex-wrap:wrap}
.detour-row.bad{background:#fff5f5;border-radius:6px;padding-left:8px}.grow{flex:1;min-width:200px}.grow b,.grow small{display:block}.grow small{color:#7a8798;margin-top:3px;font-size:12px}
.audit-list{max-height:330px;overflow:auto}.audit-row{display:flex;gap:8px;align-items:baseline;padding:6px 0;border-bottom:1px dashed #edf0f5;font-size:12.5px}
.audit-row span{flex:1;color:#475569}.audit-row small{color:#a0aab8;white-space:nowrap}
@media(max-width:1080px){.handoff-grid{grid-template-columns:1fr}}
</style>
