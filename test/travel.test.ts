/**
 * 派猫猫旅行（成长中心）状态机测试。
 *
 * 重点覆盖那些**曾经写错**的语义：
 *  - buddy_id 归零 ≠ 没有 Buddy（那是「刚领完、该再派了」）
 *  - 能否再派由 daily_limit_reached 决定，不由「一天一次」决定
 *  - 领取成功后要能继续派，形成循环
 *  - 时间窗只挡派遣，领取永不挡
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  WorkBuddyTravelService,
  createTravelState,
  rollTravelStateToToday,
  withinWindow,
  msUntilWindowOpens,
  backoffMs,
  CLAIM_GRACE_MS,
  REDISPATCH_DELAY_MS,
  BACKOFF_LADDER_MS,
  MAX_CLAIM_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES,
  DEFAULT_TRAVEL_WINDOW,
  type TravelWindow,
} from '../src/travel.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyTravelStatus } from '../src/upstream.ts'

interface Recorder { departs: number[]; claims: number[] }

function statusOf(over: Partial<WorkBuddyTravelStatus> = {}): WorkBuddyTravelStatus {
  return {
    state: 'idle',
    buddyId: 0,
    recordId: 0,
    locationName: '',
    departAt: 0,
    arriveAt: 0,
    dailyLimitReached: false,
    serverNow: 1_000,
    durationHours: 0,
    rewardCredit: 0,
    ...over,
  }
}

function makeService(options: {
  status: WorkBuddyTravelStatus
  depart?: unknown
  claim?: unknown
  recorder: Recorder
  window?: TravelWindow
}) {
  const rec = options.recorder
  const client = {
    fetchTravelStatus: async () => options.status,
    fetchTravelConfig: async () => ({
      enabled: true,
      locations: [
        { id: 1, code: 'coffee', name: '咖啡馆' },
        { id: 4, code: 'ancient_town', name: '古镇客栈' },
      ],
    }),
    departTravel: async (_c: unknown, locationId: number) => {
      rec.departs.push(locationId)
      return options.depart ?? { ok: true, state: 'traveling' }
    },
    claimTravel: async (_c: unknown, recordId: number) => {
      rec.claims.push(recordId)
      return options.claim ?? { ok: true, rewardCredit: 7 }
    },
  }
  return new WorkBuddyTravelService(
    { resolve: async () => ({}) },
    client as never,
    options.window ?? DEFAULT_TRAVEL_WINDOW,
  )
}

function fresh(): Recorder { return { departs: [], claims: [] } }
const TODAY = '2026-09-26'

// ---------- 核心语义：循环 ----------

test('idle + 未达上限 → 派遣（buddy_id=0 也要派，这是曾被写反的地方）', async () => {
  const rec = fresh()
  // 关键：buddy_id 为 0，但服务端允许派
  const svc = makeService({ status: statusOf({ state: 'idle', buddyId: 0, dailyLimitReached: false }), recorder: rec })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 1, 'buddy_id=0 不应阻止派遣')
  assert.equal(out.acted, true)
  assert.equal(entry.departed, true)
  assert.ok([1, 4].includes(rec.departs[0] as number), '选点应在 config 给出的地点中')
})

test('领取成功后 60 秒重查，能再次派遣（形成循环）', async () => {
  const rec = fresh()
  const entry = createTravelState(TODAY)
  // 第一步：已到点 → 领取成功
  const svc1 = makeService({
    status: statusOf({ state: 'arrived', recordId: 42, locationName: '古镇客栈', rewardCredit: 9 }),
    recorder: rec,
  })
  const t1 = await svc1.tick(entry)
  assert.equal(rec.claims.length, 1)
  assert.equal(t1.done, false, '领取后不应收工，要继续循环')
  assert.ok(t1.nextWakeAtMs !== undefined)
  const gap = (t1.nextWakeAtMs as number) - Date.now()
  assert.ok(gap > 0 && gap <= REDISPATCH_DELAY_MS + 2000, `应约 ${REDISPATCH_DELAY_MS}ms 后重查，实际 ${gap}`)

  // 第二步：60 秒后服务端已回落 daily_limit → 再次派遣
  rec.departs.length = 0
  const svc2 = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: false }), recorder: rec })
  const t2 = await svc2.tick(entry)
  assert.equal(rec.departs.length, 1, '领取后应能再次派遣')
  assert.equal(t2.acted, true)
})

test('idle + 已达每日上限 → 不派，今日收工', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: true }), recorder: rec })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 0)
  assert.equal(out.done, true)
  assert.equal(entry.doneReason, 'daily-limit')
})

test('depart 被拒 no active buddy → 服务端权威判定，标记无 Buddy', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'idle' }),
    depart: { ok: false, already: false, dailyLimitReached: false, noBuddy: true, message: 'no active buddy', code: 400 },
    recorder: rec,
  })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 1, '仍应尝试一次，由服务端告知结果')
  assert.equal(out.done, true)
  assert.equal(entry.doneReason, 'no-buddy')
})

test('traveling 未到点 → 零写调用，睡到落地点', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 77, locationName: '咖啡馆', arriveAt: 5000, serverNow: 1000, dailyLimitReached: true }),
    recorder: rec,
  })
  const entry = createTravelState(TODAY)
  const before = Date.now()
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 0)
  assert.equal(rec.claims.length, 0)
  assert.equal(out.done, false)
  const delay = (out.nextWakeAtMs as number) - before
  assert.ok(delay >= 4000 * 1000 + CLAIM_GRACE_MS - 2000, `应睡到落地点+余量，实际 ${delay}ms`)
})

test('traveling 已过到达时间 → 领取', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 66, locationName: '健身房', arriveAt: 900, serverNow: 1000, dailyLimitReached: true }),
    recorder: rec,
  })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.deepEqual(rec.claims, [66])
  assert.equal(out.done, false, '领取后继续循环')
  assert.equal(entry.claimedCredit, 7)
})

test('claim 回 not arrived yet → 按余量重试，不收工', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 88 }),
    claim: { ok: false, nothingToClaim: false, notArrivedYet: true, message: 'not arrived yet', code: 400 },
    recorder: rec,
  })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.equal(rec.claims.length, 1)
  assert.equal(out.done, false)
  assert.equal(entry.failures, 0, '「还没到」不是失败，不该累加 failures')
  assert.ok((out.nextWakeAtMs as number) > Date.now())
})

test('claim 回 nothing to claim → 视为已结算，继续循环', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 99 }),
    claim: { ok: false, nothingToClaim: true, notArrivedYet: false, message: 'no unclaimed travel', code: 400 },
    recorder: rec,
  })
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)

  assert.equal(out.done, false, '已结算后还要继续派')
  assert.equal(entry.claimedAtMs !== undefined, true)
})

test('连续领取失败达上限后自愈：服务端已 idle 就当已领', async () => {
  const rec = fresh()
  const entry = createTravelState(TODAY)
  entry.claimAttempts = MAX_CLAIM_ATTEMPTS
  // 服务端说已经 idle（行程消失）→ 视为已结算
  const svc = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: false }), recorder: rec })
  const out = await svc.tick(entry)

  assert.equal(rec.claims.length, 0, '已达上限时不该再盲目 claim')
  assert.equal(out.done, false)
  assert.equal(entry.claimAttempts, 0, '自愈后应重置计数')
})

// ---------- 时间窗 ----------

test('窗外不派遣，窗内派遣（用服务端小时判定）', async () => {
  // 构造一个服务端本地时间为 03:00 的时刻（窗外）
  const threeAm = Math.floor(new Date(2026, 8, 26, 3, 0, 0).getTime() / 1000)
  const rec1 = fresh()
  const svc1 = makeService({ status: statusOf({ state: 'idle', serverNow: threeAm }), recorder: rec1 })
  const e1 = createTravelState(TODAY)
  const out1 = await svc1.tick(e1)
  assert.equal(rec1.departs.length, 0, '03:00 不该派')
  assert.equal(out1.done, true)
  assert.equal(e1.doneReason, 'window')

  const tenAm = Math.floor(new Date(2026, 8, 26, 10, 0, 0).getTime() / 1000)
  const rec2 = fresh()
  const svc2 = makeService({ status: statusOf({ state: 'idle', serverNow: tenAm }), recorder: rec2 })
  await svc2.tick(createTravelState(TODAY))
  assert.equal(rec2.departs.length, 1, '10:00 该派')
})

test('窗口只挡派遣：夜里落地的行程照常领取', async () => {
  const threeAm = Math.floor(new Date(2026, 8, 26, 3, 0, 0).getTime() / 1000)
  const rec = fresh()
  // 凌晨 3 点，行程已到点 → 必须能领
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 5, locationName: '咖啡馆', arriveAt: threeAm - 100, serverNow: threeAm, dailyLimitReached: true }),
    recorder: rec,
  })
  const out = await svc.tick(createTravelState(TODAY))
  assert.deepEqual(rec.claims, [5], '夜间落地必须能领取')
  assert.equal(out.done, false)
})

test('withinWindow 边界：起始小时含、结束小时不含', () => {
  const w: TravelWindow = { startHour: 8, endHour: 23 }
  const at = (h: number) => Math.floor(new Date(2026, 8, 26, h, 0, 0).getTime() / 1000)
  assert.equal(withinWindow(at(7), w), false)
  assert.equal(withinWindow(at(8), w), true)
  assert.equal(withinWindow(at(22), w), true)
  assert.equal(withinWindow(at(23), w), false, '23:00 已出窗')
  assert.equal(withinWindow(at(2), w), false)
})

test('msUntilWindowOpens：窗内为 0，窗外给出正数', () => {
  const w: TravelWindow = { startHour: 8, endHour: 23 }
  const at = (h: number) => Math.floor(new Date(2026, 8, 26, h, 0, 0).getTime() / 1000)
  assert.equal(msUntilWindowOpens(at(10), w, 0), 0)
  const wait = msUntilWindowOpens(at(23), w, Date.now())
  assert.ok(wait > 0 && wait <= 24 * 3600 * 1000, `应给出合理等待，实际 ${wait}`)
})

// ---------- 失败处理 ----------

test('退避阶梯递增并封顶', () => {
  assert.equal(backoffMs(1), BACKOFF_LADDER_MS[0])
  assert.equal(backoffMs(2), BACKOFF_LADDER_MS[1])
  assert.equal(backoffMs(3), BACKOFF_LADDER_MS[2])
  assert.equal(backoffMs(99), BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1], '应封顶在最后一档')
  for (let i = 1; i < BACKOFF_LADDER_MS.length; i++) {
    assert.ok((BACKOFF_LADDER_MS[i] as number) > (BACKOFF_LADDER_MS[i - 1] as number), '阶梯应递增')
  }
})

test('读取状态失败 → 退避重试，不收工', async () => {
  const rec = fresh()
  const svc = new WorkBuddyTravelService(
    { resolve: async () => { throw new Error('未登录') } },
    {} as never,
  )
  const entry = createTravelState(TODAY)
  const out = await svc.tick(entry)
  assert.equal(out.done, false)
  assert.equal(entry.failures, 1)
  assert.ok(entry.retryAfterMs !== undefined && entry.retryAfterMs > Date.now())
})

test('连续失败达上限 → 暂停到次日', async () => {
  const rec = fresh()
  const svc = new WorkBuddyTravelService(
    { resolve: async () => { throw new Error('持续失败') } },
    {} as never,
  )
  const entry = createTravelState(TODAY)
  entry.failures = MAX_CONSECUTIVE_FAILURES - 1
  const out = await svc.tick(entry)
  assert.equal(out.done, true, '连续失败到上限应暂停')
  assert.equal(entry.failures, MAX_CONSECUTIVE_FAILURES)
})

test('失败冷却期内不再打上游', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle' }), recorder: rec })
  const entry = createTravelState(TODAY)
  entry.retryAfterMs = Date.now() + 60_000
  const out = await svc.tick(entry)
  assert.equal(rec.departs.length, 0, '冷却期内不应调用 depart')
  assert.equal((out.nextWakeAtMs as number), entry.retryAfterMs)
})

// ---------- 跨天 ----------

test('跨天重置每日字段，保留历史展示信息', () => {
  const yesterday = {
    date: '2026-09-25', departed: true, recordId: 123, departAt: 111, arriveAt: 222,
    state: 'traveling' as const, done: true, claimAttempts: 3, failures: 5,
    locationName: '咖啡馆', rewardCredit: 10, claimedCredit: 10, claimedAtMs: 999,
  }
  const rolled = rollTravelStateToToday(yesterday, TODAY)
  assert.equal(rolled.date, TODAY)
  assert.equal(rolled.departed, false)
  assert.equal(rolled.done, false)
  assert.equal(rolled.claimAttempts, 0)
  assert.equal(rolled.failures, 0)
  assert.equal(rolled.locationName, '咖啡馆')
  assert.equal(rolled.claimedCredit, 10)
})

test('同一天调用 rollTravelStateToToday 返回原对象', () => {
  const entry = createTravelState(TODAY)
  assert.equal(rollTravelStateToToday(entry, TODAY), entry)
})

// ---------- 手动派遣 ----------

test('departNow：未达上限且空闲 → 派出', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: false }), recorder: rec })
  const entry = createTravelState(TODAY)
  const out = await svc.departNow(entry)
  assert.equal(out.ok, true)
  assert.equal(rec.departs.length, 1)
  assert.equal(entry.departed, true, '手动派遣也要更新状态供面板展示')
})

test('departNow：旅行中 → 如实说明，不重复派', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 1, locationName: '咖啡馆', arriveAt: 5000, serverNow: 1000, dailyLimitReached: true }),
    recorder: rec,
  })
  const out = await svc.departNow(createTravelState(TODAY))
  assert.equal(out.ok, false)
  assert.equal(rec.departs.length, 0)
  assert.match(out.message, /旅行中/)
})

test('departNow：已达上限 → 如实说明', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: true }), recorder: rec })
  const out = await svc.departNow(createTravelState(TODAY))
  assert.equal(out.ok, false)
  assert.equal(rec.departs.length, 0)
  assert.match(out.message, /今日已派/)
})

// ---------- 安全：上游文案截断（真实 departTravel 路径） ----------

test('超长的上游错误文案被截断（替换全局 fetch 驱动真实方法）', async () => {
  const huge = 'x'.repeat(50_000)
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ code: 400, msg: huge, data: null }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    const cred = { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.codebuddy.cn', uid: 'u' }
    const result = await client.departTravel(cred as never, 1)
    assert.equal(result.ok, false)
    assert.ok(result.message.length <= 201, `应截断到 200 字符左右，实际 ${result.message.length}`)
    assert.ok(!result.message.includes('x'.repeat(1000)))
  } finally {
    globalThis.fetch = original
  }
})
