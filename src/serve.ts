/**
 * workbuddy-proxy 守护入口：一个进程同时服务国内版与国际版两个回环端点。
 *
 * 改自 dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）。
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行，无需构建。
 *
 * @module workbuddy-proxy/serve
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveCredentialStore } from './auth.ts'
import { AccountCredentialStore } from './account-store.ts'
import { AccountStore, dropLiveDuplicates, identityKeysOfCredential, regionOfDomain, type StoredAccount } from './accounts.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim, RateLimitRegistry, type CredentialStoreLike, type WorkBuddyShim, type ShimLogger } from './shim.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyRegion } from './upstream.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { WorkBuddySigninService } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'

import { redactPaths } from './redact.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const STATE_DIR = join(ROOT, 'state')
const ACCOUNTS_FILE = join(STATE_DIR, 'accounts.json')

const SIGNIN_ENABLED = (process.env['WORKBUDDY_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['WORKBUDDY_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['WORKBUDDY_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

/** 账号模式端口段：账号 i 使用 BASE + i（39320 起）。 */
const ACCOUNT_PORT_BASE = Number(process.env['WORKBUDDY_ACCOUNT_PORT_BASE'] ?? 39320)

/**
 * 是否为账号库的每个账号单独开一个回环端口。
 *
 * 默认 **off**：账号库不再单独开端口，而是并入 live 端口（39301/39302）的
 * 候选池 —— opencode 侧只需国内/国际两个 provider，撞限流时池内自动换号。
 * 置 on 可恢复旧行为（每账号一端口），仅用于单独调试某个账号。
 */
const ACCOUNT_PORTS_ENABLED = (process.env['WORKBUDDY_ACCOUNT_PORTS'] ?? 'off') !== 'off'

interface RegionRuntime {
  /** 运行时标识：live-cn / live-global / acct:<key> */
  id: string
  label: string
  region: WorkBuddyRegion
  port: number
  keyFile: string
  store: LiveCredentialStore | AccountCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  signin: WorkBuddySigninService
  scheduler: SigninScheduler
  /** 账号模式下记录账号 key，用于签到调度命名 */
  accountKey?: string
  /**
   * 该运行时切换池内的账号库账号（live 端口用）。
   * 空数组表示池里只有 live 自己，退化为单账号行为。
   */
  pool: Array<{ id: string; label: string; store: AccountCredentialStore }>
  shim?: WorkBuddyShim
}

const REGION_PORTS: Record<WorkBuddyRegion, number> = {
  cn: Number(process.env['WORKBUDDY_CN_PORT'] ?? 39301),
  global: Number(process.env['WORKBUDDY_GLOBAL_PORT'] ?? 39302),
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * 日志参数格式化。
 *
 * - 对象不再被 String() 压成 "[object Object]"，改为 JSON，保住诊断信息；
 * - 统一做路径脱敏：日志会追加落盘长期保存，不应写入本机用户名与目录结构。
 */
function fmtLogArgs(args: unknown[]): string {
  const text = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}`
    try { return JSON.stringify(a) ?? String(a) } catch { return String(a) }
  }).join(' ')
  return redactPaths(text)
}

/**
 * 日志落盘 + 运行期轮转。
 *
 * 历史上日志由 start.ps1 用 cmd 重定向（node ... >> out.log 2>> err.log），
 * 文件句柄在 cmd 手里 —— 本进程拿不到句柄，**无法在运行期轮转**，只能在重启时
 * 轮一次。后果是「长期不重启的进程，日志无上限增长」。
 *
 * 因此改为：若环境变量指明了日志路径，由本进程直接持有该文件并在超限时自行轮转；
 * 未设置（前台调试）时退回 stdout/stderr。
 *
 * 轮转策略与 start.ps1 里的 Rotate-Log 保持一致：超限改名为 .1，只保留一份。
 */

/** 单个日志文件上限，与 start.ps1 的 Rotate-Log 同一阈值。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface LogSink {
  path: string
  /** 当前文件已有字节数，作为轮转基线。 */
  size: number
}

function makeLogSink(envKey: string): LogSink | null {
  const p = process.env[envKey]
  if (p === undefined || p.trim() === '') return null
  try {
    mkdirSync(dirname(p), { recursive: true })
    // 追加而非截断：既有内容保留，并把当前大小作为轮转基线
    return { path: p, size: statSync(p, { throwIfNoEntry: false })?.size ?? 0 }
  } catch {
    return null // 建不出来就退回 stdout/stderr，不让日志问题拦住启动
  }
}

function writeLogSink(sink: LogSink, text: string): void {
  const bytes = Buffer.byteLength(text)
  if (sink.size + bytes > LOG_MAX_BYTES) {
    try {
      rmSync(`${sink.path}.1`, { force: true })
      renameSync(sink.path, `${sink.path}.1`)
      sink.size = 0
    } catch {
      // 轮转失败就继续往当前文件追加：丢日志比不轮转更糟
    }
  }
  appendFileSync(sink.path, text, 'utf8')
  sink.size += bytes
}

const LOG_OUT = makeLogSink('WORKBUDDY_PROXY_LOG_OUT')
const LOG_ERR = makeLogSink('WORKBUDDY_PROXY_LOG_ERR')

function writeLog(level: 'info' | 'warn' | 'error', line: string): void {
  const sink = level === 'info' ? LOG_OUT : LOG_ERR
  if (sink !== null) writeLogSink(sink, line)
  else if (level === 'info') process.stdout.write(line)
  else process.stderr.write(line)
}

/** 日志重复抑制窗口：同一 level + 同一文本在该窗口内只输出一次。 */
const LOG_DEDUP_WINDOW_MS = 60_000
let lastLogKey = ''
/** 当前这段「相同日志连发」的起始时刻（不是上一条的时刻，见 shouldSuppressLog）。 */
let runStartedAtMs = 0
let suppressedLogCount = 0

/**
 * 连续重复日志抑制。
 *
 * 上游反复故障时（例如某区域长期未登录），同一条错误会被每个 tick 重记一次，
 * 既刷屏又放大磁盘写入。这里对「同一 level + 同一文本」在窗口内只输出首次。
 *
 * 窗口从**这段连发的第一条**开始算。若像原先那样在每次抑制时把计时基准顺延到
 * 当前时刻，窗口会被无限推迟 —— 同一条错误持续不断且期间没有别的日志时，
 * 「同类日志已抑制 N 条」就永远刷不出来，事后也看不出到底发生过多少次。
 * 现在窗口到期会先落盘计数、再让当前这条正常输出，保证每个窗口至少留一行可见。
 */
function shouldSuppressLog(key: string): { suppress: boolean; flushNote: string | null } {
  const now = Date.now()
  const sameKey = key === lastLogKey
  const windowExpired = now - runStartedAtMs >= LOG_DEDUP_WINDOW_MS

  if (suppressedLogCount > 0 && (!sameKey || windowExpired)) {
    const note = `（同类日志已抑制 ${suppressedLogCount} 条）`
    suppressedLogCount = 0
    lastLogKey = key
    runStartedAtMs = now
    return { suppress: false, flushNote: note }
  }
  if (sameKey && !windowExpired) {
    suppressedLogCount++
    return { suppress: true, flushNote: null }
  }
  lastLogKey = key
  runStartedAtMs = now
  return { suppress: false, flushNote: null }
}

function emitLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const text = fmtLogArgs(args)
  const { suppress, flushNote } = shouldSuppressLog(`${level}:${text}`)
  const at = ts()
  if (flushNote !== null) writeLog(level, `[${at}] [${level}] ${flushNote}\n`)
  if (suppress) return
  writeLog(level, `[${at}] [${level}] ${text}\n`)
}

const logger: ShimLogger = {
  info: (...args) => emitLog('info', args),
  warn: (...args) => emitLog('warn', args),
  error: (...args) => emitLog('error', args),
}


/** 读取或首次生成某区域的持久 bearer key（0600）。 */
async function loadOrCreateKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 不存在则生成
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

/** 异步刷新某区域的线上模型目录；失败保留现有（fallback）目录。 */
async function refreshModels(rt: RegionRuntime): Promise<void> {
  try {
    const credential = await rt.store.resolve()
    const models = await rt.client.fetchModels(credential)
    if (models.length > 0) {
      rt.catalog.set(models)
      logger.info(`workbuddy(${rt.region}): 模型目录已刷新，共 ${models.length} 个`)
    }
  } catch (error: unknown) {
    logger.warn(`workbuddy(${rt.region}): 模型目录刷新失败，使用内置 fallback（${String(error instanceof Error ? error.message : error)}）`)
  }
}

async function main(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  const client = new WorkBuddyUpstreamClient()
  let signinTimer: NodeJS.Timeout | undefined

  if (SIGNIN_ENABLED) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })

  // 签到状态按区域分文件：同一区域内的 live 与账号共用一份（target 名区分），
  // 不同区域分开——否则两个调度器各持内存副本整体回写时会互相覆盖（丢更新）。
  const schedulerOf = (region: WorkBuddyRegion): SigninScheduler => new SigninScheduler({
    stateFile: join(STATE_DIR, `signin-state-${region}.json`),
    startHour: SIGNIN_START_HOUR,
    endHour: SIGNIN_END_HOUR,
    log: m => logger.info(m),
  })

  const runtimes: RegionRuntime[] = []
  const accounts = new AccountStore(ACCOUNTS_FILE)

  // ---- 账号库加载 + 与 live 去重 ----
  // 账号库是池化切换的唯一数据源。与 live 当前登录态重复的账号会被剔除，
  // 避免"换号换到自己"以及面板重复计余额。
  const storedAll: StoredAccount[] = await accounts.load()
  const liveIds = new Map<WorkBuddyRegion, Set<string>>()
  if ((process.env['WORKBUDDY_LIVE_MODE'] ?? 'on') !== 'off') {
    for (const region of (['cn', 'global'] as WorkBuddyRegion[])) {
      try {
        const store = new LiveCredentialStore({ region, refresh: credential => client.refreshToken(credential) })
        const credential = await store.resolve()
        liveIds.set(region, new Set(identityKeysOfCredential(region, credential)))
      } catch {
        // 未登录：该区域没有 live 身份，无需去重
      }
    }
  }
  const stored = ACCOUNT_PORTS_ENABLED
    ? storedAll // 调试模式：保留全部账号（每号一端口，需要独立身份）
    : dropLiveDuplicates(
        // 把每个区域的 live 身份键合并成一个集合即可：键里带 region 前缀，不会跨区误判
        new Set([...liveIds.values()].flatMap(s => [...s])),
        storedAll,
      )
  const dropped = storedAll.length - stored.length
  if (dropped > 0) logger.info(`账号库 ${storedAll.length} 个账号，其中 ${dropped} 个与 live 当前登录态重复，已从切换池剔除`)

  // 账号库凭证存储：池化（默认）与调试端口模式共用同一批实例。
  const accountStores: Array<{ account: StoredAccount; region: WorkBuddyRegion; id: string; label: string; store: AccountCredentialStore }>
    = stored.map(account => {
      const region = account.region ?? regionOfDomain(account.domain)
      return {
        account,
        region,
        id: `acct:${account.key}`,
        label: `${region}·${account.nickname ?? account.uin ?? account.label}`,
        store: new AccountCredentialStore({
          accountKey: account.key,
          region,
          accounts,
          refresh: credential => client.refreshToken(credential),
        }),
      }
    })

  // ---- 模式 1：跟随官方 live 登录态（端口 39301/39302），并承载该区域全部候选账号 ----
  const liveMode = (process.env['WORKBUDDY_LIVE_MODE'] ?? 'on') !== 'off'
  if (liveMode) {
    for (const region of (['cn', 'global'] as WorkBuddyRegion[])) {
      const store = new LiveCredentialStore({ region, refresh: credential => client.refreshToken(credential) })
      runtimes.push({
        id: `live-${region}`,
        label: `${region}·当前登录`,
        region,
        port: REGION_PORTS[region],
        keyFile: join(KEYS_DIR, `${region}.key`),
        store,
        client,
        catalog: new WorkBuddyCatalog(region),
        signin: new WorkBuddySigninService(store, client),
        scheduler: schedulerOf(region),
        // 该地区账号库账号并入本端口的切换池
        pool: ACCOUNT_PORTS_ENABLED
          ? []
          : accountStores.filter(a => a.region === region).map(a => ({ id: a.id, label: a.label, store: a.store })),
      })
    }
  }

  // ---- 模式 2（默认关闭）：账号库每账号单独一端口，仅调试用 ----
  if (ACCOUNT_PORTS_ENABLED) {
    accountStores.forEach((a, index) => {
      runtimes.push({
        id: a.id,
        label: a.label,
        region: a.region,
        port: ACCOUNT_PORT_BASE + index,
        keyFile: join(KEYS_DIR, `acct-${index}.key`),
        store: a.store,
        client,
        catalog: new WorkBuddyCatalog(a.region),
        signin: new WorkBuddySigninService(a.store, client),
        scheduler: schedulerOf(a.region),
        accountKey: a.account.key,
        pool: [],
      })
    })
  }

  if (runtimes.length === 0) {
    logger.warn('没有可用的运行时（live 模式关闭且账号库为空）')
  }

  // 跨端口共享的限流登记表：某账号被 6004 限流后，同区域所有端口都会跳过它
  const rateLimitRegistry = new RateLimitRegistry()
  // 候选池构造器：给定区域，返回该区域**全部可用账号**（live + 该区域账号库）。
  // live 端口自身排在首位（由 shim 按 selfId 提权），账号库账号作为后备。
  const candidatesOf = (region: WorkBuddyRegion) => {
    const out: Array<{ id: string; label: string; store: CredentialStoreLike }> = []
    for (const rt of runtimes) {
      if (rt.region !== region) continue
      if (rt.accountKey !== undefined) continue // 调试端口模式：账号端口只服务自己
      out.push({ id: rt.id, label: rt.label, store: rt.store })
      for (const p of rt.pool) out.push({ id: p.id, label: p.label, store: p.store })
    }
    return out
  }

  const shims: WorkBuddyShim[] = []
  for (const rt of runtimes) {
    const token = await loadOrCreateKey(rt.keyFile)
    const sameRegion = candidatesOf(rt.region)
    const shim = createWorkBuddyShim({
      region: rt.region,
      port: rt.port,
      token,
      store: rt.store,
      client,
      catalog: rt.catalog,
      logger,
      // 同区域多账号时才启用切换（单账号时行为不变）
      failover: sameRegion.length > 1
        ? { selfId: rt.id, candidates: () => candidatesOf(rt.region), registry: rateLimitRegistry }
        : undefined,
      signinStatus: SIGNIN_ENABLED ? async () => {
        const entry = await rt.scheduler.entry(rt.id) ?? await rt.scheduler.plan(rt.id)
        let view: unknown = null
        let error: string | undefined
        try { view = await rt.signin.getStatus() }
        catch (e) { error = e instanceof Error ? e.message : String(e) }
        return {
          runtime: rt.id,
          label: rt.label,
          region: rt.region,
          scheduledAt: formatSec(entry.runAtSec),
          claimedToday: entry.claimed,
          lastResult: entry.result,
          view,
          ...(error === undefined ? {} : { error }),
        }
      } : undefined,
      signinClaim: SIGNIN_ENABLED ? async () => {
        const outcome = await rt.scheduler.runNow(rt.id, () => rt.signin.claim())
        return { runtime: rt.id, label: rt.label, region: rt.region, ...outcome }
      } : undefined,
    })
    rt.shim = shim
    shims.push(shim)
    await shim.ready
    logger.info(
      `workbuddy(${rt.label}) 已监听 ${shim.baseUrl()} `
      + `(key=${rt.keyFile}, models=${rt.catalog.current().length})`,
    )
    void refreshModels(rt)
  }

  // 每日签到：到当天随机时刻自动领取（每个账号独立随机）
  // 注意：池化模式下账号库账号不是独立 runtime，须单列出来一起签到，
  // 否则它们会永远收不到每日积分。
  const signinTargets: Array<{ id: string; label: string; signin: WorkBuddySigninService; scheduler: SigninScheduler }> = []
  for (const rt of runtimes) {
    if (rt.accountKey === undefined) {
      signinTargets.push({ id: rt.id, label: rt.label, signin: rt.signin, scheduler: rt.scheduler })
    }
  }
  if (!ACCOUNT_PORTS_ENABLED) {
    for (const a of accountStores) {
      signinTargets.push({
        id: a.id,
        label: a.label,
        signin: new WorkBuddySigninService(a.store, client),
        scheduler: schedulerOf(a.region),
      })
    }
  }

  async function signinTick(): Promise<void> {
    for (const t of signinTargets) {
      try {
        await t.scheduler.runIfDue(t.id, () => t.signin.claim())
      } catch {
        // 未登录 / token 失效：静默跳过
      }
    }
  }
  if (SIGNIN_ENABLED) {
    for (const t of signinTargets) {
      const plan = await t.scheduler.plan(t.id)
      logger.info(`workbuddy(${t.label}) 今日签到计划 ${formatSec(plan.runAtSec)}`)
    }
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    signinTimer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    signinTimer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取（${signinTargets.length} 个账号独立）`)
  }

  // 每 6 小时刷新一次模型目录
  const REFRESH_INTERVAL = 6 * 60 * 60 * 1000
  const timer = setInterval(() => {
    for (const rt of runtimes) void refreshModels(rt)
  }, REFRESH_INTERVAL)
  timer.unref()

  const liveCount = runtimes.filter(r => r.accountKey === undefined).length
  const acctCount = runtimes.length - liveCount
  const pooled = runtimes.reduce((n, r) => n + r.pool.length, 0)
  logger.info(
    `workbuddy-proxy ${WORKBUDDY_CONNECT_VERSION} 就绪：`
    + `live ${liveCount} 个（${REGION_PORTS.cn}/${REGION_PORTS.global}）`
    + (pooled > 0 ? `，切换池 ${pooled} 个账号库账号` : '，切换池为空')
    + (acctCount > 0 ? ` + 调试账号端口 ${acctCount} 个（端口 ${ACCOUNT_PORT_BASE} 起）` : ''),
  )

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭...`)
    clearInterval(timer)
    if (signinTimer !== undefined) clearInterval(signinTimer)
    await Promise.allSettled(shims.map(shim => shim.close()))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('workbuddy-proxy 启动失败：', error)
  process.exit(1)
})
