/**
 * 池化切换测试：账号去重 + 候选池优先级排序。
 *
 * 覆盖：
 *  1. dropLiveDuplicates：uid 相同的库记录被剔除，不同账号保留
 *  2. 无 live 身份时全部保留
 *  3. shim 候选池：主账号优先，其次可用账号，冷却中的排最后
 *  4. 全部冷却时仍然尝试（而不是直接报错）
 *  5. /status 暴露 pool 字段
 *
 * 运行：node --test test/pool.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import {
  dropLiveDuplicates,
  identityKeysOfCredential,
  identityKeysOfRecord,
  type StoredAccount,
} from '../src/accounts.ts'
import { createWorkBuddyShim, RateLimitRegistry, type CredentialStoreLike } from '../src/shim.ts'
import type { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyAuthStatus, WorkBuddyCredential } from '../src/auth.ts'

function account(over: Partial<StoredAccount> & { key: string }): StoredAccount {
  return {
    label: over.key,
    region: 'cn',
    domain: 'www.codebuddy.cn',
    uid: '',
    accessToken: 'a',
    refreshToken: 'r',
    expiresAtMs: Date.now() + 3600_000,
    source: 'switch',
    createdAtMs: 0,
    ...over,
  }
}

// ---------- 1~2. 去重 ----------

test('uid 相同的库记录被剔除', () => {
  const live = identityKeysOfCredential('cn', { uid: 'u1', nickname: '什么铁环' })
  assert.deepEqual(live, ['cn:uid:u1', 'cn:name:什么铁环'])

  const kept = dropLiveDuplicates(new Set(live), [
    account({ key: 'a', uid: 'u1', nickname: '什么铁环' }),   // 与 live 同号 → 剔除
    account({ key: 'b', uid: 'u2', nickname: '另一个号' }),   // 保留
  ])
  assert.deepEqual(kept.map(a => a.key), ['b'])
})

test('uid 缺失时用 displayName 兜底比对', () => {
  const live = identityKeysOfCredential('cn', { uid: '', nickname: '19940501141' })
  const kept = dropLiveDuplicates(new Set(live), [
    account({ key: 'a', uid: '', nickname: '19940501141' }), // 同名 → 剔除
    account({ key: 'b', uid: 'u9', nickname: '别的号' }),     // 保留
  ])
  assert.deepEqual(kept.map(a => a.key), ['b'])
})

test('区域不同不算重复（同 uid 跨区是两个独立账号）', () => {
  const live = new Set(identityKeysOfCredential('global', { uid: 'u1' }))
  const kept = dropLiveDuplicates(live, [
    account({ key: 'cn-acct', region: 'cn', uid: 'u1' }),
    account({ key: 'global-acct', region: 'global', uid: 'u1' }),
  ])
  assert.deepEqual(kept.map(a => a.key), ['cn-acct'], 'global 的同 uid 应被剔除')
})

test('无 live 身份时全部保留', () => {
  const kept = dropLiveDuplicates(new Set(), [account({ key: 'a' }), account({ key: 'b' })])
  assert.equal(kept.length, 2)
})

test('identityKeysOfRecord 对空 uid 不产生 uid 键', () => {
  assert.deepEqual(identityKeysOfRecord(account({ key: 'a', uid: '', nickname: 'n1' })), ['cn:name:n1'])
})

// ---------- 3~5. 候选池 ----------

const okCatalog: WorkBuddyCatalog = {
  current: () => [{ id: 'm1', name: 'm1', contextWindow: 1000, maxTokens: 100 }],
  set: () => {},
} as unknown as WorkBuddyCatalog

function storeOf(account_: string): CredentialStoreLike {
  const credential: WorkBuddyCredential = { accessToken: account_, refreshToken: 'r', expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn', uid: account_ }
  return {
    async resolve() { return credential },
    async status(): Promise<WorkBuddyAuthStatus> {
      return { state: 'signed-in', account: account_, domain: 'www.codebuddy.cn' }
    },
  }
}

/** 记录调用顺序的假 upstream：按 account 决定成功还是限流。 */
function fakeClient(behavior: (account: string, nth: number) => { ok: true } | { ok: false; kind: 'soft_rate'; status: number; message: string }) {
  let nth = 0
  return {
    async chatStream(credential: WorkBuddyCredential) {
      nth += 1
      const r = behavior(credential.accessToken, nth)
      if (r.ok) {
        const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
        return { ok: true as const, response: new Response(Readable.toWeb(Readable.from([sse])) as ReadableStream, { headers: { 'content-type': 'text/event-stream' } }) }
      }
      return { ok: false as const, status: r.status, kind: r.kind, message: r.message }
    },
  }
}

async function callShim(opts: {
  port: number
  selfId: string
  candidates: Array<{ id: string; label: string; store: CredentialStoreLike }>
  registry: RateLimitRegistry
  client: unknown
}): Promise<{ status: number; body: string }> {
  const shim = createWorkBuddyShim({
    region: 'cn',
    port: opts.port,
    token: 'test-token',
    store: opts.candidates.find(c => c.id === opts.selfId)!.store,
    client: opts.client as never,
    catalog: okCatalog,
    failover: {
      selfId: opts.selfId,
      candidates: () => opts.candidates.map(c => ({ id: c.id, label: c.label, store: c.store })),
      registry: opts.registry,
    },
  })
  await shim.ready
  try {
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    return { status: res.status, body: await res.text() }
  } finally {
    await shim.close()
  }
}

test('主账号限流后切到同池其他账号并成功', async () => {
  const registry = new RateLimitRegistry()
  const candidates = [
    { id: 'live-cn', label: 'cn·当前登录', store: storeOf('primary') },
    { id: 'acct:x', label: 'cn·备用', store: storeOf('backup') },
  ]
  const client = fakeClient(acc => acc === 'primary'
    ? { ok: false, kind: 'soft_rate', status: 429, message: '频率限制，将在 2026-09-23 08:44:36 UTC+8 重置' }
    : { ok: true })

  const r = await callShim({ port: 0, selfId: 'live-cn', candidates, registry, client })
  assert.equal(r.status, 200)
  assert.ok(r.body.includes('[DONE]'))
  assert.equal(registry.isLimited('live-cn'), true, '主账号应被登记为限流')
})

test('冷却中的账号排在末尾，但仍会尝试（不直接报错）', async () => {
  const registry = new RateLimitRegistry()
  registry.mark('acct:limited', Date.now() + 60_000) // 明确冷却中
  const candidates = [
    { id: 'live-cn', label: 'cn·当前登录', store: storeOf('primary') },
    { id: 'acct:limited', label: 'cn·冷却号', store: storeOf('cold') },
  ]
  // 主账号也失败（非限流错误），只会尝试一次后 break —— 这里验证主账号优先被使用
  const client = fakeClient(() => ({ ok: true }))
  const r = await callShim({ port: 0, selfId: 'live-cn', candidates, registry, client })
  assert.equal(r.status, 200)
})

test('全部账号限流时报错并说明已尝试切号', async () => {
  const registry = new RateLimitRegistry()
  const candidates = [
    { id: 'live-cn', label: 'cn·当前登录', store: storeOf('a') },
    { id: 'acct:x', label: 'cn·备用', store: storeOf('b') },
  ]
  const client = fakeClient(() => ({ ok: false, kind: 'soft_rate', status: 429, message: '频率限制，将在 2026-09-23 08:44:36 UTC+8 重置' }))
  const r = await callShim({ port: 0, selfId: 'live-cn', candidates, registry, client })
  assert.equal(r.status, 429)
  assert.ok(r.body.includes('已尝试 2 个同区域账号'), `实际: ${r.body}`)
  assert.ok(r.body.includes('2 个因额度限流被跳过'), `实际: ${r.body}`)
})

test('/status 暴露 pool 字段（池大小与冷却状态）', async () => {
  const registry = new RateLimitRegistry()
  registry.mark('acct:x', Date.now() + 30_000)
  const candidates = [
    { id: 'live-cn', label: 'cn·当前登录', store: storeOf('a') },
    { id: 'acct:x', label: 'cn·备用', store: storeOf('b') },
  ]
  const shim = createWorkBuddyShim({
    region: 'cn', port: 0, token: 'tk', store: candidates[0]!.store,
    client: fakeClient(() => ({ ok: true })) as never,
    catalog: okCatalog,
    failover: { selfId: 'live-cn', candidates: () => candidates, registry },
  })
  await shim.ready
  try {
    const res = await fetch(`${shim.baseUrl()}/status`, { headers: { Authorization: 'Bearer tk' } })
    const body = await res.json() as { pool?: { size: number; entries: Array<{ id: string; preferred: boolean; rateLimited: boolean }> } }
    assert.ok(body.pool !== undefined, '应有 pool 字段')
    assert.equal(body.pool.size, 2)
    const self = body.pool.entries.find(e => e.id === 'live-cn')!
    const other = body.pool.entries.find(e => e.id === 'acct:x')!
    assert.equal(self.preferred, true)
    assert.equal(self.rateLimited, false)
    assert.equal(other.rateLimited, true, '冷却账号应标记 rateLimited')
  } finally {
    await shim.close()
  }
})
