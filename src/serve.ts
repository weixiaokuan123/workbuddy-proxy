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
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveCredentialStore, readLiveIdentity } from './auth.ts'
import { AccountCredentialStore } from './account-store.ts'
import { AccountStore, dropLiveDuplicates, identityKeysOfCredential, identityKeysOfRecord, regionOfDomain, type StoredAccount } from './accounts.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim, RateLimitRegistry, type CredentialStoreLike, type WorkBuddyShim, type ShimLogger } from './shim.ts'
import { WorkBuddyUpstreamClient, travelSupported, type WorkBuddyRegion } from './upstream.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { WorkBuddySigninService } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'
import {
  WorkBuddyTravelService,
  createTravelState,
  rollTravelStateToToday,
  localDate as travelLocalDate,
  BACKOFF_LADDER_MS as TRAVEL_BACKOFF,
  MAX_SLEEP_MS as MAX_TRAVEL_SLEEP_MS,
  DEFAULT_TRAVEL_WINDOW,
  type TravelWindow,
  type TravelStateStore,
} from './travel.ts'

import { redactPaths } from './redact.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const STATE_DIR = join(ROOT, 'state')
const ACCOUNTS_FILE = join(STATE_DIR, 'accounts.json')
const TRAVEL_STATE_FILE = join(STATE_DIR, 'travel-state.json')

const SIGNIN_ENABLED = (process.env['WORKBUDDY_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['WORKBUDDY_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['WORKBUDDY_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

// ---- 派猫猫旅行（成长中心） ----
// 只有国内版有成长中心；国际版账号一律跳过（见 travelSupported）。
const TRAVEL_ENABLED = (process.env['WORKBUDDY_TRAVEL'] ?? 'on') !== 'off'
// 两次唤醒之间的最小间隔：病态情况下（如时钟跳变）的洪泛兜底。
// 正常唤醒点至少在 CLAIM_GRACE_MS（3 分钟）之后，故此下界不会推迟正常唤醒。
const TRAVEL_MIN_WAKE_MS = 30 * 1000
// 账号库巡检间隔：只 stat 文件（零上游请求），mtime 变了才重建目标集合。
const TRAVEL_SWEEP_MS = 5 * 60 * 1000
// 「全部派遣」时账号间的错开间隔，避免集中打上游触发 QPS 限流。
const TRAVEL_DEPART_STAGGER_MS = 2 * 1000
// 可派时间窗（服务端本地小时）。窗外不派，领取不受影响。
const travelWindow: TravelWindow = {
  startHour: Number(process.env['WORKBUDDY_TRAVEL_WINDOW_START'] ?? DEFAULT_TRAVEL_WINDOW.startHour),
  endHour: Number(process.env['WORKBUDDY_TRAVEL_WINDOW_END'] ?? DEFAULT_TRAVEL_WINDOW.endHour),
}

/** 旅行只读视图与手动派遣；TRAVEL_ENABLED 为 off 时保持 undefined，shim 据此返回 404。 */
let travelApi: {
  status: (region: WorkBuddyRegion) => unknown
  depart: (region: WorkBuddyRegion, onlyId?: string) => Promise<{ results: Array<{ id: string; label: string; ok: boolean; message: string }> }>
} | undefined

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
  // 追加同样必须包 try：磁盘满 / 日志被独占锁定时 appendFileSync 会同步抛错。
  // 落盘失败绝不能往上传播——本函数常被 catch 块内的 logger.warn 调用，
  // 异常一旦逃出去就成了未捕获 rejection，而 Node 24 的默认行为是**终止进程**，
  // 会连带干掉正在给编辑器供模的端点。日志写不进去，丢掉这一条，仅此而已。
  try {
    appendFileSync(sink.path, text, 'utf8')
    sink.size += bytes
  } catch {
    // 静默：日志不是关键路径，不能因为它把服务搞挂
  }
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
  //
  // 关键：live 身份用 readLiveIdentity 读，**不要求 token 可解密**。
  // 桌面端自 2026-09 起把 token 加密成 {$wbEncrypted, envelope}，
  // parseWorkBuddyAuth 会失败；若因此认为"该区域没有 live 身份"，
  // 就不会去重，池里会同时留着 live 和账号库两份同身份账号。
  const storedAll: StoredAccount[] = await accounts.load()
  const liveIds = new Map<WorkBuddyRegion, Set<string>>()
  /** live 身份键（按 region）：去重与旅行目标去重都用它。 */
  const liveIdentityKeys = new Map<WorkBuddyRegion, string[]>()
  /** live 是否真的可用（能 resolve 出凭据）。不可用时用账号库同身份账号顶上。 */
  const liveUsable = new Map<WorkBuddyRegion, boolean>()
  if ((process.env['WORKBUDDY_LIVE_MODE'] ?? 'on') !== 'off') {
    for (const region of (['cn', 'global'] as WorkBuddyRegion[])) {
      const store = new LiveCredentialStore({ region, refresh: credential => client.refreshToken(credential) })
      // 先试凭据（最权威）；失败则退到只读身份，至少还能拿到 uid 用于去重。
      try {
        const credential = await store.resolve()
        const keys = identityKeysOfCredential(region, credential)
        liveIdentityKeys.set(region, keys)
        liveUsable.set(region, true)
      } catch {
        liveUsable.set(region, false)
        try {
          const raw = await readFile(store.livePath(), 'utf8')
          const identity = readLiveIdentity(raw)
          if (identity !== undefined) {
            const record = {
              region,
              uid: identity.uid,
              domain: identity.domain,
              uin: identity.uin,
              label: 'live',
              nickname: '',
            }
            liveIdentityKeys.set(region, identityKeysOfRecord(record))
            logger.warn(
              `workbuddy(${region}) live 登录态的 token 已加密（桌面端 2026-09 起改为 $wbEncrypted/envelope，`
              + '本代理暂不能解密）。账号本身是登录正常的，将改用账号库中同身份（uid 相同）的账号顶上。'
              + '副作用：以后**新增**账号无法捕获——捕获必须读 live 文件。'
              + '根治需从 WorkBuddy.exe 取出构建期密钥（envelope 内明文 keyId 可自校验）。',
            )
          }
        } catch {
          // 连文件都读不到：真的没登录，该区域无 live 身份。
        }
      }
      const keys = liveIdentityKeys.get(region)
      if (keys !== undefined && keys.length > 0) liveIds.set(region, new Set(keys))
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
  if (dropped > 0) {
    // live 不可用时，被去重的账号并没有被 live 顶替——必须回填，否则白丢一个可用账号。
    const anyLiveDown = [...liveUsable.values()].some(v => v === false)
    logger.info(
      `账号库 ${storedAll.length} 个账号，其中 ${dropped} 个与 live 当前登录态重复，已从切换池剔除`
      + (anyLiveDown ? '（live 不可用，同身份账号将自动回填）' : ''),
    )
  }

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

  // ---- 池内自动回填：live 不可用时，把被去重的同身份账号放回池里 ----
  //
  // 起因：去重的目的是「避免换号换到自己」，前提是 live 真的能用。
  // 桌面端把 token 加密后 live 解析失败，但**身份字段仍是明文**，于是
  // 「live = 账号库里那个 13800138002」这个事实依然成立——而那个账号在
  // 账号库里存着可用的明文 token。若不回填，就等于为了一个用不了的 live
  // 白白丢掉一个能用的账号。
  const backfilledStores: typeof accountStores = []
  if (!ACCOUNT_PORTS_ENABLED) {
    for (const region of (['cn', 'global'] as WorkBuddyRegion[])) {
      if (liveUsable.get(region) !== false) continue
      const keys = liveIdentityKeys.get(region) ?? []
      if (keys.length === 0) continue
      const already = new Set(accountStores.map(a => a.id))
      for (const account of storedAll) {
        const accRegion = account.region ?? regionOfDomain(account.domain)
        if (accRegion !== region) continue
        if (identityKeysOfRecord(account).some(k => keys.includes(k))) {
          const id = `acct:${account.key}`
          if (already.has(id)) continue
          already.add(id)
          backfilledStores.push({
            account,
            region,
            id,
            label: `${region}·${account.nickname ?? account.uin ?? account.label}`,
            store: new AccountCredentialStore({
              accountKey: account.key,
              region,
              accounts,
              refresh: credential => client.refreshToken(credential),
            }),
          })
          logger.info(`workbuddy(${region}) live 不可用，已把同身份账号 ${account.nickname ?? account.uin ?? account.key} 回填进切换池`)
        }
      }
    }
  }

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
        // 该地区账号库账号并入本端口的切换池（含 live 不可用时回填的同身份账号）
        pool: ACCOUNT_PORTS_ENABLED
          ? []
          : [...accountStores, ...backfilledStores]
            .filter(a => a.region === region)
            .map(a => ({ id: a.id, label: a.label, store: a.store })),
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

  // 每日签到目标表。声明提前到 shim 循环之前：下面的 signinStatus 闭包要在
  // **调用时**读它（HTTP 请求发生在启动完成之后，那时下面已填好内容）。
  const signinTargets: Array<{ id: string; label: string; signin: WorkBuddySigninService; scheduler: SigninScheduler }> = []

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

        // 逐目标明细。
        //
        // 为什么必须有：面板上某个区域只有一张卡片，而卡片里的「签到」此前
        // 显示的是**该端口自身**的状态。cn 端口自身是 live-cn，它的 token
        // 已被桌面端加密、永远失败——于是面板上写着「签到失败」，而实际上
        // 同区另外几个账号签到得好好的。给出明细，面板才能显示真实情况。
        const targets = []
        for (const t of signinTargets) {
          const e = await t.scheduler.entry(t.id).catch(() => undefined)
          targets.push({
            id: t.id,
            label: t.label,
            scheduledAt: e === undefined ? undefined : formatSec(e.runAtSec),
            claimedToday: e?.claimed ?? false,
            lastResult: e?.result ?? '',
            isThisPort: t.id === rt.id,
          })
        }
        const claimedCount = targets.filter(t => t.claimedToday).length

        return {
          runtime: rt.id,
          label: rt.label,
          region: rt.region,
          scheduledAt: formatSec(entry.runAtSec),
          claimedToday: entry.claimed,
          lastResult: entry.result,
          view,
          targets,
          claimedCount,
          totalCount: targets.length,
          ...(error === undefined ? {} : { error }),
        }
      } : undefined,
      signinClaim: SIGNIN_ENABLED ? async () => {
        // 先试本端口；凭据不可用时（典型：live token 已被加密）改为领取该区域
        // 所有尚未领取的目标，否则面板上点「立即签到」永远失败。
        try {
          await rt.signin.getStatus()
          const outcome = await rt.scheduler.runNow(rt.id, () => rt.signin.claim())
          return { runtime: rt.id, label: rt.label, region: rt.region, ...outcome }
        } catch (e) {
          const pending = signinTargets.filter(t => {
            if (t.id === rt.id) return false
            void t.scheduler.entry(t.id).then(en => en).catch(() => undefined)
            return true
          })
          if (pending.length === 0) {
            return { runtime: rt.id, label: rt.label, region: rt.region, ok: false, message: e instanceof Error ? e.message : String(e) }
          }
          const results: Array<{ id: string; label: string; ok: boolean; message: string }> = []
          for (const t of pending) {
            try {
              const o = await t.scheduler.runNow(t.id, () => t.signin.claim())
              results.push({ id: t.id, label: t.label, ok: o.ok !== false, message: o.message ?? (o.claimed ? '已领取' : '今日已领') })
            } catch (err) {
              results.push({ id: t.id, label: t.label, ok: false, message: err instanceof Error ? err.message : String(err) })
            }
          }
          return {
            runtime: rt.id,
            label: rt.label,
            region: rt.region,
            ok: results.some(r => r.ok),
            message: `本端口不可用，已改为领取该区域 ${results.length} 个账号`,
            results,
          }
        }
      } : undefined,
      // 注意：这里只判断 TRAVEL_ENABLED，**不能**在创建时求值 travelApi ——
      // 旅行块在本循环之后才运行，那时 travelApi 还是 undefined。
      // 闭包在调用时才读它，因此能拿到已赋的值。
      travelStatus: TRAVEL_ENABLED
        ? () => ({ region: rt.region, ...(travelApi?.status(rt.region) as object) })
        : undefined,
      travelDepart: TRAVEL_ENABLED
        ? async (onlyId?: string) => travelApi?.depart(rt.region, onlyId)
        : undefined,
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
  // **必须包含 backfilledStores**：live 不可用时被去重、又因回填而重新可用的
  // 账号，同样要拿到每日签到积分，否则回填只恢复了对话与旅行，签到却漏了。
  const signinSeen = new Set<string>()
  for (const rt of runtimes) {
    if (rt.accountKey === undefined && !signinSeen.has(rt.id)) {
      signinSeen.add(rt.id)
      signinTargets.push({ id: rt.id, label: rt.label, signin: rt.signin, scheduler: rt.scheduler })
    }
  }
  if (!ACCOUNT_PORTS_ENABLED) {
    for (const a of [...accountStores, ...backfilledStores]) {
      if (signinSeen.has(a.id)) continue
      signinSeen.add(a.id)
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

  // ---- 派猫猫旅行（成长中心，仅国内版） ----
  //
  // 每账号一个**独立定时器**：派出后按「落地点 − server_now + 余量」睡到那一刻，
  // 到点领取，领取后 60 秒重查再派，循环往复。A 号到点不会唤醒 B 号。
  let travelTimers: Map<string, NodeJS.Timeout> = new Map()
  let travelSweepTimer: NodeJS.Timeout | undefined
  const travelInFlight = new Set<string>()
  if (TRAVEL_ENABLED) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })

    let travelStoreData: TravelStateStore = {}
    try {
      const raw = JSON.parse(await readFile(TRAVEL_STATE_FILE, 'utf8')) as unknown
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        travelStoreData = raw as TravelStateStore
      }
    } catch {
      // 首次运行或文件损坏：从空状态开始，今天重来一次即可（幂等）。
    }

    let travelDirty = false
    let travelSaveTimer: NodeJS.Timeout | undefined
    const saveTravelState = async (): Promise<void> => {
      // 走 tmp + rename：崩溃或磁盘满时不会留下被截断的 JSON（与 AccountStore.save 同一做法）。
      const tmp = `${TRAVEL_STATE_FILE}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(travelStoreData, null, 2)}\n`, { mode: 0o600 })
        await rename(tmp, TRAVEL_STATE_FILE)
      } catch (error) {
        logger.warn('旅行状态写入失败：', error instanceof Error ? error.message : String(error))
        await rm(tmp, { force: true }).catch(() => {})
      }
    }
    /** 标脏后合并写：多个账号各自唤醒也不会打多次盘。 */
    const markTravelDirty = (): void => {
      travelDirty = true
      if (travelSaveTimer !== undefined) return
      travelSaveTimer = setTimeout(() => {
        travelSaveTimer = undefined
        if (!travelDirty) return
        travelDirty = false
        saveTravelState().catch(() => {})
      }, 2_000)
      travelSaveTimer.unref()
    }

    // ---- 旅行目标集合：按身份去重 + 动态重建 ----
    // live 与账号库可能存在同身份账号（桌面端登录的往往也在账号库里）。
    // 两个目标同时对同一服务端账号派会互相消耗 daily_limit，故只留可用的那个。
    const travelTargets = new Map<string, { id: string; label: string; region: WorkBuddyRegion; travel: WorkBuddyTravelService; keys: string[] }>()

    const clearTravelTimers = (): void => {
      for (const t of travelTimers.values()) clearTimeout(t)
      travelTimers = new Map()
    }

    const scheduleOne = (id: string, atMs: number | undefined): void => {
      const existing = travelTimers.get(id)
      if (existing !== undefined) { clearTimeout(existing); travelTimers.delete(id) }
      const now = Date.now()
      const target = atMs === undefined ? now + MAX_TRAVEL_SLEEP_MS : atMs
      // 下界 30 秒是洪泛兜底：正常唤醒点至少在 3 分钟后（CLAIM_GRACE_MS），
      // 这个下界不会推迟任何正常唤醒，只挡时钟跳变等病态下的「每 1 秒醒一次」。
      const delay = Math.min(Math.max(target - now, TRAVEL_MIN_WAKE_MS), MAX_TRAVEL_SLEEP_MS)
      const handle = setTimeout(() => { void tickOne(id) }, delay)
      handle.unref()
      travelTimers.set(id, handle)
    }

    /** 推进单个账号，然后只重排它自己的定时器。 */
    const tickOne = async (id: string): Promise<void> => {
      const t = travelTargets.get(id)
      if (t === undefined) return
      if (travelInFlight.has(id)) return
      travelInFlight.add(id)
      try {
        const today = travelLocalDate()
        const entry = rollTravelStateToToday(travelStoreData[id] ?? createTravelState(today), today)
        travelStoreData[id] = entry
        const outcome = await t.travel.tick(entry)
        markTravelDirty()
        scheduleOne(id, outcome.nextWakeAtMs)
        if (outcome.acted) logger.info(`workbuddy(${t.label}) 旅行：${outcome.message}`)
        else if (outcome.done) logger.info(`workbuddy(${t.label}) 旅行：${outcome.message}`)
        else if (outcome.nextWakeAtMs !== undefined && entry.result !== undefined) {
          const mins = Math.max(1, Math.round((outcome.nextWakeAtMs - Date.now()) / 60000))
          logger.info(`workbuddy(${t.label}) 旅行：${entry.result}，${mins} 分钟后再看`)
        }
      } catch (error) {
        markTravelDirty()
        const entry = travelStoreData[id]
        if (entry !== undefined) {
          entry.attemptedAtMs = Date.now()
          entry.retryAfterMs = Date.now() + (TRAVEL_BACKOFF[0] as number)
        }
        scheduleOne(id, entry?.retryAfterMs)
        logger.warn(`workbuddy(${t.label}) 旅行出错：`, error instanceof Error ? error.message : String(error))
      } finally {
        travelInFlight.delete(id)
      }
    }

    /**
     * 重建旅行目标集合。
     *
     * `accounts.json` 变了（加号/删号）就重建，顺带剪掉状态里的孤儿条目；
     * 没变则什么都不做。调用方保证只在 mtime 变化时进来。
     */
    const rebuildTravelTargets = async (): Promise<void> => {
      const next = new Map<string, { id: string; label: string; region: WorkBuddyRegion; travel: WorkBuddyTravelService; keys: string[] }>()
      const claimed = new Set<string>()

      // 账号库账号（含 live 不可用时回填的同身份账号）。它们持有可用 token，优先于 live。
      for (const a of [...accountStores, ...backfilledStores]) {
        if (!travelSupported(a.region)) continue
        const keys = identityKeysOfRecord(a.account)
        if (keys.length === 0) continue
        if (keys.some(k => claimed.has(k))) continue
        keys.forEach(k => claimed.add(k))
        next.set(a.id, { id: a.id, label: a.label, region: a.region, travel: new WorkBuddyTravelService(a.store, client, travelWindow), keys })
      }

      // live 运行时：仅当该身份尚未被账号库覆盖时才纳入（账号库那份优先，因为它有可用 token）。
      for (const rt of runtimes) {
        if (rt.accountKey !== undefined) continue
        if (!travelSupported(rt.region)) continue
        const keys = liveIdentityKeys.get(rt.region) ?? []
        if (keys.length === 0) continue
        if (keys.some(k => claimed.has(k))) continue
        keys.forEach(k => claimed.add(k))
        next.set(rt.id, { id: rt.id, label: rt.label, region: rt.region, travel: new WorkBuddyTravelService(rt.store, client, travelWindow), keys })
      }

      // 目标集合有变化才动定时器，避免无谓重排。
      const sameIds = [...next.keys()].sort().join('|') === [...travelTargets.keys()].sort().join('|')
      travelTargets.clear()
      for (const [k, v] of next) travelTargets.set(k, v)

      // 剪掉孤儿状态条目：账号已删，状态留着只会让文件单调增长。
      let pruned = 0
      for (const key of Object.keys(travelStoreData)) {
        if (!travelTargets.has(key)) { delete travelStoreData[key]; pruned += 1 }
      }
      if (pruned > 0) { markTravelDirty(); logger.info(`旅行：清理 ${pruned} 个已删除账号的状态条目`) }

      if (!sameIds) {
        clearTravelTimers()
        for (const id of travelTargets.keys()) scheduleOne(id, Date.now())
        logger.info(`旅行目标已更新：${travelTargets.size} 个国内版账号${pruned > 0 ? `（清理 ${pruned} 条旧状态）` : ''}`)
      }
    }

    await rebuildTravelTargets()

    // 巡检：每 5 分钟只 stat accounts.json（本地磁盘操作、**零上游请求**），
    // mtime 变了才重建目标集合——这样加账号最多 5 分钟内生效，又不会空转打上游。
    let accountsSignature = await accounts.signature()
    travelSweepTimer = setInterval(() => {
      void (async () => {
        try {
          const sig = await accounts.signature()
          if (sig === accountsSignature) return
          accountsSignature = sig
          await accounts.load()
          await rebuildTravelTargets()
        } catch (error) {
          logger.warn('旅行：账号库巡检失败：', error instanceof Error ? error.message : String(error))
        }
      })()
    }, TRAVEL_SWEEP_MS)
    travelSweepTimer.unref()

    logger.info(`派猫猫旅行已启用：每账号独立计时，派遣→领取→再派遣循环（${travelTargets.size} 个国内版账号）`)

    // ---- 供 shim 使用的只读视图与手动派遣 ----
    // 刻意按 region 过滤：travelTargets 是全局的，若不按端口区域筛，
    // 国际版端口也会列出国内账号（实测踩过：两个端口返回同一份 cn 列表）。
    travelApi = {
      status: (region: WorkBuddyRegion) => {
        const today = travelLocalDate()
        const nowSec = Math.floor(Date.now() / 1000)
        const accounts = []
        for (const t of travelTargets.values()) {
          if (t.region !== region) continue
          const entry = rollTravelStateToToday(travelStoreData[t.id] ?? createTravelState(today), today)
          accounts.push({
            id: t.id,
            label: t.label,
            region: t.region,
            state: entry.state,
            locationName: entry.locationName ?? '',
            durationHours: entry.durationHours ?? 0,
            // 同时给出 arriveAt 与 serverNow：前端算一次差值后本地倒计时，不必每次问后端。
            arriveAt: entry.arriveAt,
            serverNow: nowSec,
            rewardCredit: entry.rewardCredit ?? 0,
            claimedCredit: entry.claimedCredit ?? 0,
            claimedAtMs: entry.claimedAtMs ?? 0,
            done: entry.done,
            doneReason: entry.doneReason ?? null,
            result: entry.result ?? '',
          })
        }
        return { accounts, window: travelWindow, nowMs: Date.now() }
      },
      depart: async (region: WorkBuddyRegion, onlyId?: string) => {
        const targets = [...travelTargets.values()]
          .filter(t => t.region === region)
          .filter(t => onlyId === undefined || t.id === onlyId)
        if (targets.length === 0) return { results: [] as Array<{ id: string; label: string; ok: boolean; message: string }> }
        const results: Array<{ id: string; label: string; ok: boolean; message: string }> = []
        for (const [i, t] of targets.entries()) {
          // 账号间错开 2 秒，避免集中打上游触发 QPS 限流。
          if (i > 0) await new Promise(r => setTimeout(r, TRAVEL_DEPART_STAGGER_MS))
          if (travelInFlight.has(t.id)) {
            results.push({ id: t.id, label: t.label, ok: false, message: '该账号正在处理中，请稍候' })
            continue
          }
          travelInFlight.add(t.id)
          try {
            const today = travelLocalDate()
            const entry = rollTravelStateToToday(travelStoreData[t.id] ?? createTravelState(today), today)
            travelStoreData[t.id] = entry
            const out = await t.travel.departNow(entry)
            markTravelDirty()
            scheduleOne(t.id, Date.now() + MAX_TRAVEL_SLEEP_MS)
            results.push({ id: t.id, label: t.label, ok: out.ok, message: out.message })
            logger.info(`workbuddy(${t.label}) 手动派遣：${out.message}`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            results.push({ id: t.id, label: t.label, ok: false, message: `派遣失败：${message}` })
            logger.warn(`workbuddy(${t.label}) 手动派遣失败：`, message)
          } finally {
            travelInFlight.delete(t.id)
          }
        }
        return { results }
      },
    }
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
    for (const t of travelTimers.values()) clearTimeout(t)
    travelTimers = new Map()
    if (travelSweepTimer !== undefined) clearInterval(travelSweepTimer)
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
