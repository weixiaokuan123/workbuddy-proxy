/**
 * 派猫猫旅行（成长中心）状态机测试。
 *
 * 覆盖：
 *  - 无 Buddy（buddy_id=0）直接跳过，绝不发 depart
 *  - idle + 未达上限 → depart；随机选点
 *  - idle + 达每日上限 → 不 depart
 *  - traveling 未到点 → 不调任何写接口
 *  - traveling 已到点 → 自动推进到 claim（服务端偶尔仍报 traveling）
 *  - arrived → claim 并标记完成
 *  - claim 被拒「还没到」→ 不标记完成，等下一轮
 *  - claim 被拒「无待领」→ 视为已领（网页端抢先），标记完成
 *  - depart 被拒「已在旅行中」→ 转为进行中而非报错
 *  - 跨天重置每日字段
 *  - 到达判定只用服务端时间戳之差，不与本地时钟比较
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { WorkBuddyTravelService, createTravelState, rollTravelStateToToday } from '../src/travel.ts'
import type { WorkBuddyTravelStatus } from '../src/upstream.ts'

/** 记录写接口调用次数，断言「不该写的时候一个都没写」。 */
interface Recorder {
  departs: number[]
  claims: number[]
}

function statusOf(over: Partial<WorkBuddyTravelStatus> = {}): WorkBuddyTravelStatus {
  return {
    state: 'idle',
    buddyId: 111,
    recordId: 0,
    locationName: '',
    departAt: 0,
    arriveAt: 0,
    dailyLimitReached: false,
    serverNow: 1000,
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
  // 类型上只需满足 WorkBuddyUpstreamClient 的一部分；这里刻意最小化。
  return new WorkBuddyTravelService({ resolve: async () => ({}) }, client as never)
}

function fresh(): Recorder { return { departs: [], claims: [] } }

test('无 Buddy 直接跳过，不发 depart', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ buddyId: 0 }), recorder: rec })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(out.done, true)
  assert.match(out.message, /无 Buddy/)
  assert.equal(rec.departs.length, 0, '无 Buddy 不应发 depart')
  assert.equal(entry.done, true)
})

test('idle 且未达上限 → depart', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle' }), recorder: rec })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 1, '应发一次 depart')
  // 随机选点：必须落在 config 给出的 1 或 4 之中
  assert.ok([1, 4].includes(rec.departs[0] as number), `选点越界: ${rec.departs[0]}`)
  assert.equal(out.acted, true)
  assert.equal(entry.departed, true)
})

test('idle 且已达每日上限 → 不 depart', async () => {
  const rec = fresh()
  const svc = makeService({ status: statusOf({ state: 'idle', dailyLimitReached: true }), recorder: rec })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 0)
  assert.equal(out.done, true)
  assert.equal(entry.done, true)
})

test('traveling 未到点 → 不调任何写接口', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 77, locationName: '咖啡馆', arriveAt: 5000, serverNow: 1000, dailyLimitReached: true }),
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 0)
  assert.equal(rec.claims.length, 0)
  assert.equal(out.done, false, '行程未结束，当天仍需继续看')
  assert.equal(entry.done, false)
  assert.match(out.message, /旅行中/)
})

test('traveling 已过到达时间 → 自动推进到 claim', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 66, locationName: '健身房', arriveAt: 900, serverNow: 1000, dailyLimitReached: true }),
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 0)
  assert.deepEqual(rec.claims, [66], '应按服务端 record_id 领取')
  assert.equal(out.done, true)
  assert.equal(entry.done, true)
  assert.equal(entry.rewardCredit, 7)
})

test('arrived → claim 并标记完成', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 55, locationName: '古镇客栈' }),
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.deepEqual(rec.claims, [55])
  assert.equal(out.done, true)
  assert.equal(entry.state, 'idle')
  assert.match(out.message, /古镇客栈/)
})

test('claim 被拒「还没到」→ 不标记完成，等下一轮', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 88 }),
    claim: { ok: false, nothingToClaim: false, notArrivedYet: true, message: 'not arrived yet', code: 400 },
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.claims.length, 1)
  assert.equal(out.done, false)
  assert.equal(entry.done, false, '未成功领取不得标记完成')
  assert.ok((entry.retryAfterMs ?? 0) > Date.now(), '应设置重试冷却')
})

test('claim 被拒「无待领」→ 视为已领（网页端抢先），标记完成', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'arrived', recordId: 99 }),
    claim: { ok: false, nothingToClaim: true, notArrivedYet: false, message: 'no unclaimed travel', code: 400 },
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(out.done, true)
  assert.equal(entry.done, true)
})

test('depart 被拒「已在旅行中」→ 转为进行中而非报错', async () => {
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'idle' }),
    depart: { ok: false, already: true, dailyLimitReached: false, noBuddy: false, message: 'already traveling', code: 409 },
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.departs.length, 1)
  assert.match(out.message, /已在旅行中/)
  assert.equal(entry.departed, true)
  assert.equal(out.done, false, '行程进行中，当天仍需跟进')
})

test('跨天重置每日字段，但保留历史展示信息', () => {
  const yesterday = {
    date: '2026-09-25',
    departed: true,
    recordId: 123,
    departAt: 111,
    arriveAt: 222,
    state: 'traveling' as const,
    done: true,
    locationName: '咖啡馆',
    rewardCredit: 10,
  }
  const rolled = rollTravelStateToToday(yesterday, '2026-09-26')

  assert.equal(rolled.date, '2026-09-26')
  assert.equal(rolled.departed, false, '新的一天应允许再派')
  assert.equal(rolled.done, false, '新的一天应重置完成标记')
  assert.equal(rolled.recordId, 0)
  assert.equal(rolled.state, 'idle', '跨天行程不保留，避免拿昨天的 record_id 去领')
  assert.equal(rolled.locationName, '咖啡馆', '保留展示信息')
  assert.equal(rolled.rewardCredit, 10, '保留展示信息')
})

test('同一天调用 rollTravelStateToToday 返回原对象', () => {
  const entry = createTravelState('2026-09-26')
  assert.equal(rollTravelStateToToday(entry, '2026-09-26'), entry)
})

test('到达判定只依赖服务端时间戳之差，与本地时钟无关', async () => {
  // arrive_at 是平台内部时间戳：数值远小于本地 Date.now()/1000 也不影响判定，
  // 只要 arrive_at 与 server_now 的差值 > 0 就认为未到达。
  const rec = fresh()
  const svc = makeService({
    status: statusOf({ state: 'traveling', recordId: 1, arriveAt: 500, serverNow: 400, dailyLimitReached: true }),
    recorder: rec,
  })
  const entry = createTravelState('2026-09-26')
  const out = await svc.tick(entry)

  assert.equal(rec.claims.length, 0, '差值 100 秒 > 0，尚未到达')
  assert.equal(out.done, false)
})
