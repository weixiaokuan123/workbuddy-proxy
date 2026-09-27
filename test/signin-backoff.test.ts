import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SigninScheduler } from '../src/scheduler.ts'

/**
 * 失败退避的行为约定。
 *
 * 这组用例存在的理由：曾经把「未领取」的 1 小时冷却直接套用到「失败」上，
 * 结果 22:30 的一次网络抖动会被推到 23:30 —— 而签到窗口 23:00 就关，
 * 当天的积分直接没了。修复时最容易犯的错就是只想着「别空转」而忘了
 * 「别让用户丢积分」，所以这两种性质必须同时被钉住。
 */

const END_HOUR = 23
let seq = 0

function newSched(dir: string): SigninScheduler {
  return new SigninScheduler({
    stateFile: join(dir, `st-${seq++}.json`),
    startHour: 0,
    endHour: END_HOUR,
    log: () => {},
  })
}

function at(h: number, m: number): Date {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

function nextDay(h: number, m: number): Date {
  const d = at(h, m)
  d.setDate(d.getDate() + 1)
  return d
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60_000)
}

/** plan() 是 async；runAtSec=0 让它立刻到期，绕开随机时刻。 */
async function dueEntry(s: SigninScheduler) {
  const e = await s.plan('t')
  e.runAtSec = 0
  return e
}

const boom = async (): Promise<never> => { throw new Error('boom') }
const won = async () => ({ claimed: true, already: false, message: 'ok' })
const notClaimed = async () => ({ claimed: false, already: false, message: '活动未开启' })

test('首次失败 5 分钟后重试（瞬时故障要能快速恢复）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const now = at(10, 0)
  const e = await dueEntry(s)
  const r = await s.runIfDue('t', boom, now)
  assert.equal(r.ran, true)
  assert.equal(minutesBetween(new Date(e.retryAfterMs!), now), 5)
  assert.equal(e.failStreak, 1)
})

test('连续失败按 5→15→45→60 分钟退避并收敛', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const e = await dueEntry(s)
  const gaps: number[] = []
  let now = at(10, 0)
  for (let i = 0; i < 5; i++) {
    e.retryAfterMs = 0
    await s.runIfDue('t', boom, now)
    gaps.push(minutesBetween(new Date(e.retryAfterMs!), now))
    now = new Date(e.retryAfterMs!)
  }
  assert.deepEqual(gaps, [5, 15, 45, 60, 60])
})

test('永久性失败不会退回 5 分钟（否则等于没退避）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const e = await dueEntry(s)
  e.failStreak = 5
  const now = at(10, 0)
  await s.runIfDue('t', boom, now)
  assert.equal(minutesBetween(new Date(e.retryAfterMs!), now), 60)
})

test('退避绝不越过窗口关闭时刻（否则当天积分会丢）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const now = at(22, 40)              // 距窗口关闭只剩 20 分钟
  const e = await dueEntry(s)
  e.failStreak = 5                   // 裸退避本应排到 23:40
  await s.runIfDue('t', boom, now)

  const endOfWindow = new Date(now)
  endOfWindow.setHours(0, 0, 0, 0)
  endOfWindow.setSeconds(END_HOUR * 3600 - 1)

  const retryAt = new Date(e.retryAfterMs!)
  assert.ok(retryAt.getTime() <= endOfWindow.getTime(), '重试必须落在窗口内')
  assert.ok(retryAt.getTime() > now.getTime(), '重试不能是已过去的时刻')
  assert.equal(retryAt.toDateString(), now.toDateString(), '不能被推到跨天')
  assert.ok(retryAt.getTime() - now.getTime() >= 5 * 60_000, '至少留 5 分钟重试机会')
})

test('成功后失败计数与冷却一并清零', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const now = at(10, 0)
  const e = await dueEntry(s)
  e.failStreak = 3
  await s.runIfDue('t', boom, now)
  assert.equal(e.failStreak, 4)
  e.retryAfterMs = 0
  await s.runIfDue('t', won, now)
  assert.equal(e.failStreak, undefined)
  assert.equal(e.retryAfterMs, undefined)
})

test('跨天后失败计数与冷却一并重置', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const e = await dueEntry(s)
  e.failStreak = 9
  await s.runIfDue('t', boom, at(9, 0))
  assert.equal(e.failStreak, 10)

  // 跨天。ensureEntry 会给新一天生成**随机** runAtSec，所以这次调用很可能
  // 因未到点而提前返回——这正好用来验证「重建的 entry 不带昨天的状态」。
  // 注意不能在这里断言 claimed：claimer 根本没被调用，断言它会变成随机通过。
  const r = await s.runIfDue('t', won, nextDay(9, 0))
  assert.notEqual(r.entry, e, '跨天应重建 entry')
  assert.equal(r.entry?.failStreak, undefined)
  assert.equal(r.entry?.retryAfterMs, undefined)

  // 新的一天确实能正常领取。
  //
  // 注意 ensureEntry 给新一天生成的是**随机** runAtSec，所以上面那次调用
  // 有约 39% 概率「随机时刻早于 09:00」而当场领完（claimed=true）。要让
  // 这一步可重复，必须先把状态显式摆回未领取且已到期——否则断言会随机通过。
  r.entry!.claimed = false
  r.entry!.runAtSec = 0
  const r2 = await s.runIfDue('t', won, nextDay(9, 0))
  assert.equal(r2.ran, true)
  assert.equal(r2.entry?.claimed, true)
  assert.equal(r2.entry?.retryAfterMs, undefined)
})

test('冷却期内不再调用上游', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const e = await dueEntry(s)
  e.failStreak = 5
  await s.runIfDue('t', boom, at(10, 0))
  let called = 0
  const during = new Date(e.retryAfterMs! - 60_000)
  const r = await s.runIfDue('t', async () => { called++; return { claimed: true, already: false, message: 'x' } }, during)
  assert.equal(r.ran, false)
  assert.equal(called, 0)
})

test('未领取仍走 1 小时冷却，且不计入失败计数', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = newSched(dir)
  const e = await dueEntry(s)
  await s.runIfDue('t', notClaimed, at(10, 0))
  // 未领取路径沿用真实时钟，所以拿它自己写的两个字段相比，避免时钟混用
  assert.equal(minutesBetween(new Date(e.retryAfterMs!), new Date(e.attemptedAtMs!)), 60)
  assert.equal(e.failStreak, undefined, 'failStreak 是失败专用，未领取不算失败')
})
