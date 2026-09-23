/**
 * 限流切号模拟测试（无需真实网络、不消耗任何账号额度）。
 *
 * 覆盖：
 *  1. classifyUpstreamError / isRateLimited 对 6004 的识别
 *  2. parseRateLimitResetMs 对「将在 2026-09-23 08:44:36 UTC+8 重置」的解析
 *  3. chatStream 对「HTTP 200 + code:6004 JSON 信封」的识别（旧版会误当 SSE）
 *  4. shim 层：账号 A 限流 → 自动切到账号 B 并成功
 *  5. shim 层：全部账号限流 → 如实报错且提示已尝试切号
 *  6. 限流登记表：被限流账号在恢复前被跳过
 *
 * 运行：node --test test/failover.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import {
  classifyUpstreamError,
  isRateLimited,
  parseEnvelopeCode,
  parseRateLimitResetMs,
  WorkBuddyUpstreamClient,
  type WorkBuddyCredential,
} from '../src/upstream.ts'
import { createWorkBuddyShim, RateLimitRegistry, type CredentialStoreLike } from '../src/shim.ts'
import type { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyAuthStatus } from '../src/auth.ts'

const RATE_BODY = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-23 08:44:36 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"1f8619e0-8df0-42c4-b93d-efc75a6e536a"}'

// ---------- 1. 分类与解析 ----------

test('6004 信封被识别为限流而非额度不足', () => {
  assert.equal(parseEnvelopeCode(RATE_BODY), 6004)
  assert.equal(isRateLimited(200, RATE_BODY), true)
  assert.equal(classifyUpstreamError(200, RATE_BODY), 'soft_rate')
})

test('429 无业务码也算限流', () => {
  assert.equal(classifyUpstreamError(429, ''), 'soft_rate')
})

test('真正的额度不足仍归为 hard_credit（不被限流规则抢走）', () => {
  assert.equal(classifyUpstreamError(402, ''), 'hard_credit')
  assert.equal(classifyUpstreamError(200, '{"code":1,"msg":"积分不足"}'), 'hard_credit')
})

test('解析 UTC+8 重置时间', () => {
  const ms = parseRateLimitResetMs(RATE_BODY)
  assert.ok(ms !== undefined, '应解析出时间')
  // 2026-09-23 08:44:36 UTC+8 === 2026-09-23 00:44:36 UTC
  assert.equal(new Date(ms).toISOString(), '2026-09-23T00:44:36.000Z')
})

test('无时区信息时按本地时间理解', () => {
  const ms = parseRateLimitResetMs('将在 2026-09-23 08:44:36 重置')
  assert.ok(ms !== undefined)
  const d = new Date(ms)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 8)
  assert.equal(d.getDate(), 23)
  assert.equal(d.getHours(), 8)
})

test('解析不出时间时返回 undefined', () => {
  assert.equal(parseRateLimitResetMs('请求过于频繁'), undefined)
})

// ---------- 2. 限流登记表 ----------

test('登记表：标记后在恢复前视为限流，过期后自动解除', () => {
  const reg = new RateLimitRegistry(60_000)
  assert.equal(reg.isLimited('a'), false)
  reg.mark('a')
  assert.equal(reg.isLimited('a'), true)
  assert.ok(reg.remainingMs('a') > 0)
  // 显式给一个已过去的时间：仍应保留最小 30s 冷却，防止时钟偏差导致立刻复用
  reg.mark('b', Date.now() - 100_000)
  assert.equal(reg.isLimited('b'), true, '过去的时间也应至少冷却 30s')
})

test('登记表：上游给出的未来时间被采纳', () => {
  const reg = new RateLimitRegistry(60_000)
  const future = Date.now() + 3_600_000
  reg.mark('a', future)
  const remain = reg.remainingMs('a')
  assert.ok(remain > 3_500_000 && remain <= 3_600_000, `剩余应接近 1 小时，实际 ${remain}`)
})

// ---------- 3. chatStream 识别 200+错误信封 ----------

function fakeCredential(tag: string): WorkBuddyCredential {
  return { accessToken: `tok-${tag}`, refreshToken: '', expiresAtMs: 0, domain: 'www.codebuddy.cn', uid: tag }
}

test('chatStream：HTTP 200 + code:6004 的 JSON 应判为失败（旧版会当成 SSE 流）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(RATE_BODY, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    const r = await client.chatStream(fakeCredential('a'), '{}')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.kind, 'soft_rate')
    assert.equal(r.code, 6004)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chatStream：正常的 text/event-stream 仍判为成功', async () => {
  const originalFetch = globalThis.fetch
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = (async () => new Response(sse, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    const r = await client.chatStream(fakeCredential('a'), '{}')
    assert.equal(r.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------- 4/5/6. shim 层切号 ----------

/** 按脚本逐个返回结果的假上游：每次调用取下一个脚本项。 */
function scriptedClient(script: Array<{ kind: 'ok'; text: string } | { kind: 'fail'; status: number; body: string }>) {
  let i = 0
  const calls: string[] = []
  return {
    calls,
    async chatStream(credential: WorkBuddyCredential, _body: string) {
      calls.push(credential.accessToken)
      const step = script[Math.min(i, script.length - 1)]
      i++
      if (step === undefined || step.kind === 'ok') {
        const sse = step?.kind === 'ok' ? step.text : 'data: [DONE]\n\n'
        return { ok: true as const, response: new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
      }
      return {
        ok: false as const,
        status: step.status,
        kind: classifyUpstreamError(step.status, step.body),
        message: step.body,
        code: parseEnvelopeCode(step.body),
      }
    },
    async fetchCredits() { return { total: 0, packages: [] } },
  }
}

function storeOf(tag: string): CredentialStoreLike {
  return {
    async resolve() { return fakeCredential(tag) },
    async status(): Promise<WorkBuddyAuthStatus> { return { state: 'signed-in', region: 'cn' } },
  }
}

const fakeCatalog = { current: () => [], set: () => {} } as unknown as WorkBuddyCatalog

async function startShim(script: Parameters<typeof scriptedClient>[0], selfId: string) {
  const registry = new RateLimitRegistry(60_000)
  const a = storeOf('a')
  const b = storeOf('b')
  const shim = createWorkBuddyShim({
    region: 'cn',
    port: 0,
    token: 'test-token',
    store: selfId === 'a' ? a : b,
    client: scriptedClient(script) as never,
    catalog: fakeCatalog,
    failover: {
      selfId,
      candidates: () => [
        { id: 'a', label: '账号A', store: a },
        { id: 'b', label: '账号B', store: b },
      ],
      registry,
    },
  })
  await shim.ready
  return { shim, registry }
}

async function post(url: string, token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: res.status, body: await res.text() }
}

test('shim：账号A限流 → 自动切到账号B并成功返回', async () => {
  const { shim, registry } = await startShim([
    { kind: 'fail', status: 200, body: RATE_BODY },
    { kind: 'ok', text: 'data: {"choices":[{"delta":{"content":"from B"}}]}\n\ndata: [DONE]\n\n' },
  ], 'a')
  try {
    const r = await post(`${shim.baseUrl()}/v1/chat/completions`, 'test-token')
    assert.equal(r.status, 200, `应成功，实际 ${r.status}: ${r.body}`)
    assert.ok(r.body.includes('from B'), '应是账号B的回答')
    assert.equal(registry.isLimited('a'), true, '账号A应被记入限流')
    assert.equal(registry.isLimited('b'), false, '账号B不应被限流')
  } finally {
    await shim.close()
  }
})

test('shim：全部账号都限流 → 502/429 报错并说明已尝试切号', async () => {
  const { shim } = await startShim([
    { kind: 'fail', status: 200, body: RATE_BODY },
    { kind: 'fail', status: 200, body: RATE_BODY },
  ], 'a')
  try {
    const r = await post(`${shim.baseUrl()}/v1/chat/completions`, 'test-token')
    assert.equal(r.status, 429, `限流应映射 429，实际 ${r.status}`)
    assert.ok(r.body.includes('已尝试 2 个同区域账号'), `报错应提示已尝试切号：${r.body}`)
  } finally {
    await shim.close()
  }
})

test('shim：账号A已在冷却中 → 直接跳过A，只用B', async () => {
  const { shim, registry } = await startShim([
    { kind: 'ok', text: 'data: {"choices":[{"delta":{"content":"only B"}}]}\n\ndata: [DONE]\n\n' },
  ], 'a')
  try {
    registry.mark('a') // 预先把 A 标为限流
    const r = await post(`${shim.baseUrl()}/v1/chat/completions`, 'test-token')
    assert.equal(r.status, 200)
    assert.ok(r.body.includes('only B'), '应直接使用账号B')
  } finally {
    await shim.close()
  }
})

test('shim：非限流错误（如额度永久不足）不切号，直接报错', async () => {
  const { shim } = await startShim([
    { kind: 'fail', status: 402, body: '{"code":1,"msg":"积分不足"}' },
  ], 'a')
  try {
    const r = await post(`${shim.baseUrl()}/v1/chat/completions`, 'test-token')
    assert.equal(r.status, 402, `应保持 402，实际 ${r.status}`)
  } finally {
    await shim.close()
  }
})

test('shim：/status 暴露限流快照', async () => {
  const { shim, registry } = await startShim([
    { kind: 'ok', text: 'data: [DONE]\n\n' },
  ], 'a')
  try {
    registry.mark('b', Date.now() + 120_000)
    const res = await fetch(`${shim.baseUrl()}/status`, { headers: { Authorization: 'Bearer test-token' } })
    const j = await res.json() as { failover?: { candidates: number; rateLimited: Array<{ id: string; remainingSec: number }> } }
    assert.equal(j.failover?.candidates, 2)
    assert.equal(j.failover?.rateLimited.length, 1)
    assert.equal(j.failover?.rateLimited[0]?.id, 'b')
  } finally {
    await shim.close()
  }
})
