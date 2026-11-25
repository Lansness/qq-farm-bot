<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NModal } from 'naive-ui/es/modal'
import { NSwitch } from 'naive-ui/es/switch'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useAccountStore } from '@/stores/account'
import Api from '@/api'

const emit = defineEmits<{ back: [] }>()
const { currentAccountId } = storeToRefs(useAccountStore())

const detail = ref<any>(null)
const loading = ref(false)
const claiming = ref(false)
const savingAuto = ref(false)
const message = ref('')
const messageKind = ref<'ok' | 'error'>('ok')
const rulesOpen = ref(false)

const period = computed(() => {
  const d = detail.value
  if (!d?.startTime || !d?.endTime)
    return null
  const format = (ms: number) => new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  const day = (ms: number) => {
    const date = new Date(ms)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((day(d.endTime) - day(d.serverTime || Date.now())) / 86_400_000)
  const badge = days < 0 ? '已结束' : days === 0 ? '今天结束' : `还剩 ${days} 天`
  return { text: `${format(d.startTime)} – ${format(d.endTime)}`, badge, ended: days < 0 }
})

const autoClaim = computed({
  get: () => detail.value?.autoClaim !== false,
  set: (value: boolean) => {
    void saveAutoClaim(value)
  },
})

function accountId() {
  return String(currentAccountId.value || '')
}

/** 服务端可能返回秒级时间戳，统一换算成毫秒再参与界面计算。 */
function normalizeDetail(raw: any) {
  const fix = (value: any) => {
    const number = Number(value) || 0
    return number > 0 && number < 1e12 ? number * 1000 : number
  }
  return {
    ...raw,
    startTime: fix(raw?.startTime),
    endTime: fix(raw?.endTime),
    serverTime: fix(raw?.serverTime) || Date.now(),
  }
}

function notice(text: string, kind: 'ok' | 'error' = 'ok') {
  message.value = text
  messageKind.value = kind
}

async function loadAutoClaim() {
  try {
    const response = await Api.get('/api/settings', {
      headers: { 'x-account-id': accountId() },
      skipErrorToast: true,
    } as any)
    const automation = response.data?.data?.automation || {}
    if (detail.value)
      detail.value = { ...detail.value, autoClaim: automation.potato_claim !== false }
  }
  catch {
    if (detail.value)
      detail.value = { ...detail.value, autoClaim: true }
  }
}

async function load() {
  if (!accountId())
    return
  loading.value = true
  message.value = ''
  try {
    const response = await Api.get('/api/activity-center/sweet-potato', {
      headers: { 'x-account-id': accountId() },
      skipErrorToast: true,
    } as any)
    const payload = response.data?.data ?? response.data
    detail.value = normalizeDetail(payload)
    if (detail.value?.autoClaim === undefined)
      await loadAutoClaim()
  }
  catch (error: any) {
    notice(String(error?.response?.data?.error || error?.message || '加载活动数据失败'), 'error')
  }
  finally {
    loading.value = false
  }
}

async function claim() {
  if (!accountId() || claiming.value)
    return
  claiming.value = true
  try {
    const response = await Api.post('/api/activity-center/sweet-potato/seeds/claim', {}, {
      headers: { 'x-account-id': accountId() },
      skipErrorToast: true,
    } as any)
    const payload = response.data?.data ?? response.data
    notice(payload?.alreadyClaimed ? '今日红薯种子已经领取过了' : '红薯种子领取成功')
    await load()
  }
  catch (error: any) {
    notice(String(error?.response?.data?.error || error?.message || '领取失败'), 'error')
  }
  finally {
    claiming.value = false
  }
}

async function saveAutoClaim(enabled: boolean) {
  if (!accountId() || savingAuto.value)
    return
  savingAuto.value = true
  try {
    try {
      await Api.post('/api/activity-center/sweet-potato/auto-claim', { enabled }, {
        headers: { 'x-account-id': accountId() },
        skipErrorToast: true,
      } as any)
    }
    catch (error: any) {
      // 兼容尚未部署专用接口的旧后端：直接写账号自动化配置。
      if (error?.response?.status === 404) {
        await Api.post('/api/automation', { potato_claim: enabled }, {
          headers: { 'x-account-id': accountId() },
          skipErrorToast: true,
        } as any)
      }
      else {
        throw error
      }
    }
    if (detail.value)
      detail.value = { ...detail.value, autoClaim: enabled }
    notice(enabled ? '已开启每日自动领取' : '已关闭每日自动领取')
  }
  catch (error: any) {
    notice(String(error?.response?.data?.error || error?.message || '保存开关失败'), 'error')
    if (detail.value)
      detail.value = { ...detail.value, autoClaim: !enabled }
  }
  finally {
    savingAuto.value = false
  }
}

const sharing = ref(false)

async function shareBoost() {
  if (!accountId() || sharing.value)
    return
  sharing.value = true
  try {
    await Api.post('/api/activity-center/sweet-potato/share-boost', {}, {
      headers: { 'x-account-id': accountId() },
      skipErrorToast: true,
    } as any)
    notice('分享加倍已触发')
    await load()
  }
  catch (error: any) {
    notice(String(error?.response?.data?.error || error?.message || '分享加倍失败'), 'error')
  }
  finally {
    sharing.value = false
  }
}

const exchanging = ref(0)

async function exchange(goods: any) {
  if (!accountId() || exchanging.value)
    return
  exchanging.value = goods.goodsId
  try {
    const response = await Api.post('/api/activity-center/sweet-potato/exchange', { goodsId: goods.goodsId, count: 1 }, {
      headers: { 'x-account-id': accountId() },
      skipErrorToast: true,
    } as any)
    const payload = response.data?.data ?? response.data
    notice(`兑换成功：${payload?.goods?.name || goods.name}`)
    await load()
  }
  catch (error: any) {
    notice(String(error?.response?.data?.error || error?.message || '兑换失败'), 'error')
  }
  finally {
    exchanging.value = 0
  }
}

onMounted(load)
</script>

<template>
  <section class="potato">
    <header class="potato-head">
      <div class="potato-head__lead">
        <NButton quaternary circle title="返回活动列表" aria-label="返回活动列表" @click="emit('back')">
          <template #icon>
            <span class="i-carbon-arrow-left" />
          </template>
        </NButton>
        <span class="potato-head__icon i-carbon-sprout" aria-hidden="true" />
        <div class="potato-head__text">
          <h1>{{ detail?.title || '以薯换福' }}</h1>
          <p v-if="period">
            <span class="i-carbon-calendar" aria-hidden="true" />{{ period.text }}
            <span class="potato-badge" :class="{ 'is-ended': period.ended }">{{ period.badge }}</span>
          </p>
        </div>
      </div>
      <div class="potato-head__actions">
        <NButton quaternary :disabled="!detail" title="活动说明" aria-label="活动说明" @click="rulesOpen = true">
          <template #icon>
            <span class="i-carbon-information" />
          </template>
          <span class="potato-head__rules">活动说明</span>
        </NButton>
        <NButton quaternary circle :loading="loading" title="刷新" aria-label="刷新" @click="load">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </header>

    <p v-if="message" class="potato-message" :class="{ 'is-error': messageKind === 'error' }" role="status">
      <span :class="messageKind === 'error' ? 'i-carbon-warning-alt' : 'i-carbon-checkmark'" aria-hidden="true" />{{ message }}
    </p>

    <div v-if="!currentAccountId" class="potato-empty">
      <span class="i-carbon-user-avatar" aria-hidden="true" />
      <strong>请先选择账号</strong>
      <p>活动数据按当前账号读取</p>
    </div>

    <div v-else-if="loading && !detail" class="potato-empty">
      <span class="i-svg-spinners-90-ring-with-bg" aria-hidden="true" />
      <strong>正在读取活动进度</strong>
    </div>

    <template v-else-if="detail">
      <div class="potato-grid">
        <section class="potato-card potato-stat">
          <span class="potato-stat__label">今日售价</span>
          <strong class="potato-stat__value">{{ detail.basePrice != null ? detail.price : '—' }}<small>福气币 / 份</small></strong>
          <span class="potato-stat__hint">基础 {{ detail.basePrice ?? "—" }} + 分享加成 {{ detail.shareBonus ?? 0 }}</span>
        </section>
        <section class="potato-card potato-stat">
          <span class="potato-stat__label">蜜薯</span>
          <strong class="potato-stat__value">{{ detail.melons ?? '—' }}</strong>
          <span class="potato-stat__hint">持有数量，24:00 自动按当日价结算</span>
        </section>
        <section class="potato-card potato-stat">
          <span class="potato-stat__label">今日已售</span>
          <strong class="potato-stat__value">{{ detail.soldToday ?? '—' }}</strong>
          <span class="potato-stat__hint">今日已卖出的蜜薯数量</span>
        </section>
        <section class="potato-card potato-stat">
          <span class="potato-stat__label">福气币</span>
          <strong class="potato-stat__value">{{ detail.coins ?? '—' }}</strong>
          <span class="potato-stat__hint">售卖蜜薯获得，用于兑换活动奖励</span>
        </section>
      </div>

      <section class="potato-card potato-rules">
        <h2>玩法说明</h2>
        <ol>
          <li>每天首次进入活动可获得<strong>红薯种子</strong>，种子种入普通农田。</li>
          <li>成熟后收获红薯，并额外获得<strong>蜜薯</strong>。</li>
          <li>蜜薯卖给自己铺子按今日售价结算福气币，也可卖到好友铺子。</li>
          <li>每日 24:00 系统按当日最终收购价自动结算全部蜜薯。</li>
        </ol>
      </section>

      <section class="potato-card potato-shop">
        <header class="potato-shop__head">
          <h2>福气商店</h2>
          <span>用福气币兑换，限购次数与游戏内一致</span>
        </header>
        <div class="potato-shop__grid">
          <article v-for="goods in detail.shop || []" :key="goods.goodsId" class="potato-shop__item">
            <img v-if="goods.image" :src="goods.image" alt="" width="44" height="44" class="potato-shop__img">
            <span v-else class="potato-shop__icon i-carbon-gift" aria-hidden="true" />
            <div class="potato-shop__text">
              <strong>{{ goods.name }}</strong>
              <span>{{ goods.price.toLocaleString('zh-CN') }} 福气币 · 限 {{ goods.limit }} 次</span>
            </div>
            <NButton size="small" secondary :loading="exchanging === goods.goodsId" @click="exchange(goods)">
              兑换
            </NButton>
          </article>
        </div>
      </section>

      <section class="potato-card potato-actions">
        <div class="potato-actions__text">
          <strong>每日自动领取</strong>
          <p>开启后账号每天登录或跨过 0 点会自动领取红薯种子，活动结束后开关随页面一起消失。</p>
        </div>
        <NSwitch v-model:value="autoClaim" :loading="savingAuto" :disabled="!detail" />
        <NButton type="primary" size="large" :loading="claiming" :disabled="period?.ended" @click="claim">
          领取今日红薯种子
        </NButton>
        <NButton size="large" secondary :loading="sharing" :disabled="period?.ended" @click="shareBoost">
          分享加倍
        </NButton>
      </section>
    </template>

    <NModal :show="rulesOpen" preset="card" title="以薯换福 · 活动说明" class="potato-rules-modal" @update:show="rulesOpen = $event">
      <ol class="potato-modal-list">
        <li>活动期间在农场主界面进入「以薯换福」，当天首次进入可领取红薯种子。</li>
        <li>红薯种子种入普通农田，成熟后收获红薯，并额外收获蜜薯。</li>
        <li>蜜薯可卖给自己铺子（按本人当日收购价，不限量），也可通过好友分享的卡片卖到好友铺子。</li>
        <li>每日首次把铺子分享给好友或群聊会触发一次分享暴击，暴击涨价每日 0 点清零。</li>
        <li>每日 24:00 系统按本人铺子当日最终收购价自动售出全部蜜薯，福气币入账。</li>
      </ol>
      <template #footer>
        <div class="potato-modal-footer">
          <NButton @click="rulesOpen = false">
            关闭
          </NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>

<style scoped>
.potato {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}
.potato h1,
.potato h2,
.potato p,
.potato ol {
  margin: 0;
}
.potato-head {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}
.potato-head__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}
.potato-head__icon {
  flex: none;
  font-size: 28px;
  color: var(--ui-primary);
}
.potato-head h1 {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700, 700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.potato-head p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  color: var(--ui-muted);
  font-size: 13px;
}
.potato-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
  font-size: 12px;
}
.potato-badge.is-ended {
  background: var(--ui-surface-strong);
  color: var(--ui-muted);
}
.potato-head__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.potato-head__rules {
  margin-left: 4px;
}
.potato-message {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-radius: var(--ui-radius-card, 12px);
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
  font-size: 13px;
}
.potato-message.is-error {
  background: var(--ui-surface-strong);
  color: var(--ui-danger, #d03050);
}
.potato-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 48px 16px;
  color: var(--ui-muted);
  text-align: center;
}
.potato-empty strong {
  color: var(--ui-ink);
}
.potato-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.potato-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card, 14px);
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm);
}
.potato-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px;
}
.potato-stat__label {
  color: var(--ui-muted);
  font-size: 13px;
}
.potato-stat__value {
  color: var(--ui-ink);
  font-size: 30px;
  font-weight: var(--fw-700, 700);
  line-height: 1.15;
}
.potato-stat__value small {
  margin-left: 6px;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: 400;
}
.potato-stat__hint {
  color: var(--ui-muted);
  font-size: 12px;
}
.potato-rules {
  padding: 18px;
}
.potato-rules h2 {
  margin-bottom: 10px;
  color: var(--ui-ink);
  font-size: 16px;
}
.potato-rules ol,
.potato-modal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 20px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.7;
}
.potato-rules strong {
  color: var(--ui-ink);
}
.potato-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px;
}
.potato-actions__text {
  flex: 1;
  min-width: 0;
}
.potato-actions__text strong {
  color: var(--ui-ink);
  font-size: 14px;
}
.potato-actions__text p {
  margin-top: 4px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}
.potato-modal-footer {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 640px) {
  .potato-grid {
    grid-template-columns: 1fr;
  }
  .potato-actions {
    flex-wrap: wrap;
  }
  .potato-actions__text {
    flex-basis: 100%;
  }
}
.potato-shop {
  padding: 18px;
}
.potato-shop__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.potato-shop__head h2 {
  color: var(--ui-ink);
  font-size: 16px;
}
.potato-shop__head span {
  color: var(--ui-muted);
  font-size: 12px;
}
.potato-shop__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.potato-shop__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
}
.potato-shop__img {
  flex: none;
  object-fit: contain;
}
.potato-shop__icon {
  flex: none;
  font-size: 32px;
  color: var(--ui-muted);
}
.potato-shop__text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.potato-shop__text strong {
  color: var(--ui-ink);
  font-size: 13px;
}
.potato-shop__text span {
  color: var(--ui-muted);
  font-size: 11px;
}
</style>
