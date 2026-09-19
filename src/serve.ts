/**
 * workbuddy-proxy 守护入口：一个进程同时服务国内版与国际版两个回环端点。
 *
 * 改自 dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）。
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行，无需构建。
 *
 * @module workbuddy-proxy/serve
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveCredentialStore } from './auth.ts'
import { AccountCredentialStore } from './account-store.ts'
import { AccountStore, regionOfDomain, type StoredAccount } from './accounts.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim, type ShimLogger } from './shim.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyRegion } from './upstream.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { WorkBuddySigninService } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'

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
  shim?: WorkBuddyShim
}

const REGION_PORTS: Record<WorkBuddyRegion, number> = {
  cn: Number(process.env['WORKBUDDY_CN_PORT'] ?? 39301),
  global: Number(process.env['WORKBUDDY_GLOBAL_PORT'] ?? 39302),
}

function ts(): string {
  return new Date().toISOString()
}

const logger: ShimLogger = {
  info: (...args) => process.stdout.write(`[${ts()}] [info] ${args.map(String).join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[${ts()}] [warn] ${args.map(String).join(' ')}\n`),
  error: (...args) => process.stderr.write(`[${ts()}] [error] ${args.map(String).join(' ')}\n`),
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

  // 共享签到状态文件（live 与账号共用一份，target 名区分）
  const schedulerOf = (): SigninScheduler => new SigninScheduler({
    stateFile: join(STATE_DIR, 'signin-state.json'),
    startHour: SIGNIN_START_HOUR,
    endHour: SIGNIN_END_HOUR,
    log: m => logger.info(m),
  })

  const runtimes: RegionRuntime[] = []
  const accounts = new AccountStore(ACCOUNTS_FILE)

  // ---- 模式 1：跟随官方 live 登录态（原有行为，端口 39301/39302）----
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
        scheduler: schedulerOf(),
      })
    }
  }

  // ---- 模式 2：账号库（每账号一端口，39320 起）----
  const stored: StoredAccount[] = await accounts.load()
  stored.forEach((account, index) => {
    const region = account.region ?? regionOfDomain(account.domain)
    const store = new AccountCredentialStore({
      accountKey: account.key,
      region,
      accounts,
      refresh: credential => client.refreshToken(credential),
    })
    runtimes.push({
      id: `acct:${account.key}`,
      label: `${region}·${account.nickname ?? account.uin ?? account.label}`,
      region,
      port: ACCOUNT_PORT_BASE + index,
      keyFile: join(KEYS_DIR, `acct-${index}.key`),
      store,
      client,
      catalog: new WorkBuddyCatalog(region),
      signin: new WorkBuddySigninService(store, client),
      scheduler: schedulerOf(),
      accountKey: account.key,
    })
  })

  if (runtimes.length === 0) {
    logger.warn('没有可用的运行时（live 模式关闭且账号库为空）')
  }

  const shims: WorkBuddyShim[] = []
  for (const rt of runtimes) {
    if (SIGNIN_ENABLED) {
      const plan = await rt.scheduler.plan(rt.id)
      logger.info(`workbuddy(${rt.label}) 今日签到计划 ${formatSec(plan.runAtSec)}`)
    }
    const token = await loadOrCreateKey(rt.keyFile)
    const shim = createWorkBuddyShim({
      region: rt.region,
      port: rt.port,
      token,
      store: rt.store,
      client,
      catalog: rt.catalog,
      logger,
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

  // 每日签到：到当天随机时刻自动领取（每个运行时独立随机）
  async function signinTick(): Promise<void> {
    for (const rt of runtimes) {
      try {
        await rt.scheduler.runIfDue(rt.id, () => rt.signin.claim())
      } catch {
        // 未登录 / token 失效：静默跳过
      }
    }
  }
  if (SIGNIN_ENABLED) {
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    signinTimer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    signinTimer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取（每账号独立）`)
  }

  // 每 6 小时刷新一次模型目录
  const REFRESH_INTERVAL = 6 * 60 * 60 * 1000
  const timer = setInterval(() => {
    for (const rt of runtimes) void refreshModels(rt)
  }, REFRESH_INTERVAL)
  timer.unref()

  const liveCount = runtimes.filter(r => r.accountKey === undefined).length
  const acctCount = runtimes.length - liveCount
  logger.info(
    `workbuddy-proxy ${WORKBUDDY_CONNECT_VERSION} 就绪：`
    + `live ${liveCount} 个（${REGION_PORTS.cn}/${REGION_PORTS.global}）`
    + (acctCount > 0 ? ` + 账号 ${acctCount} 个（端口 ${ACCOUNT_PORT_BASE} 起）` : ''),
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
