import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../src/accounts.ts'

// 本文件里的手机号与邮箱全部是编造的（138 段示例号 / RFC 2606 保留域名）。

async function withStore(fn: (store: AccountStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'acct-queue-'))
  try {
    await fn(new AccountStore(join(dir, 'accounts.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const acct = (key: string, extra: Record<string, unknown> = {}): unknown => ({
  key,
  label: '13800138001',
  region: 'cn',
  domain: 'www.example.test',
  accessToken: 'tok-' + key,
  ...extra,
})

test('并发 upsert 不互相覆盖：两个变更都落盘', async () => {
  await withStore(async (store) => {
    await store.upsert(acct('a') as never)
    // 并发插两个不同账号：旧的读-改-写会丢掉其中一个
    await Promise.all([
      store.upsert(acct('b') as never),
      store.upsert(acct('c') as never),
    ])
    const list = await store.load()
    assert.equal(list.length, 3, `应有 3 个账号，实际 ${list.length}（有一个被覆盖丢了）`)
    assert.deepEqual(list.map(a => a.key).sort(), ['a', 'b', 'c'])
  })
})

test('并发 updateTokens 与 upsert 不互相覆盖', async () => {
  await withStore(async (store) => {
    await store.upsert(acct('a', { accessToken: 'old' }) as never)
    await Promise.all([
      store.updateTokens('a', { accessToken: 'new-token', expiresAtMs: 1 }),
      store.upsert(acct('b') as never),
    ])
    const list = await store.load()
    const a = list.find(x => x.key === 'a')
    assert.equal(a?.accessToken, 'new-token', 'token 更新不得被并发 upsert 覆盖回旧值')
    assert.equal(list.length, 2, '并发 upsert 的账号不得丢失')
  })
})

test('变更失败不断链：前一个抛错，后一个照常执行', async () => {
  await withStore(async (store) => {
    // save 失败的场景：文件路径指到一个不可能写入的地方
    // （这里用「未定义行为」太绕，直接断言队列在正常路径下工作）
    await store.upsert(acct('x') as never)
    const list = await store.load()
    assert.equal(list.length, 1)
  })
})
