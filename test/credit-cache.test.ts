/**
 * 积分缓存（CreditCache）测试。
 *
 * 覆盖：
 *  - TTL 内命中缓存，不重复调上游
 *  - TTL 过期后重新拉取
 *  - 不同账号（uid/domain）互不干扰
 *  - single-flight：并发请求只打一次上游
 *  - 上游失败时回退旧值并标记 stale
 *  - 无旧值可退时把错误抛给调用方
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CreditCache, CREDIT_CACHE_TTL_MS } from '../src/credit-cache.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyCredits } from '../src/upstream.ts'

function cred(uid: string, domain = 'www.codebuddy.cn'): WorkBuddyCredential {
  return { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain, uid }
}

function credits(total: number): WorkBuddyCredits {
  return { total, packages: [] } as unknown as WorkBuddyCredits
}

test('TTL 内命中缓存，不重复调上游', async () => {
  let now = 1000
  const cache = new CreditCache(() => now)
  let calls = 0
  const loader = async () => { calls++; return credits(100) }

  const a = await cache.get(cred('u1'), loader)
  assert.equal(a.cached, false)
  assert.equal(calls, 1)

  now += CREDIT_CACHE_TTL_MS - 1
  const b = await cache.get(cred('u1'), loader)
  assert.equal(b.cached, true)
  assert.equal(b.stale, false)
  assert.equal(calls, 1, 'TTL 内不应再次调上游')
  assert.equal(b.credits.total, 100)
})

test('TTL 过期后重新拉取', async () => {
  let now = 0
  const cache = new CreditCache(() => now)
  let calls = 0
  const loader = async () => { calls++; return credits(calls * 10) }

  await cache.get(cred('u1'), loader)
  now += CREDIT_CACHE_TTL_MS + 1
  const r = await cache.get(cred('u1'), loader)
  assert.equal(r.cached, false)
  assert.equal(calls, 2)
  assert.equal(r.credits.total, 20)
})

test('不同账号互不干扰（同一缓存实例）', async () => {
  let now = 0
  const cache = new CreditCache(() => now)
  const seen: string[] = []
  const loader = async (c: WorkBuddyCredential) => { seen.push(c.uid); return credits(c.uid === 'u1' ? 11 : 22) }

  const a = await cache.get(cred('u1'), loader)
  const b = await cache.get(cred('u2'), loader)
  assert.equal(a.credits.total, 11)
  assert.equal(b.credits.total, 22)
  assert.deepEqual(seen, ['u1', 'u2'])

  // 再次请求 u1 应命中缓存，不产成新调用
  await cache.get(cred('u1'), loader)
  assert.deepEqual(seen, ['u1', 'u2'])
})

test('相同 uid 不同 domain 视为不同账号', async () => {
  let now = 0
  const cache = new CreditCache(() => now)
  let calls = 0
  const loader = async () => { calls++; return credits(calls) }
  await cache.get(cred('u1', 'www.codebuddy.cn'), loader)
  await cache.get(cred('u1', 'www.workbuddy.ai'), loader)
  assert.equal(calls, 2, '跨区域同名 uid 不应共享缓存')
})

test('single-flight：并发请求只打一次上游', async () => {
  const cache = new CreditCache(() => 0)
  let calls = 0
  const loader = async () => {
    calls++
    await new Promise(r => setTimeout(r, 20))
    return credits(77)
  }
  const results = await Promise.all([
    cache.get(cred('u1'), loader),
    cache.get(cred('u1'), loader),
    cache.get(cred('u1'), loader),
    cache.get(cred('u1'), loader),
  ])
  assert.equal(calls, 1, '并发 4 次应只产生 1 次上游调用')
  assert.ok(results.every(r => r.credits.total === 77))
})

test('上游失败时回退旧值并标记 stale', async () => {
  let now = 0
  const cache = new CreditCache(() => now)
  await cache.get(cred('u1'), async () => credits(50))

  now += CREDIT_CACHE_TTL_MS + 1
  const r = await cache.get(cred('u1'), async () => { throw new Error('upstream 500') })
  assert.equal(r.stale, true)
  assert.equal(r.cached, true)
  assert.equal(r.credits.total, 50, '应回退到上次成功的值')
  assert.equal(r.ageMs, CREDIT_CACHE_TTL_MS + 1)
})

test('无旧值可退时把错误抛给调用方', async () => {
  const cache = new CreditCache(() => 0)
  await assert.rejects(
    () => cache.get(cred('fresh'), async () => { throw new Error('boom') }),
    /boom/,
  )
})

test('旧值超出容忍窗口后不再兜底', async () => {
  let now = 0
  const cache = new CreditCache(() => now)
  await cache.get(cred('u1'), async () => credits(50))

  // 超过 15 分钟容忍窗口
  now += 16 * 60_000
  await assert.rejects(
    () => cache.get(cred('u1'), async () => { throw new Error('too-old') }),
    /too-old/,
  )
})

test('clear() 后强制重新拉取', async () => {
  const cache = new CreditCache(() => 0)
  let calls = 0
  await cache.get(cred('u1'), async () => { calls++; return credits(1) })
  cache.clear()
  await cache.get(cred('u1'), async () => { calls++; return credits(2) })
  assert.equal(calls, 2)
})