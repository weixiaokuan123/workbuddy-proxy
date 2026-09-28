import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toPackageViewsForTest } from '../src/shim.ts'

/**
 * 积分包明细的线上格式。
 *
 * 唯一要守住的是：**packageName 不许上行**。面板按到期日聚合、从不显示包名，
 * 而它实测占了 /status 体积增量的三分之一。更要紧的是安全：上游文本不可信，
 * 一旦它上了线，将来任何人在模板里写 title="${p.packageName}" 就是一处 XSS。
 * 「补全字段」是最容易被顺手做掉的一种改动，所以钉在这里。
 */

test('packageName 不出现在线上格式里', () => {
  const out = toPackageViewsForTest([
    { packageName: '<img src=x onerror=alert(1)>', remain: 10, size: 100, monthly: false, expiresAtMs: 1 },
  ])
  assert.equal('packageName' in out[0], false)
  assert.equal(JSON.stringify(out).includes('onerror'), false,
    '上游文本不许以任何形式出现在上行数据里')
})

test('保留聚合与展示真正需要的字段', () => {
  const out = toPackageViewsForTest([
    { packageName: 'x', remain: 10, size: 100, monthly: false, expiresAtMs: 1 },
    { packageName: 'y', remain: 20, size: 500, monthly: true, refreshAtMs: 2 },
  ])
  assert.deepEqual(out[0], { remain: 10, size: 100, monthly: false, expiresAtMs: 1 })
  assert.deepEqual(out[1], { remain: 20, size: 500, monthly: true, refreshAtMs: 2 })
})

test('undefined 时刻不写进对象（避免 JSON 里出现 null 让面板误判为"有过期时刻"）', () => {
  const out = toPackageViewsForTest([
    { packageName: 'x', remain: 1, size: 1, monthly: false },
    { packageName: 'y', remain: 1, size: 1, monthly: true },
  ])
  // 月度包没有 refreshAtMs、一次性包没有 expiresAtMs——面板靠 undefined 判断
  // 「没有到期时刻」，若变成 null 会被 typeof 检查判成 number 而错排到最前。
  assert.equal('refreshAtMs' in out[0], false)
  assert.equal('expiresAtMs' in out[0], false)
  assert.equal('refreshAtMs' in out[1], false)
  assert.equal('expiresAtMs' in out[1], false)
})

test('返回的是拷贝，不是缓存里的原对象', () => {
  // 缓存是全进程共享的；引用一旦被下游 mutate，就会污染所有并发 /status 的读数。
  const src = [{ packageName: 'x', remain: 5, size: 10, monthly: false, expiresAtMs: 1 }]
  const out = toPackageViewsForTest(src)
  assert.notEqual(out[0], src[0], '必须是新对象')
  ;(out[0] as { remain: number }).remain = 999
  assert.equal(src[0].remain, 5, '改动输出不许影响源对象')
})
