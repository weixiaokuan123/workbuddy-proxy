import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redact, redactIdentity, redactPaths, registerIdentities, resetIdentitiesForTest } from '../src/redact.ts'

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

// ---- 已知身份注册表：中文昵称的防线 ----
// 正则拦不住中文昵称（形态不可识别），只能靠注册表。这里是它的全部行为约定。
// 昵称测试值全部是编造的中文词组，与本机真实账号无关。

test('注册表：中文昵称被替换', () => {
  resetIdentitiesForTest()
  registerIdentities(['山高水远'])
  assert.equal(redactIdentity('workbuddy(cn·山高水远) 旅行：今日已派'),
    'workbuddy(cn·山***远) 旅行：今日已派')
  resetIdentitiesForTest()
})

test('注册表：未注册的昵称不受影响（由正则兜底手机号/邮箱）', () => {
  resetIdentitiesForTest()
  assert.equal(redactIdentity('cn·某个未注册的昵称'), 'cn·某个未注册的昵称')
})

test('注册表：长键优先，短键不把长键切残', () => {
  resetIdentitiesForTest()
  // 假设同时注册了「水远」与「山高水远」：必须先替换长的
  registerIdentities(['水远', '山高水远'])
  const out = redactIdentity('账号 山高水远 已切换')
  assert.ok(!out.includes('山高水远'), '长键必须被整体替换')
  assert.ok(!out.includes('水远'), '短键也不该残留在输出里')
  resetIdentitiesForTest()
})

test('注册表：空值与单字符被忽略（防误吞正文）', () => {
  resetIdentitiesForTest()
  registerIdentities(['', undefined, null, 'a', ' '])
  assert.equal(redactIdentity('a quick brown fox'), 'a quick brown fox')
  resetIdentitiesForTest()
})

test('注册表：手机号仍走正则（注册表与正则共存不冲突）', () => {
  resetIdentitiesForTest()
  // 手机号即使没注册过，也要被正则拦住
  assert.equal(redactIdentity('cn·13800138001'), 'cn·138****01')
})

test('注册表：注册过的手机号也被打码（格式不要求统一）', () => {
  resetIdentitiesForTest()
  // 手机号形态被注册表跳过（正则兜底会给 138****01 这种更好的掩码），
  // 所以注册前后行为一致
  registerIdentities(['13800138001'])
  assert.equal(redactIdentity('cn·13800138001'), 'cn·138****01')
  resetIdentitiesForTest()
})

test('注册表：redact 出口同样过注册表（覆盖 fmtLogArgs 路径）', () => {
  resetIdentitiesForTest()
  registerIdentities(['山高水远'])
  const out = redact('workbuddy(cn·山高水远) 读取 C:\\Users\\SomeUser\\a.key')
  assert.ok(!out.includes('山高水远'), '昵称应被打码')
  assert.ok(!out.includes('SomeUser'), '路径应被脱敏')
  resetIdentitiesForTest()
})
