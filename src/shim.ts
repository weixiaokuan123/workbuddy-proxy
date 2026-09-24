/**
 * 回环 OpenAI 兼容端点。
 *
 * 改自 dingminhua/dsh-connect-workbuddy/src/shim.ts（MIT，Copyright (c) 2026 LaoDing），
 * 其安全设计源自 corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）。
 * 安全相关代码（Host/Origin/JSON/bearer 四重回环校验、常量时间比对、body 上限、
 * 上游错误到 HTTP 状态码映射）原样保留，不做“改善”。
 *
 * 相对原版的改动：
 *  - 对接精简版 LiveCredentialStore（单 live 文件、实时跟随切号）；
 *  - 支持固定端口与持久 bearer（opencode 需要稳定 baseURL/apiKey）；
 *  - 新增只读 GET /status（当前账号、域名、积分、模型数），同样需要 bearer。
 *
 * @module workbuddy-proxy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyAuthStatus, WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { parseRateLimitResetMs, prepareChatBody, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { redactPaths } from './redact.ts'

/** shim 只要求这两个方法，LiveCredentialStore 与 AccountCredentialStore 都满足。 */
export interface CredentialStoreLike {
  resolve(): Promise<WorkBuddyCredential>
  status(): Promise<WorkBuddyAuthStatus>
}

/**
 * 单个候选账号（用于限流后切换）。
 * `id` 需在本次进程内唯一且稳定（账号库 key 或 live-cn / live-global）。
 */
export interface FailoverCandidate {
  id: string
  label: string
  store: CredentialStoreLike
}

/**
 * 账号级限流登记表：记录某账号在何时之前不可用。
 *
 * 上游 6004 文案里给出重置时刻（如「将在 2026-09-23 08:44:36 UTC+8 重置」），
 * 解析得到精确恢复时间；解析不到则退化为固定冷却窗（默认 10 分钟），
 * 避免每次请求都去撞同一个已耗尽账号。
 */
export class RateLimitRegistry {
  private readonly until = new Map<string, number>()
  private readonly defaultCooldownMs: number

  constructor(defaultCooldownMs = 10 * 60 * 1000) {
    this.defaultCooldownMs = defaultCooldownMs
  }

  /** 记录某账号被限流；resetAtMs 缺省时用固定冷却。 */
  mark(id: string, resetAtMs?: number): number {
    // 上游给的重置时间可能早于本地时钟（时钟偏差），至少冷却 30 秒，避免立即复用
    const until = Math.max(resetAtMs ?? 0, Date.now() + 30_000, resetAtMs === undefined ? Date.now() + this.defaultCooldownMs : 0)
    this.until.set(id, until)
    return until
  }

  /** 该账号现在是否仍处于限流冷却中。 */
  isLimited(id: string): boolean {
    const until = this.until.get(id)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.until.delete(id)
      return false
    }
    return true
  }

  /** 距离恢复还有多少毫秒（0 表示可用）。 */
  remainingMs(id: string): number {
    return this.isLimited(id) ? Math.max(0, (this.until.get(id) ?? 0) - Date.now()) : 0
  }

  /** 只读快照，供面板/状态接口展示。 */
  snapshot(): Array<{ id: string; untilMs: number; remainingMs: number }> {
    const now = Date.now()
    const out: Array<{ id: string; untilMs: number; remainingMs: number }> = []
    for (const [id, until] of this.until) {
      if (now >= until) continue
      out.push({ id, untilMs: until, remainingMs: until - now })
    }
    return out
  }
}

export interface ShimLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WorkBuddyShim {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

/** 池化入口暴露给面板的单个候选账号状态。 */
export interface PoolEntryView {
  id: string
  label: string
  /** 是否为本端口绑定的主账号（正常情况下优先使用）。 */
  preferred: boolean
  /** 是否处于限流冷却中。 */
  rateLimited: boolean
  /** 距离恢复的秒数（0 表示可用）。 */
  remainingSec: number
  /** 当前实际生效的账号（凭证解析成功时给出）。 */
  active: boolean
}

export interface WorkBuddyShimOptions {
  region: 'cn' | 'global'
  port: number
  host?: string
  /** 固定 bearer；不传则每次进程随机生成。 */
  token?: string
  store: CredentialStoreLike
  client: Pick<WorkBuddyUpstreamClient, 'chatStream' | 'fetchCredits'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /** 只读签到状态；不提供则 /signin/* 返回 404 */
  signinStatus?: () => Promise<unknown>
  /** 立即检查/领取今日签到（幂等） */
  signinClaim?: () => Promise<unknown>
  /**
   * 限流切换：返回**同区域**的全部候选（含本端口自身），由 shim 决定尝试顺序。
   * 不提供则退化为单账号行为（遇限流直接报错）。
   */
  failover?: {
    /** 本端口对应账号的 id（须出现在 candidates 里）。 */
    selfId: string
    candidates: () => readonly FailoverCandidate[]
    /** 跨端口共享的限流登记表。 */
    registry: RateLimitRegistry
  }
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  // 统一脱敏本机路径，避免日志/界面泄露真实用户名与目录。
  writeJson(res, status, { error: { message: redactPaths(message), type: kind, code: kind } })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog, port, region, logger } = options
  const host = options.host ?? '127.0.0.1'
  const SHARED_SECRET = options.token ?? randomBytes(32).toString('base64url')

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(port, host)

  const baseUrl = (): string => {
    // 端口传 0 时由系统分配，须从实际监听地址读取（测试与多实例场景用得到）
    const addr = server.address()
    const actual = typeof addr === 'object' && addr !== null ? addr.port : port
    return `http://${host}:${actual}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, region, version: WORKBUDDY_CONNECT_VERSION })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: `workbuddy-${region}`,
          })),
        })
        return
      }
      if (req.method === 'GET' && (url === '/status' || url === '/status/')) {
        await status(req, res)
        return
      }
      if (req.method === 'GET' && (url === '/credits' || url === '/credits/')) {
        try {
          const credential = await store.resolve()
          const credits = await options.client.fetchCredits(credential)
          writeJson(res, 200, { region, ...credits })
          return
        } catch (error) {
          writeOpenAIError(res, 502, 'credits_error', error instanceof Error ? error.message : String(error))
          return
        }
      }
      if (url.split('?')[0] === '/signin/status' && req.method === 'GET') {
        if (!options.signinStatus) { writeOpenAIError(res, 404, 'not_found', 'sign-in not available'); return }
        try { writeJson(res, 200, await options.signinStatus()); return }
        catch (error) { writeOpenAIError(res, 502, 'signin_error', error instanceof Error ? error.message : String(error)); return }
      }
      if (url.split('?')[0] === '/signin/claim' && req.method === 'POST') {
        if (!options.signinClaim) { writeOpenAIError(res, 404, 'not_found', 'sign-in not available'); return }
        try { writeJson(res, 200, await options.signinClaim()); return }
        catch (error) { writeOpenAIError(res, 502, 'signin_error', error instanceof Error ? error.message : String(error)); return }
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function status(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await store.status()
    const payload: Record<string, unknown> = { region, auth, models: catalog.current().length }
    if (options.failover !== undefined) {
      const { selfId, candidates, registry } = options.failover
      const all = candidates()
      const limited = registry.snapshot()
      // 池化视图：面板据此显示「这个入口背后有几个号、当前轮到谁、谁在冷却」。
      payload['pool'] = {
        size: all.length,
        preferredId: selfId,
        entries: all.map((c): PoolEntryView => {
          const remainingMs = registry.remainingMs(c.id)
          return {
            id: c.id,
            label: c.label,
            preferred: c.id === selfId,
            rateLimited: remainingMs > 0,
            remainingSec: Math.ceil(remainingMs / 1000),
            active: false,
          }
        }),
      }
      payload['failover'] = {
        enabled: true,
        candidates: all.length,
        rateLimited: limited.map(l => ({ id: l.id, remainingSec: Math.ceil(l.remainingMs / 1000) })),
      }
    } else {
      // 即使只有一个候选（如国际版目前只有 1 个账号），也把池视图暴露出来，
      // 面板才能一致地显示「该区域目前就 1 个号」；以后加号时视图自动扩展。
      payload['pool'] = {
        size: 1,
        preferredId: `live-${region}`,
        entries: [{ id: `live-${region}`, label: `${region}·当前登录`, preferred: true, rateLimited: false, remainingSec: 0, active: false }],
      }
    }
    if (auth.state === 'signed-in') {
      try {
        const credential = await store.resolve()
        const credits = await client.fetchCredits(credential)
        payload['credits'] = { total: credits.total, packages: credits.packages.length }
      } catch (error: unknown) {
        payload['creditsError'] = String(error instanceof Error ? error.message : error)
      }
    }
    writeJson(res, 200, payload)
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    // 候选池：本端口主账号优先，其余按「最早恢复」排序，冷却中的排最后。
    // 无 failover 配置时退化为单账号，行为与改动前一致。
    //
    // 为什么冷却中的账号仍保留在池里：若同区域所有账号都在冷却，直接报错
    // 不如尝试最早恢复的那个 —— 上游冷却时间可能早于本地估算（时钟偏差/
    // 误判），硬等反而不如再试一次。真正的错误由最后一轮如实抛出。
    const attempts: Array<{ id: string; label: string; store: CredentialStoreLike }> = []
    if (options.failover !== undefined) {
      const { selfId, candidates, registry } = options.failover
      const all = candidates()
      const self = all.find(c => c.id === selfId)
      if (self !== undefined) attempts.push({ id: self.id, label: self.label, store: self.store })

      const rest = all
        .filter(c => c.id !== selfId)
        .map(c => ({ candidate: c, limited: registry.isLimited(c.id), remaining: registry.remainingMs(c.id) }))
        // 可用账号在前；都可用按顺序稳定排序，冷却中的按剩余时间升序
        .sort((a, b) => {
          if (a.limited !== b.limited) return a.limited ? 1 : -1
          return a.remaining - b.remaining
        })
      for (const r of rest) attempts.push({ id: r.candidate.id, label: r.candidate.label, store: r.candidate.store })

      const dodging = rest.filter(r => r.limited)
      if (dodging.length > 0) {
        logger?.info(
          `workbuddy(${region}): 候选池 ${all.length} 个账号，其中 ${dodging.length} 个冷却中`
          + `（${dodging.map(r => `${r.candidate.label} ${Math.ceil(r.remaining / 1000)}s`).join('、')}），已排在末尾`,
        )
      }
    } else {
      attempts.push({ id: '(self)', label: region, store })
    }

    let lastFailure: { status: number; kind: UpstreamErrorKind; message: string } | undefined
    let limitedCount = 0

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!
      let credential
      try {
        credential = await attempt.store.resolve()
      } catch (error: unknown) {
        // 该账号不可用（未登录/已删除/token 失效）：换下一个，不要因此打断整个请求
        lastFailure = { status: 401, kind: 'session_dead', message: String(error instanceof Error ? error.message : error) }
        if (attempts.length > 1) {
          logger?.warn(`workbuddy(${region}): 账号 ${attempt.label} 不可用（${lastFailure.message.slice(0, 120)}），尝试下一个`)
          continue
        }
        break
      }

      const result = await client.chatStream(credential, prepared, controller.signal)
      if (result.ok) {
        if (i > 0) {
          logger?.info(`workbuddy(${region}): 已切换到账号 ${attempt.label} 完成本次请求（第 ${i + 1}/${attempts.length} 个）`)
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        let sawDone = false
        const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
        body.on('data', (chunk: Buffer) => {
          if (chunk.includes('[DONE]')) sawDone = true
        })
        body.on('error', (error: unknown) => {
          logger?.warn(`workbuddy(${region}): upstream stream failed mid-flight`, error)
          if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
        })
        body.pipe(res)
        return
      }

      lastFailure = { status: result.status, kind: result.kind, message: result.message }

      // 限流（额度暂时耗尽）：记下恢复时间，换同区域的下一个账号
      if (result.kind === 'soft_rate' && options.failover !== undefined) {
        const resetAtMs = parseRateLimitResetMs(result.message)
        const until = options.failover.registry.mark(attempt.id, resetAtMs)
        limitedCount++
        const waitSec = Math.max(0, Math.ceil((until - Date.now()) / 1000))
        logger?.warn(
          `workbuddy(${region}): 账号 ${attempt.label} 触发频率限制，${waitSec}s 后恢复`
          + (i + 1 < attempts.length ? '，切换到下一个账号' : '，已无可用账号'),
        )
        continue
      }

      // 其余错误：不再尝试其他账号（多为请求本身的问题，换号无益）
      break
    }

    // 全部候选都失败：如实报错，并在文案里说明已尝试过切号
    const failure = lastFailure ?? { status: 502, kind: 'server' as UpstreamErrorKind, message: 'no usable account' }
    const tried = attempts.length
    const suffix = limitedCount > 0
      ? `（已尝试 ${tried} 个同区域账号，其中 ${limitedCount} 个因额度限流被跳过）`
      : ''
    writeOpenAIError(
      res,
      KIND_STATUS[failure.kind],
      failure.kind,
      `workbuddy upstream ${failure.kind} (http ${failure.status})${suffix}: ${failure.message.slice(0, 400)}`,
    )
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
