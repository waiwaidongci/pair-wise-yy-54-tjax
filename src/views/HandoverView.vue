<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useMutation } from '@vue/apollo-composable'
import { HANDOVER_MUTATION } from '../graphql'
import { useSchemeStore } from '../store/scheme'
import type { HandoverResult } from '../store/scheme'
import type { SectionValue } from '../types'

const store = useSchemeStore()
const { mutate } = useMutation(HANDOVER_MUTATION)

const formStageId = ref(store.scheme.stages[0]?.id ?? '')
const party = ref<'site' | 'duty'>('site')
const forceFail = ref(false)
const values = reactive<Record<string, string>>({})
const lastResult = ref<HandoverResult | null>(null)
const resumeId = ref<string | null>(null)

const formStage = computed(() => store.scheme.stages.find((item) => item.id === formStageId.value))
const formSections = computed(() => store.sectionsForStage(formStageId.value))

function resetValues() {
  for (const key of Object.keys(values)) delete values[key]
  for (const section of formSections.value) values[section.id] = formStage.value?.lanes ?? ''
}
watch(formStageId, resetValues, { immediate: true })

const pendingCount = computed(() => store.scheme.pendingItems.length)
const recalcStages = computed(() => store.scheme.stages.filter((item) => item.recalc))
const recalcComments = computed(() => store.scheme.comments.filter((item) => item.recalc))
const activeHandovers = computed(() => store.scheme.handovers.filter((item) => item.status === '进行中').length)

function buildChanges(): SectionValue[] {
  return formSections.value
    .filter((section) => values[section.id] !== undefined && values[section.id] !== '')
    .map((section) => ({ sectionId: section.id, value: values[section.id] }))
}

function submit() {
  const result = store.submitHandover({
    stageId: formStageId.value,
    party: party.value,
    changes: buildChanges(),
    forceFail: forceFail.value,
  })
  lastResult.value = result
  resumeId.value = result.outcome === '写入失败' ? result.record.id : null
  void mutate({ input: { handoverId: result.handover.id, recordId: result.record.id, stageId: formStageId.value, party: party.value, changes: buildChanges() } })
}

function resume() {
  if (!resumeId.value) return
  const result = store.submitHandover({
    stageId: formStageId.value,
    party: party.value,
    changes: buildChanges(),
    recordId: resumeId.value,
  })
  lastResult.value = result
  resumeId.value = result.outcome === '写入失败' ? result.record.id : null
  void mutate({ input: { handoverId: result.handover.id, recordId: result.record.id, stageId: formStageId.value, party: party.value, changes: buildChanges() } })
}

// 两人同时提交同一交接：先到生效，后到内容待核
async function submitBoth() {
  const stageId = formStageId.value
  const changes = buildChanges()
  const [siteResult, dutyResult] = await Promise.all([
    Promise.resolve(store.submitHandover({ stageId, party: 'site', changes })),
    new Promise<HandoverResult>((resolve) => setTimeout(() => resolve(store.submitHandover({ stageId, party: 'duty', changes })), 40)),
  ])
  lastResult.value = siteResult.outcome === '已生效' ? siteResult : dutyResult
  resumeId.value = null
  void mutate({ input: { handoverId: siteResult.handover.id, recordId: siteResult.record.id, stageId, party: 'site', changes } })
  void mutate({ input: { handoverId: dutyResult.handover.id, recordId: dutyResult.record.id, stageId, party: 'duty', changes } })
}

function stageName(id: string) { return store.scheme.stages.find((item) => item.id === id)?.name ?? id }
function sectionIdsOf(stageId: string) { return store.sectionsForStage(stageId).map((item) => item.id).join('、') }
function recordOf(id?: string) { return store.scheme.siteRecords.find((item) => item.id === id) }
</script>

<template>
  <section class="page-head compact">
    <div><p class="eyebrow">阶段执行 · 共用路段 · 绕行条件 · 会签</p><h1>阶段执行交接账</h1><p>现场回传带阶段版本与现场单号；只合并同一路段，两边都改同一段时保留现场值与冲突；路段一变，仅后续共用阶段与已接受条件失效重算。</p></div>
    <a-space><a-button @click="submitBoth">两人同时提交</a-button><a-button type="primary" @click="submit">提交交接</a-button></a-space>
  </section>

  <div class="metrics">
    <article class="card metric"><span>共用路段</span><strong>{{ store.scheme.sections.length }}</strong><small>按路线点生成首版</small></article>
    <article class="card metric"><span>进行中交接</span><strong>{{ activeHandovers }}</strong><small>先到生效</small></article>
    <article class="card metric"><span>待核内容</span><strong>{{ pendingCount }}</strong><small>后到交接待核</small></article>
    <article class="card metric"><span>失效重算阶段</span><strong>{{ recalcStages.length }}</strong><small>其他阶段保留</small></article>
  </div>

  <div class="hb-grid">
    <div class="col">
      <article class="card">
        <div class="panel-head"><div><h2>发起交接</h2><p>选择阶段与方别，按路段填改占值</p></div></div>
        <a-form layout="vertical" :model="values">
          <div class="two">
            <a-form-item label="阶段"><a-select v-model="formStageId" style="width:100%"><a-option v-for="stage in store.scheme.stages" :key="stage.id" :value="stage.id">{{ stage.id }} · {{ stage.name }}</a-option></a-select></a-form-item>
            <a-form-item label="方别"><a-radio-group v-model="party" type="button"><a-radio value="site">现场</a-radio><a-radio value="duty">值班室</a-radio></a-radio-group></a-form-item>
          </div>
          <a-form-item v-for="section in formSections" :key="section.id" :label="`${section.id} · 共用 ${section.stageIds.join(' / ')}`">
            <a-input v-model="values[section.id]" :placeholder="`路段 ${section.id} 改占值`" />
          </a-form-item>
          <a-form-item><a-checkbox v-model="forceFail">模拟写入失败（验证按原单号续作）</a-checkbox></a-form-item>
          <a-space>
            <a-button type="primary" @click="submit">提交交接</a-button>
            <a-button v-if="resumeId" status="warning" @click="resume">按原单号 {{ resumeId }} 续作</a-button>
          </a-space>
        </a-form>
        <a-alert v-if="lastResult" class="result" :type="lastResult.outcome === '写入失败' ? 'warning' : lastResult.outcome === '待核' ? 'info' : 'success'">
          <template #title>
            {{ lastResult.handover.id }} · 现场单号 {{ lastResult.record.id }} · 阶段版本 v{{ lastResult.record.stageVersion }} · {{ lastResult.outcome }}
            <span v-if="lastResult.failedSectionId"> · 中断于 {{ lastResult.failedSectionId }}，已确认 {{ lastResult.confirmedCount }} 个路段</span>
          </template>
        </a-alert>
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>交接记录</h2><p>先到生效，后到内容待核；重复提交不重复关闭</p></div></div>
        <div v-for="handover in store.scheme.handovers" :key="handover.id" class="handover">
          <div class="handover-head">
            <b>{{ handover.id }}</b>
            <a-tag :color="handover.status === '已交接' ? 'green' : handover.status === '待核' ? 'orange' : 'blue'">{{ handover.status }}</a-tag>
            <span>{{ stageName(handover.stageId) }}</span>
          </div>
          <div class="records">
            <div v-if="recordOf(handover.siteRecordId)" class="record">
              <b>现场</b><span>{{ recordOf(handover.siteRecordId)!.id }}</span><small>阶段 v{{ recordOf(handover.siteRecordId)!.stageVersion }}</small>
              <a-tag :color="recordOf(handover.siteRecordId)!.status === '已确认' ? 'green' : 'orange'">{{ recordOf(handover.siteRecordId)!.status }}</a-tag>
              <small>已确认 {{ recordOf(handover.siteRecordId)!.confirmedSectionIds.length }} 段</small>
            </div>
            <div v-if="recordOf(handover.dutyRecordId)" class="record">
              <b>值班室</b><span>{{ recordOf(handover.dutyRecordId)!.id }}</span><small>阶段 v{{ recordOf(handover.dutyRecordId)!.stageVersion }}</small>
              <a-tag :color="recordOf(handover.dutyRecordId)!.status === '已确认' ? 'green' : 'orange'">{{ recordOf(handover.dutyRecordId)!.status }}</a-tag>
              <small>已确认 {{ recordOf(handover.dutyRecordId)!.confirmedSectionIds.length }} 段</small>
            </div>
          </div>
          <div v-if="handover.conflicts.length" class="conflicts">
            <div v-for="conflict in handover.conflicts" :key="conflict.sectionId" class="conflict">
              <b>{{ conflict.sectionId }}</b><a-tag color="red">冲突 · {{ conflict.resolution }}</a-tag>
              <p>现场值：{{ conflict.siteValue }}</p><p>值班室值：{{ conflict.dutyValue }}</p>
            </div>
          </div>
          <div v-if="handover.closedAt" class="handover-foot"><small>关闭于 {{ handover.closedAt }}</small></div>
        </div>
        <a-empty v-if="store.scheme.handovers.length === 0" description="暂无交接记录" />
      </article>
    </div>

    <div class="col">
      <article class="card">
        <div class="panel-head"><div><h2>共用路段台账</h2><p>缺编号旧方案按路线点生成首版，原时间与意见保留</p></div><a-tag color="blue">{{ store.scheme.sections.length }} 段</a-tag></div>
        <div v-for="section in store.scheme.sections" :key="section.id" class="section">
          <div><b>{{ section.id }}</b><a-tag :color="section.source === 'legacy' ? 'gray' : 'green'">{{ section.source === 'legacy' ? '首版' : '交接版' }} v{{ section.version }}</a-tag></div>
          <small>经过阶段：{{ section.stageIds.join('、') }}</small>
          <small class="pts">{{ section.points[0].join(', ') }} → {{ section.points[1].join(', ') }}</small>
        </div>
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>待核内容</h2><p>后到交接不覆盖，登记待核</p></div></div>
        <div v-for="item in store.scheme.pendingItems" :key="item.id" class="pending">
          <div><b>{{ item.recordId }}</b><a-tag color="orange">{{ item.party === 'site' ? '现场' : '值班室' }} · 待核</a-tag></div>
          <small>{{ item.reason }}</small>
          <p v-for="change in item.changes" :key="change.sectionId">{{ change.sectionId }}：{{ change.value }}</p>
        </div>
        <a-empty v-if="store.scheme.pendingItems.length === 0" description="暂无待核内容" />
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>失效重算</h2><p>仅后续共用阶段与已接受条件失效，其他阶段保留</p></div></div>
        <div v-for="stage in recalcStages" :key="stage.id" class="recalc">
          <b>{{ stage.id }}</b><a-tag color="orange">失效重算</a-tag><small>{{ stage.recalcReason }}</small>
        </div>
        <div v-for="comment in recalcComments" :key="comment.id" class="recalc">
          <b>{{ comment.id }}</b><a-tag color="orange">条件失效</a-tag><small>{{ comment.unit }} · 已接受条件需重算</small>
        </div>
        <a-empty v-if="recalcStages.length === 0 && recalcComments.length === 0" description="暂无失效重算项" />
      </article>
    </div>
  </div>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}
.hb-grid{display:grid;grid-template-columns:1.35fr .9fr;gap:16px;align-items:start}.col{display:grid;gap:16px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.result{margin-top:12px}
.handover{border:1px solid #e7ebf1;border-radius:7px;padding:12px;margin-bottom:10px}.handover-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}.handover-head span{color:#7a8798;font-size:12px}
.records{display:grid;gap:6px;margin-bottom:8px}.record{display:flex;align-items:center;gap:8px;font-size:13px}.record b{color:#2563eb}.record small{color:#7a8798}
.conflicts{display:grid;gap:6px}.conflict{background:#fff1f2;border-left:3px solid #e11d48;border-radius:6px;padding:8px}.conflict p{margin:2px 0 0;font-size:12px;color:#475569}
.handover-foot{margin-top:8px;color:#7a8798}
.section{padding:10px 0;border-bottom:1px solid #edf0f5}.section>div{display:flex;align-items:center;gap:8px}.section small{display:block;color:#7a8798;margin-top:3px}.section .pts{font-family:monospace;font-size:11px}
.pending{background:#fff7ed;border-left:3px solid #f59e0b;border-radius:6px;padding:10px;margin-bottom:8px}.pending>div{display:flex;align-items:center;gap:8px}.pending small{color:#7a8798}.pending p{margin:4px 0 0;font-size:12px;color:#475569}
.recalc{background:#fff7ed;border-left:3px solid #f59e0b;border-radius:6px;padding:10px;margin-bottom:8px}.recalc b{margin-right:8px}.recalc small{color:#7a8798}
@media(max-width:1050px){.hb-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}
</style>
