/**
 * WorkBuddy 多账号库。
 *
 * 目标：让代理自带多账号能力，取代外部 workbuddy-switch App。
 *
 * 设计要点：
 *  - 账号库为代理自有文件 `state/accounts.json`（数组，粒度=账号+区域）；
 *  - **完全兼容** workbuddy-switch 的 `~/.wb-switch/accounts.json` 格式，
 *    可直接导入（字段：id/uid/access_token/refresh_token/domain/variant/expiresAt…）；
 *  - 各账号的 access/refresh token 存库内，代理按账号独立刷新（refresh 结果写回库，
 *    而不是写官方 live 文件），因此**不需要关闭 WorkBuddy 客户端**；
 *  - 每个账号 + 区域对应一个回环端口，opencode 侧即多个 provider，可并行使用。
 *
 * 安全：账号库落在 `state/`（已 gitignore），绝不出现在源码或仓库中。
 *
 * @module workbuddy-proxy/accounts
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseWorkBuddyAuth, type WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyRegion } from './upstream.ts'

export interface StoredAccount {
  /** 稳定主键：uid（无则 id/域名+序号）。 */
  key: string
  /** 展示名：nickname / uin / uid。 */
  label: string
  region: WorkBuddyRegion
  domain: string
  uid: string
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  enterpriseId?: string
  nickname?: string
  uin?: string
  /** 来源：'switch'（从 workbuddy-switch 导入）| 'live'（抓取当前登录态）| 'manual' */
  source: 'switch' | 'live' | 'manual'
  createdAtMs: number
  /** 最近一次由本代理刷新写回的时间。 */
  refreshedAtMs?: number
}

/** 区域 → 默认域名后缀提示（仅用于推断 region）。 */
export function regionOfDomain(domain: string): WorkBuddyRegion {
  const d = domain.trim().toLowerCase()
  if (d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai') || d.endsWith('workbuddy.ai')) return 'global'
  return 'cn'
}

function accountKey(region: WorkBuddyRegion, uid: string, domain: string): string {
  return uid !== '' ? `${region}:${uid}` : `${region}:${domain}`
}

/** 从 WorkBuddyCredential 构造库记录。 */
export function toStored(
  credential: WorkBuddyCredential,
  region: WorkBuddyRegion,
  source: StoredAccount['source'],
): StoredAccount {
  const uid = credential.uid !== '' ? credential.uid : ''
  return {
    key: accountKey(region, uid, credential.domain),
    label: credential.nickname ?? credential.uin ?? (uid !== '' ? uid : credential.domain) ?? 'unknown',
    region,
    domain: credential.domain,
    uid,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
    ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
    ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
    ...credential.uin === undefined ? {} : { uin: credential.uin },
    source,
    createdAtMs: Date.now(),
  }
}

/** 把库记录转成代理内部使用的凭证形态。 */
export function toCredential(account: StoredAccount): WorkBuddyCredential {
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAtMs: account.expiresAtMs,
    ...account.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: account.refreshExpiresAtMs },
    domain: account.domain,
    uid: account.uid,
    ...account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId },
    ...account.nickname === undefined ? {} : { nickname: account.nickname },
    ...account.uin === undefined ? {} : { uin: account.uin },
    ...account.refreshedAtMs === undefined ? {} : { lastRefreshAtMs: account.refreshedAtMs },
  }
}

/**
 * 去除「与 live 登录态是同一个账号」的库记录。
 *
 * 场景：`state/accounts.json` 由 workbuddy-switch 导入，可能包含当前官方客户端
 * 正在登录的那个账号。若不去重，池化入口会把同一个账号算作两个候选，
 * 既浪费切换机会（撞限流后"换号"其实还换到自己），又会让面板把余额算两遍。
 *
 * 判定优先级：uid 完全相同 > (domain + account/uin) 相同。
 * live 凭证优先保留（token 最新鲜），库中重复项被剔除。
 *
 * @param liveKeys  live 登录态的判定键集合（由 `identityKeysOf` 生成）
 * @param accounts 账号库记录
 */
export function dropLiveDuplicates(
  liveKeys: ReadonlySet<string>,
  accounts: readonly StoredAccount[],
): StoredAccount[] {
  if (liveKeys.size === 0) return [...accounts]
  return accounts.filter(a => {
    for (const key of identityKeysOfRecord(a)) {
      if (liveKeys.has(key)) return false
    }
    return true
  })
}

/**
 * 生成一条库记录的账号身份键（可能多个，用于宽松比对）。
 * `uid` 是权威主键；`domain:account` 用于 uid 缺失时兜底。
 */
export function identityKeysOfRecord(a: Pick<StoredAccount, 'region' | 'uid' | 'domain' | 'label' | 'nickname' | 'uin'>): string[] {
  const keys: string[] = []
  if (a.uid !== '') keys.push(`${a.region}:uid:${a.uid}`)
  const name = a.uin ?? a.nickname ?? a.label
  if (name !== undefined && name !== '') keys.push(`${a.region}:name:${name}`)
  return keys
}

/** 生成 live 凭证的账号身份键；与 `identityKeysOfRecord` 同构，可直接比较。 */
export function identityKeysOfCredential(
  region: WorkBuddyRegion,
  c: Pick<WorkBuddyCredential, 'uid' | 'nickname' | 'uin'>,
): string[] {
  const keys: string[] = []
  if (c.uid !== undefined && c.uid !== '') keys.push(`${region}:uid:${c.uid}`)
  const name = c.uin ?? c.nickname
  if (name !== undefined && name !== '') keys.push(`${region}:name:${name}`)
  return keys
}

/** workbuddy-switch accounts.json 的单条记录形态（宽松）。 */
interface SwitchAccount {
  id?: unknown
  uid?: unknown
  email?: unknown
  nickname?: unknown
  variant?: unknown
  domain?: unknown
  access_token?: unknown
  refresh_token?: unknown
  expiresAt?: unknown
  refreshExpiresAt?: unknown
  token_type?: unknown
  enterpriseId?: unknown
  auth_raw?: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

/**
 * 解析 workbuddy-switch 的 accounts.json 为库记录。
 * 缺 access_token 的记录会被跳过。
 */
export function parseSwitchAccounts(text: string): StoredAccount[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: StoredAccount[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as SwitchAccount

    // 优先用 auth_raw 里的完整文档（含 expiresAt 等权威字段），退回扁平字段
    let credential: WorkBuddyCredential | undefined
    if (typeof a.auth_raw === 'object' && a.auth_raw !== null) {
      credential = parseWorkBuddyAuth(JSON.stringify(a.auth_raw), '<switch>')
    }
    const accessToken = str(a.access_token)
    if (credential === undefined && accessToken === '') continue

    const domain = credential?.domain || str(a.domain)
    const variant = str(a.variant)
    const region: WorkBuddyRegion = variant === 'global' ? 'global' : (variant === 'cn' ? 'cn' : regionOfDomain(domain))
    const uid = credential?.uid || str(a.uid)
    const merged: WorkBuddyCredential = credential ?? {
      accessToken,
      refreshToken: str(a.refresh_token),
      expiresAtMs: num(a.expiresAt),
      ...num(a.refreshExpiresAt) === 0 ? {} : { refreshExpiresAtMs: num(a.refreshExpiresAt) },
      domain,
      uid,
    }
    // auth_raw 可能缺 refreshToken（switch 把它存平铺字段），这里补齐
    if (merged.refreshToken === '' && str(a.refresh_token) !== '') merged.refreshToken = str(a.refresh_token)
    if (merged.expiresAtMs === 0 && num(a.expiresAt) !== 0) merged.expiresAtMs = num(a.expiresAt)
    if (merged.refreshExpiresAtMs === undefined && num(a.refreshExpiresAt) !== 0) {
      merged.refreshExpiresAtMs = num(a.refreshExpiresAt)
    }
    if (merged.nickname === undefined && str(a.nickname) !== '') merged.nickname = str(a.nickname)
    if (merged.uid === '' && str(a.uid) !== '') merged.uid = str(a.uid)

    const stored = toStored(merged, region, 'switch')
    // 用 switch 自己的 id 作为 key 更稳定（同名账号也能区分）
    if (str(a.id) !== '') stored.key = `switch:${str(a.id)}`
    out.push(stored)
  }
  return out
}

/** workbuddy-switch 账号库默认路径。 */
export function switchAccountsPath(home: string = homedir()): string {
  return join(home, '.wb-switch', 'accounts.json')
}

export class AccountStore {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<StoredAccount[]> {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((a): a is StoredAccount =>
        typeof a === 'object' && a !== null && typeof (a as StoredAccount).key === 'string')
    } catch {
      return []
    }
  }

  async save(accounts: StoredAccount[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(accounts, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }

  /** 按 key 插入或覆盖。 */
  async upsert(account: StoredAccount): Promise<{ added: boolean }> {
    const list = await this.load()
    const i = list.findIndex(a => a.key === account.key)
    const added = i === -1
    if (added) list.push(account)
    else list[i] = { ...account, createdAtMs: list[i]?.createdAtMs ?? account.createdAtMs }
    await this.save(list)
    return { added }
  }

  async remove(key: string): Promise<boolean> {
    const list = await this.load()
    const next = list.filter(a => a.key !== key)
    if (next.length === list.length) return false
    await this.save(next)
    return true
  }

  /** 刷新后写回 token（不回写官方 live 文件）。 */
  async updateTokens(key: string, tokens: { accessToken: string; refreshToken?: string; expiresAtMs: number }): Promise<void> {
    const list = await this.load()
    const a = list.find(x => x.key === key)
    if (a === undefined) return
    a.accessToken = tokens.accessToken
    if (tokens.refreshToken !== undefined && tokens.refreshToken !== '') a.refreshToken = tokens.refreshToken
    a.expiresAtMs = tokens.expiresAtMs
    a.refreshedAtMs = Date.now()
    await this.save(list)
  }
}
