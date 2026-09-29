import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { buildAttempts, SELF_PROBE_MS, type SelfHealth } from '../src/shim.ts'

/**
 * 两条修复的回归护栏。
 *
 * 1) 面板里那条重启命令曾被**硬编码**成 `%USERPROFILE%\.config\opencode\agent-hub`，
 *    而正确的 `selfRestartHint()` 却从没被调用过——同一份信息两份实现。别人把
 *    agent-hub 装在别的路径时，面板会给出一条跑不通的命令。
 *
 * 2) live 凭据自 2026-09 起被桌面端加密，`resolve()` 必然失败，而它又**无条件排第一**。
 *    实测每个请求的日志都是「第 2/5 个」——你日常每一次调用都先撞一次注定失败的尝试。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, '..', 'agent-hub', 'public', 'index.html'), 'utf8')

// ---------- 1) 面板不得硬编码安装路径 ----------

test('面板里不得再出现硬编码的 USERPROFILE 安装路径', () => {
  // 路径必须来自服务端；硬编码会在换安装目录时给出错误命令
  assert.ok(!html.includes('USERPROFILE'),
    'index.html 里仍有硬编码的 %USERPROFILE% 路径，重启命令应改由服务端下发')
})

test('面板要从服务端的字段渲染那条命令', () => {
  assert.match(html, /selfRestart/,
    '面板应读取服务端下发的重启说明，而不是自己拼')
})

// ---------- 2) live 解不开就不该先试 ----------

const cands = [
  { id: 'live-cn', label: 'cn·当前登录', store: {} },
  { id: 'acct:a', label: 'cn·甲', store: {} },
  { id: 'acct:b', label: 'cn·乙', store: {} },
]
const deps = (limited: Record<string, boolean> = {}) => ({
  candidates: () => cands,
  registry: { isLimited: (id: string) => !!limited[id], remainingMs: () => 0 },
})

test('默认（未探明）时 self 仍然排第一——不改变既有语义', () => {
  const r = buildAttempts({ selfId: 'live-cn', ...deps(), health: { selfBroken: false, nextProbeAtMs: 0 }, nowMs: 1000 })
  assert.equal(r[0].id, 'live-cn')
})

test('已知 self 解不开时跳过它，池子账号直接上', () => {
  const health: SelfHealth = { selfBroken: true, nextProbeAtMs: 60_000 }
  const r = buildAttempts({ selfId: 'live-cn', ...deps(), health, nowMs: 1000 })
  assert.ok(!r.some(a => a.id === 'live-cn'), '已知不可用就不该再排它')
  assert.equal(r[0].id, 'acct:a', '应直接落到池子第一个')
})

test('到达重探时间后 self 回到队首（桌面端重新登录能被立刻发现）', () => {
  const health: SelfHealth = { selfBroken: true, nextProbeAtMs: 60_000 }
  const before = buildAttempts({ selfId: 'live-cn', ...deps(), health, nowMs: 59_999 })
  assert.ok(!before.some(a => a.id === 'live-cn'), '未到重探时间仍应跳过')
  const after = buildAttempts({ selfId: 'live-cn', ...deps(), health, nowMs: 60_000 })
  assert.equal(after[0].id, 'live-cn', '到点后必须重探，否则重新登录的 live 永远用不上')
})

test('被限流的池子账号仍然排末尾——跳过 self 不能破坏原排序', () => {
  const health: SelfHealth = { selfBroken: true, nextProbeAtMs: 60_000 }
  const r = buildAttempts({ selfId: 'live-cn', ...deps({ 'acct:a': true }), health, nowMs: 1000 })
  assert.equal(r[r.length - 1].id, 'acct:a', '限流中的账号必须垫底')
})

test('self 恰好是唯一候选时不能被跳过（否则无号可用）', () => {
  const health: SelfHealth = { selfBroken: true, nextProbeAtMs: 60_000 }
  const r = buildAttempts({
    selfId: 'live-cn',
    candidates: () => [cands[0]!],
    registry: { isLimited: () => false, remainingMs: () => 0 },
    health, nowMs: 1000,
  })
  assert.equal(r.length, 1, '不能返回空候选列表')
  assert.equal(r[0].id, 'live-cn')
})

test('重探间隔是有限的正值（不能为 0，否则等于没跳过）', () => {
  assert.ok(SELF_PROBE_MS >= 30_000, `重探间隔 ${SELF_PROBE_MS}ms 太短，等于每次都白试一次`)
  assert.ok(SELF_PROBE_MS <= 10 * 60_000, `重探间隔 ${SELF_PROBE_MS}ms 太长，重新登录后要等太久`)
})
