import assert from 'node:assert/strict'
import { test } from 'node:test'
import { targetsForRegion, targetsExcept } from '../src/signin-region.ts'

/**
 * 回归护栏：账号卡片曾把别的区域的账号列出来。
 *
 * 真实后果有两层，展示错位只是表面——在国际版点「立即签到」还会顺带领取
 * 国内账号的积分。所以这里钉的是「按区域出口绝不越界」，而不是某个快照。
 */

const T = [
  { id: 'live-cn', label: 'cn·当前登录', region: 'cn' as const },
  { id: 'live-global', label: 'global·当前登录', region: 'global' as const },
  { id: 'acct:1', label: 'cn·示例昵称甲', region: 'cn' as const },
  { id: 'acct:2', label: 'cn·13800138002', region: 'cn' as const },
  { id: 'acct:3', label: 'cn·13800138001', region: 'cn' as const },
  { id: 'acct:4', label: 'cn·13800138003', region: 'cn' as const },
]

test('cn 出口只给 cn 目标，一个 global 都不许混进来', () => {
  const got = targetsForRegion(T, 'cn')
  assert.equal(got.length, 5)
  assert.ok(got.every(t => t.region === 'cn'))
  assert.ok(!got.some(t => t.id === 'live-global'), 'live-global 不该出现在 cn 出口')
})

test('global 出口只给 global 目标，不含任何 cn 账号', () => {
  const got = targetsForRegion(T, 'global')
  assert.deepEqual(got.map(t => t.id), ['live-global'])
  assert.ok(!got.some(t => t.label.startsWith('cn·')))
})

test('两个出口合起来恰好覆盖全表（过滤不能漏也不能重）', () => {
  const cn = targetsForRegion(T, 'cn')
  const global = targetsForRegion(T, 'global')
  assert.equal(cn.length + global.length, T.length)
  assert.equal(new Set([...cn, ...global].map(t => t.id)).size, T.length)
})

test('兜底领取时排除端口自身', () => {
  assert.deepEqual(targetsExcept(targetsForRegion(T, 'cn'), 'live-cn').map(t => t.id), [
    'acct:1', 'acct:2', 'acct:3', 'acct:4',
  ])
  // 顺序保持不变（领取是按顺序逐个来的）
  assert.deepEqual(targetsExcept(targetsForRegion(T, 'cn'), 'acct:2').map(t => t.id),
    ['live-cn', 'acct:1', 'acct:3', 'acct:4'])
})

test('空表与不存在的区域不报错', () => {
  assert.deepEqual(targetsForRegion([], 'cn'), [])
  assert.deepEqual(targetsExcept([], 'x'), [])
})

test('不会改动入参（原表是共享状态，被就地排序会连带影响后台 tick）', () => {
  const snapshot = T.map(t => t.id)
  targetsForRegion(T, 'cn')
  targetsExcept(T, 'live-cn')
  assert.deepEqual(T.map(t => t.id), snapshot)
})
