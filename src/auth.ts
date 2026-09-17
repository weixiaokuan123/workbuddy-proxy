/**
 * 精简版 WorkBuddy 凭据解析（独立 OpenAI 兼容代理用）。
 *
 * 改自 dingminhua/dsh-connect-workbuddy/src/auth.ts（MIT，Copyright (c) 2026 LaoDing），
 * 其设计又源自 corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）。
 *
 * 相对原版的刻意简化（为配合 workbuddy-switch 一类“写 live 文件切号”的工具）：
 *  - 只读对应区域的“当前登录态”单一文件，不再扫描历史时间戳备份；
 *  - cn 读 workbuddy-desktop.info，global 读 workbuddy-desktop-ai.info
 *    （原版把 -ai.info 误当备份、且永远让 .info 压过它）；
 *  - 每次调用都实时重读文件，无缓存、无 mtime/hash 门禁——外部切号写文件后，
 *    下一次请求立即跟随；
 *  - 不做多账号选择、不做 selected 锁定；
 *  - token 刷新结果只保存在进程内存，绝不写回桌面端文件，也不落地任何副本；
 *  - 去掉 @deepseek-ai/dsh-home-paths 与 @deepseek-ai/dsh-atomic-write 两个依赖。
 *
 * @module workbuddy-proxy/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { regionOf, type WorkBuddyRefreshOutcome, type WorkBuddyRegion } from './upstream.ts'

/** 规范化后的 WorkBuddy 凭据，时间戳均为 epoch 毫秒。 */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  uin?: string
  /** 最近一次上游签发时间（auth.lastRefreshTime），唯一可信的新鲜度信号。 */
  lastRefreshAtMs?: number
}

/** 只读登录摘要，供 /status 使用。 */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  region: WorkBuddyRegion
  account?: string
  uin?: string
  domain?: string
  filePath?: string
  expiresAtMs?: number
  message?: string
}

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 各平台桌面端 auth 目录候选（探测顺序）。 */
export function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/** 每个区域对应的 live 文件名。 */
const LIVE_FILENAME: Record<WorkBuddyRegion, string> = {
  cn: 'workbuddy-desktop.info',
  global: 'workbuddy-desktop-ai.info',
}

/** 每区域覆盖 live 文件路径的环境变量。 */
const AUTH_FILE_ENV: Record<WorkBuddyRegion, string> = {
  cn: 'WORKBUDDY_CN_AUTH_FILE',
  global: 'WORKBUDDY_GLOBAL_AUTH_FILE',
}

/** 兼容原插件的单一覆盖变量（两区域都会参考，区域专属变量优先）。 */
const LEGACY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** 秒/毫秒归一化。 */
export function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析 WorkBuddy auth 文档，兼容嵌套形态 {auth, account} 与扁平形态。
 * 无 accessToken 时返回 undefined。
 */
export function parseWorkBuddyAuth(text: string, filePath: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number'
    ? expiryToMs(auth['refreshExpiresAt'])
    : undefined
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number'
    ? expiryToMs(auth['lastRefreshTime'])
    : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const uin = optionalString(identity['uin'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
  }
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Store 构造参数。 */
export interface LiveStoreOptions {
  region: WorkBuddyRegion
  /** 上游 token 刷新函数。 */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** 显式 live 文件路径，优先于环境变量与平台默认。 */
  livePath?: string
  /** 提前刷新余量，默认 5 分钟。 */
  refreshMarginMs?: number
}

/**
 * 单区域、单 live 文件的凭据 store。
 *
 * 每次 current()/resolve() 都重新读盘，因此 workbuddy-switch 改写 live 文件后
 * 无需重启即可跟随。刷新结果仅存内存（按“文件签发时间”绑定，文件一旦变化
 * 即丢弃内存 token，避免切号后仍用旧账号的刷新 token）。
 */
export class LiveCredentialStore {
  private readonly region: WorkBuddyRegion
  private readonly refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  private readonly refreshMarginMs: number
  private readonly livePathOverride?: string
  private mem: { key: string; credential: WorkBuddyCredential } | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: LiveStoreOptions) {
    this.region = options.region
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.livePathOverride = options.livePath
  }

  /** 该区域 live 文件的候选路径（第一个存在即采用）。 */
  candidates(): string[] {
    const regionEnv = nonEmptyEnv(process.env[AUTH_FILE_ENV[this.region]])
    if (regionEnv !== undefined) return [regionEnv]
    if (this.livePathOverride !== undefined) return [this.livePathOverride]
    // 兼容：仅当 legacy 变量指向本区域对应文件名时才采用，避免 cn 误读 -ai.info。
    const legacy = nonEmptyEnv(process.env[LEGACY_AUTH_FILE_ENV])
    if (legacy !== undefined && legacy.replace(/\\/g, '/').endsWith(`/${LIVE_FILENAME[this.region]}`)) {
      return [legacy]
    }
    return defaultDesktopAuthDirs().map(dir => join(dir, LIVE_FILENAME[this.region]))
  }

  /** 实际采用的 live 文件路径（诊断用）。 */
  livePath(): string {
    return this.candidates()[0] as string
  }

  /** 读取磁盘上当前登录态；文件缺失/无法解析返回 undefined。 */
  private async readLive(): Promise<{ credential: WorkBuddyCredential; filePath: string } | undefined> {
    for (const path of this.candidates()) {
      try {
        const parsed = parseWorkBuddyAuth(await readFile(path, 'utf8'), path)
        if (parsed !== undefined) return { credential: parsed, filePath: path }
      } catch (error: unknown) {
        if (!isENOENT(error)) {
          // 文件存在但读取/解析失败：继续尝试下一个候选
        }
      }
    }
    return undefined
  }

  /** 当前应使用的凭据（已按区域校验，必要时刷新），不抛错版供状态查询。 */
  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  /**
   * 解析要发往上游的凭据：实时读盘 + 区域校验 + 按需刷新（内存）。
   * 文件账号区域不匹配或未登录时抛错，由 HTTP 层转成 401。
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const live = await this.readLive()
    if (live === undefined) {
      throw new Error(
        `workbuddy(${this.region}): 未找到登录态文件 ${this.livePath()}；`
        + `请先在对应区域的 WorkBuddy 桌面端登录，或用 ${AUTH_FILE_ENV[this.region]} 指定文件路径`,
      )
    }
    if (regionOf(live.credential.domain) !== this.region) {
      throw new Error(
        `workbuddy(${this.region}): live 文件账号区域不符（domain="${live.credential.domain}"）；`
        + `该端口期望 ${this.region} 账号，请检查 ${live.filePath}`,
      )
    }

    // 以文件的签发时间+accessToken 作为身份键；文件被切号改写后丢弃旧内存 token。
    const key = `${live.credential.lastRefreshAtMs ?? ''}|${live.credential.accessToken.slice(0, 32)}`
    if (this.mem?.key === key) {
      if (!this.needsRefresh(this.mem.credential)) return this.mem.credential
    } else {
      this.mem = { key, credential: live.credential }
      this.inflight = undefined
    }

    if (!this.needsRefresh(this.mem.credential)) return this.mem.credential

    this.inflight ??= this.refreshNow(this.mem.credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token 已过期且没有 refresh token，请重新打开 WorkBuddy 桌面端登录')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      }
      // 仅存内存，永不写盘。
      if (this.mem !== undefined) this.mem = { key: this.mem.key, credential: refreshed }
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy: token 刷新失败且 access token 已过期（${String(error)}）；请重新登录桌面端`)
    }
  }

  /** 只读状态摘要，不刷新、不抛错。 */
  async status(): Promise<WorkBuddyAuthStatus> {
    const live = await this.readLive()
    if (live === undefined) {
      return { state: 'signed-out', region: this.region, filePath: this.livePath() }
    }
    const regionMismatch = regionOf(live.credential.domain) !== this.region
    return {
      state: regionMismatch ? 'signed-out' : 'signed-in',
      region: this.region,
      account: live.credential.nickname ?? live.credential.uin ?? live.credential.uid,
      ...live.credential.uin === undefined ? {} : { uin: live.credential.uin },
      ...live.credential.domain === '' ? {} : { domain: live.credential.domain },
      filePath: live.filePath,
      expiresAtMs: live.credential.expiresAtMs,
      ...regionMismatch
        ? { message: `live 文件是另一区域账号（domain="${live.credential.domain}"）` }
        : {},
    }
  }
}
