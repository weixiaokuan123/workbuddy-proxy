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

const SIGNIN_ENABLED = (process.env['WORKBUDDY_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['WORKBUDDY_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['WORKBUDDY_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

interface RegionRuntime {
  region: WorkBuddyRegion
  port: number
  keyFile: string
  store: LiveCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  signin: WorkBuddySigninService
  scheduler: SigninScheduler
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

  const runtimes: RegionRuntime[] = (['cn', 'global'] as WorkBuddyRegion[]).map(region => {
    const store = new LiveCredentialStore({
      region,
      refresh: credential => client.refreshToken(credential),
    })
    const scheduler = new SigninScheduler({
      stateFile: join(STATE_DIR, 'signin-state.json'),
      startHour: SIGNIN_START_HOUR,
      endHour: SIGNIN_END_HOUR,
      log: m => logger.info(m),
    })
    return {
      region,
      port: REGION_PORTS[region],
      keyFile: join(KEYS_DIR, `${region}.key`),
      store,
      client,
      catalog: new WorkBuddyCatalog(region),
      signin: new WorkBuddySigninService(store, client),
      scheduler,
    }
  })

  if (SIGNIN_ENABLED) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })

  const shims: WorkBuddyShim[] = []
  for (const rt of runtimes) {
    if (SIGNIN_ENABLED) {
      const plan = await rt.scheduler.plan(rt.region)
      logger.info(`workbuddy(${rt.region}) 今日签到计划 ${formatSec(plan.runAtSec)}`)
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
        const entry = await rt.scheduler.entry(rt.region) ?? await rt.scheduler.plan(rt.region)
        let view: unknown = null
        let error: string | undefined
        try { view = await rt.signin.getStatus() }
        catch (e) { error = e instanceof Error ? e.message : String(e) }
        return {
          region: rt.region,
          scheduledAt: formatSec(entry.runAtSec),
          claimedToday: entry.claimed,
          lastResult: entry.result,
          view,
          ...(error === undefined ? {} : { error }),
        }
      } : undefined,
      signinClaim: SIGNIN_ENABLED ? async () => {
        const outcome = await rt.scheduler.runNow(rt.region, () => rt.signin.claim())
        return { region: rt.region, ...outcome }
      } : undefined,
    })
    rt.shim = shim
    shims.push(shim)
    await shim.ready
    logger.info(
      `workbuddy(${rt.region}) 已监听 ${shim.baseUrl()} `
      + `(key=${rt.keyFile}, models=${rt.catalog.current().length})`,
    )
    // 不阻塞启动：尽力刷新线上目录
    void refreshModels(rt)
  }

  // 每日签到：到当天随机时刻自动领取
  async function signinTick(): Promise<void> {
    for (const rt of runtimes) {
      try {
        await rt.scheduler.runIfDue(rt.region, () => rt.signin.claim())
      } catch {
        // 未登录 / token 失效：静默跳过
      }
    }
  }
  if (SIGNIN_ENABLED) {
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    signinTimer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    signinTimer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取`)
  }

  // 每 6 小时刷新一次模型目录
  const REFRESH_INTERVAL = 6 * 60 * 60 * 1000
  const timer = setInterval(() => {
    for (const rt of runtimes) void refreshModels(rt)
  }, REFRESH_INTERVAL)
  timer.unref()

  logger.info(`workbuddy-proxy ${WORKBUDDY_CONNECT_VERSION} 就绪：国内 ${REGION_PORTS.cn} / 国际 ${REGION_PORTS.global}`)

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
