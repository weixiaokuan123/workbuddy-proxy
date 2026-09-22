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
import { prepareChatBody, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { redactPaths } from './redact.ts'

/** shim 只要求这两个方法，LiveCredentialStore 与 AccountCredentialStore 都满足。 */
export interface CredentialStoreLike {
  resolve(): Promise<WorkBuddyCredential>
  status(): Promise<WorkBuddyAuthStatus>
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

  const baseUrl = (): string => `http://${host}:${port}`

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
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error instanceof Error ? error.message : error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`,
      )
      return
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
