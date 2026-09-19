/**
 * 账号库凭据 store：与 LiveCredentialStore 同接口（resolve/status），
 * 但数据源是代理自有的账号库 `state/accounts.json`，而非官方 live 文件。
 *
 * 与 LiveCredentialStore 的关键差异：
 *  - 只服务**一个指定账号**（构造时给 key）；
 *  - token 刷新结果**写回账号库**（updateTokens），不回写、不触碰官方 live 文件，
 *    因此无需关闭 WorkBuddy 桌面端，也不会与客户端互相打架；
 *  - 支持多账号并行：每个账号一个 store + 一个端口。
 *
 * @module workbuddy-proxy/account-store
 */

import type { WorkBuddyAuthStatus, WorkBuddyCredential } from './auth.ts'
import { toCredential, type AccountStore, type StoredAccount } from './accounts.ts'
import type { WorkBuddyRegion, WorkBuddyRefreshOutcome } from './upstream.ts'

export interface AccountCredentialStoreOptions {
  accountKey: string
  region: WorkBuddyRegion
  accounts: AccountStore
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  refreshMarginMs?: number
}

export class AccountCredentialStore {
  private readonly accountKey: string
  private readonly region: WorkBuddyRegion
  private readonly accounts: AccountStore
  private readonly refreshFn: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  private readonly refreshMarginMs: number
  private mem: WorkBuddyCredential | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: AccountCredentialStoreOptions) {
    this.accountKey = options.accountKey
    this.region = options.region
    this.accounts = options.accounts
    this.refreshFn = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
  }

  private async read(): Promise<StoredAccount | undefined> {
    const list = await this.accounts.load()
    return list.find(a => a.key === this.accountKey)
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs === 0) return false
    return Date.now() >= credential.expiresAtMs - this.refreshMarginMs
  }

  async resolve(): Promise<WorkBuddyCredential> {
    const account = await this.read()
    if (account === undefined) {
      throw new Error(`workbuddy: 账号 ${this.accountKey} 不在账号库中（可能已被删除）`)
    }
    if (account.region !== this.region) {
      throw new Error(`workbuddy: 账号 ${account.label} 区域为 ${account.region}，该端口期望 ${this.region}`)
    }

    // 库中 token 可能已被本进程刷新写回，以库为准；同时丢弃过期内存
    const credential = toCredential(account)
    if (this.mem !== undefined && this.mem.accessToken !== credential.accessToken) {
      this.mem = undefined
      this.inflight = undefined
    }
    if (this.mem === undefined) this.mem = credential
    if (!this.needsRefresh(this.mem)) return this.mem

    this.inflight ??= this.refreshNow(this.mem).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy: 账号 ${this.accountKey} 的 access token 已过期且无 refresh token`)
    }
    try {
      const outcome = await this.refreshFn(credential)
      const expiresAtMs = outcome.expiresInSec !== undefined
        ? Date.now() + outcome.expiresInSec * 1000
        : credential.expiresAtMs
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      }
      this.mem = refreshed
      // 写回账号库（仅库内，不碰官方 live 文件）
      await this.accounts.updateTokens(this.accountKey, {
        accessToken: refreshed.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs,
      }).catch(() => { /* 写回失败不影响本次请求 */ })
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy: 账号 ${this.accountKey} token 刷新失败（${String(error)}）`)
    }
  }

  /** 只读状态摘要，不刷新、不抛错。 */
  async status(): Promise<WorkBuddyAuthStatus> {
    const account = await this.read()
    if (account === undefined) {
      return { state: 'signed-out', region: this.region, message: '账号已被删除' }
    }
    const expired = account.expiresAtMs !== 0 && Date.now() >= account.expiresAtMs
    return {
      state: expired ? 'signed-out' : 'signed-in',
      region: this.region,
      account: account.nickname ?? account.uin ?? account.label,
      ...account.uin === undefined ? {} : { uin: account.uin },
      domain: account.domain,
      expiresAtMs: account.expiresAtMs,
      ...expired ? { message: 'access token 已过期（将在下次请求时自动刷新）' } : {},
    }
  }
}
