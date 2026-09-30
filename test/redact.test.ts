import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redact, redactIdentity, redactPaths } from '../src/redact.ts'

// 本文件里的手机号与邮箱**全部是编造的**。
// 脱敏测试需要「看起来像真号」的输入才有效，但绝不能用本机真实账号的数据——
// 这些文件是公开仓库的一部分。

test('手机号打码：保留前 3 后 2', () => {
  assert.equal(redactIdentity('workbuddy(cn·13800138001) 今日签到计划 08:21'),
    'workbuddy(cn·138****01) 今日签到计划 08:21')
  // 13800138002 -> 前 3 位 138 + 后 2 位 02
  assert.equal(redactIdentity('13800138002'), '138****02')
})

test('不在更长的数字串里误匹配（订单号/时间戳不受影响）', () => {
  assert.equal(redactIdentity('order 123456789012'), 'order 123456789012')
  assert.equal(redactIdentity('ts 1380013800100'), 'ts 1380013800100')
})

test('短数字与版本号不受影响', () => {
  assert.equal(redactIdentity('账号库 4 个账号'), '账号库 4 个账号')
  assert.equal(redactIdentity('剩 12 分钟 / 8:00-23:00'), '剩 12 分钟 / 8:00-23:00')
  assert.equal(redactIdentity('workbuddy-proxy 1.3.15'), 'workbuddy-proxy 1.3.15')
  assert.equal(redactIdentity('1/2 就绪'), '1/2 就绪')
})

test('邮箱打码：保留首字符与域名', () => {
  assert.equal(redactIdentity('已切换 sampleuser7@example.net 完成'),
    '已切换 s***@example.net 完成')
  assert.equal(redactIdentity('a.b+tag@example.co.uk'), 'a***@example.co.uk')
})

test('脱敏幂等：同一文本处理两次结果一致', () => {
  const raw = 'cn·13800138001 与 x@y.com 与 C:\\Users\\Someone\\a.key'
  assert.equal(redact(redact(raw)), redact(raw))
})

test('redact 组合路径与身份', () => {
  const out = redact('workbuddy(cn·13800138001) 读取 C:\\Users\\SomeUser\\a.key 失败 sampleuser7@example.net')
  assert.ok(!out.includes('13800138001'), '手机号应被打码')
  assert.ok(!out.includes('SomeUser'), '用户名应被脱敏')
  assert.ok(!out.includes('sampleuser7'), '邮箱应被打码')
})

test('redactPaths 仍然只处理路径', () => {
  const out = redactPaths('C:\\Users\\SomeUser\\.config\\x.key')
  assert.ok(!out.includes('SomeUser'))
  assert.ok(out.includes('.config'), '文件名应保留，否则没法排错')
  // 路径脱敏不应影响手机号（那是 redactIdentity 的职责）
  assert.ok(redactPaths('13800138001').includes('13800138001'))
})
