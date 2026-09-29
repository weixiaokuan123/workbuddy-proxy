import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SigninScheduler } from '../src/scheduler.ts'

/**
 * 签到调度器的**丢状态**问题。
 *
 * ## 实测到的现象
 *
 * 重启 workbuddy-proxy 后，面板先显示 0/5，约 60 秒后自己跳回 4/5：
 *
 *     +  5s  0/5 [·····]
 *     ...
 *     + 55s  0/5 [·····]
 *     + 60s  2/5 [·✓✓··]      ← SIGNIN_INITIAL_DELAY_MS = 60_000
 *     + 65s  4/5 [·✓✓✓✓]
 *
 * 也就是说：**重启会把当天已签的状态抹掉，靠 60 秒后重新真签一遍补回来。**
 * 代价不只是面板难看——还白白消耗上游接口调用。
 *
 * ## 根因
 *
 * `schedulerOf(region)` 写成了 `=> new SigninScheduler({...})`，**没有 memoize**。
 * cn 区有 1 个 live + 4 个账号，于是同一个 `signin-state-cn.json` 被
 * 5 个各自独立的 scheduler 实例各持一份内存副本。
 *
 * 而 `save()` 是 `writeFile(整个 store)` —— 整份覆盖写。实例 A 保存时会把
 * 实例 B 的条目一起盖掉（丢更新）。L276 的注释其实写明了要避免这个：
 *
 *     「同一区域内的 live 与账号共用一份…不同区域分开——否则两个调度器各持
 *       内存副本整体回写时会互相覆盖（丢更新）」
 *
 * 意图是一份，实现却是五份。
 *
 * 雪上加霜的是 `load()`：读文件或 JSON 解析失败时**静默当成空 store**。
 * 一旦某个实例读到半截文件，`store = {}`，随后 `plan()` 因为
 * `before !== entry` 而保存，把全天状态覆写成全 false。
 *
 * 两条合起来，就是那个 0/5。
 */

const dir = () => mkdtemp(join(tmpdir(), 'signin-sched-'))
const opts = stateFile => ({ stateFile, startHour: 0, endHour: 23 })

/** 与 scheduler 内部 localDate() 同口径（本机时区）。该函数未导出，故在此复刻。 */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- 核心：多实例共用一个状态文件 ----------

test('【前提】多个实例共用一个状态文件会丢数据——所以必须靠 serve.ts 去 memoize', async () => {
  // 这条测试**故意断言缺陷存在**。它不是要修 SigninScheduler 类，而是钉住一个事实：
  // 类的 save() 是 writeFile(整个 store)，没有跨实例合并，所以「同一个 stateFile
  // 只能有一个实例」是**调用方的硬约束**，不是类自己保证的性质。
  // 有了它，谁再把 serve.ts 的 memoize 删掉，下一条测试会立刻解释为什么不能删。
  const d = await dir()
  const f = join(d, 'state.json')
  try {
    const a = new SigninScheduler(opts(f))
    const b = new SigninScheduler(opts(f))
    // 两边的 load() 都发生在**任何一次 save 之前**——启动时的真实情形。
    // 串行地先 a.save() 再 b.load() 是测不出来的：那样 b 会读到 a 写的东西。
    await a.entry('warmup')
    await b.entry('warmup')

    await a.plan('acct:1')
    ;(await a.entry('acct:1'))!.claimed = true
    await a.save()

    await b.plan('acct:2')
    ;(await b.entry('acct:2'))!.claimed = true
    await b.save()

    const onDisk = JSON.parse(await readFile(f, 'utf8'))
    assert.equal(onDisk['acct:1'], undefined,
      'a 的条目确实被 b 的整体回写抹掉了——这就是原来 0/5 的机制')
    assert.equal(onDisk['acct:2']?.claimed, true, '只剩最后写入的那个')
  } finally { await rm(d, { recursive: true, force: true }) }
})

test('serve.ts 的 schedulerOf 必须按区域 memoize（真正的修复点）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join: j } = await import('node:path')
  const src0 = readFileSync(j(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'serve.ts'), 'utf8')
  // 必须先剥注释：修复说明里**字面写着** `=> new SigninScheduler({...})`，
  // 不剥的话这段注释会被当成第二个实例，测试自己先红。
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  // 1. 必须有缓存容器
  assert.match(src, /schedulerByRegion\s*=\s*new Map/, '缺少按区域的缓存容器')

  // 2. schedulerOf 必须先查缓存
  const body = src.slice(src.indexOf('const schedulerOf'))
  const fn = body.slice(0, body.indexOf('\n  }'))
  assert.match(fn, /schedulerByRegion\.get\(region\)/, 'schedulerOf 没有查缓存，等于每次都 new')
  assert.match(fn, /schedulerByRegion\.set\(region,/, 'schedulerOf 没有写回缓存')
  assert.match(fn, /return cached/, 'schedulerOf 命中缓存时没有返回同一个实例')

  // 3. 不能再出现裸的 `=> new SigninScheduler`
  assert.ok(!/=>\s*new SigninScheduler/.test(src),
    '还有地方直接 `=> new SigninScheduler`，同一文件会出现第二个实例')

  // 4. 三个调用点都必须经过 schedulerOf，而不是自己 new
  const news = src.match(/new SigninScheduler/g) || []
  assert.equal(news.length, 1, `应只有 schedulerOf 内部这一处 new SigninScheduler，实际 ${news.length} 处`)
})

// ---------- 正确做法：单实例 ----------

test('同一区域共用一个实例时，状态不会被自己抹掉', async () => {
  const d = await dir()
  const f = join(d, 'state.json')
  try {
    // 模拟修复后的 schedulerOf：一次 new，多处引用
    const shared = new SigninScheduler(opts(f))
    const targets = ['live-cn', 'a', 'b', 'c', 'd']

    for (const t of targets) {
      await shared.plan(t)
      const e = await shared.entry(t)
      e!.claimed = true
    }
    await shared.save()

    // 重开一个实例读回来（模拟重启）
    const after = new SigninScheduler(opts(f))
    let ok = 0
    for (const t of targets) if ((await after.entry(t))?.claimed === true) ok++
    assert.equal(ok, 5, `重启后应读回 5 条 claimed，实际 ${ok}`)
  } finally { await rm(d, { recursive: true, force: true }) }
})

// ---------- load() 不能静默抹数据 ----------

test('状态文件是坏 JSON 时，不能当成空 store（否则全天状态被抹）', async () => {
  const d = await dir()
  const f = join(d, 'state.json')
  try {
    await writeFile(f, '{ 这不是合法 JSON', 'utf8')
    const s = new SigninScheduler(opts(f))
    // 关键：不能悄悄变成空。必须是「报错」或「保留原样」，绝不是「当成没有」。
    let result: unknown = 'no-throw'
    try { result = await s.entry('t1') } catch (e) { result = e }
    // entry() 在拿不到时返回 undefined 是正常的（今天没这个 target），
    // 但绝不能把**已存在的**条目当成不存在后重新生成 claimed:false 覆盖磁盘。
    await s.plan('t1').catch(() => {})
    const onDisk = await readFile(f, 'utf8')
    assert.equal(onDisk, '{ 这不是合法 JSON',
      '坏文件不得被 plan() 用空 store 覆写——那会抹掉真实数据')
  } finally { await rm(d, { recursive: true, force: true }) }
})

test('文件不存在是正常情况，可以从零建（不能和「读失败」混为一谈）', async () => {
  const d = await dir()
  const f = join(d, 'not-there.json')
  try {
    const s = new SigninScheduler(opts(f))
    const p = await s.plan('t1')
    assert.equal(p.date, today(), '首次运行应按今天生成计划')
    assert.equal(p.claimed, false)
    const onDisk = JSON.parse(await readFile(f, 'utf8'))
    assert.equal(Object.keys(onDisk).length, 1, '应写入 1 条')
  } finally { await rm(d, { recursive: true, force: true }) }
})

// ---------- 回归：既有行为不变 ----------

test('同日重复 plan() 不会重摇时刻（同一条返回同一对象）', async () => {
  const d = await dir()
  const f = join(d, 'state.json')
  try {
    const s = new SigninScheduler(opts(f))
    const a = await s.plan('t1')
    const b = await s.plan('t1')
    assert.equal(a, b, '同日应返回同一对象，不重建')
    assert.equal(a.runAtSec, b.runAtSec, '时刻不能变')
  } finally { await rm(d, { recursive: true, force: true }) }
})

test('claimed=true 的条目 plan() 之后仍是 true（这是重启必须成立的前提）', async () => {
  const d = await dir()
  const f = join(d, 'state.json')
  try {
    const s = new SigninScheduler(opts(f))
    const p = await s.plan('t1')
    p.claimed = true
    await s.save()

    // 模拟重启：全新实例读盘 -> plan -> entry
    const fresh = new SigninScheduler(opts(f))
    const p2 = await fresh.plan('t1')
    assert.equal(p2.claimed, true, '重启后 claimed 必须还在')
    assert.equal((await fresh.entry('t1'))?.claimed, true)
  } finally { await rm(d, { recursive: true, force: true }) }
})
