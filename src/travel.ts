/**
 * WorkBuddy「派猫猫旅行」（成长中心）适配层。
 *
 * ## 循环语义
 *
 * 旅行**不是每天一次**，而是一个循环：
 *
 *   idle ──depart──▶ traveling ──(到点)──▶ arrived ──claim──▶ idle ──depart──▶ …
 *
 * 由 serve.ts 为每个账号挂一个独立定时器，每次唤醒调用一次 {@link
 * WorkBuddyTravelService.tick}，由它决定「派 / 领 / 等 / 歇到次日」，
 * 并给出**下一次真正需要醒来的时刻**（`nextWakeAtMs`）。没有固定轮询。
 *
 * ## 实测得到的三条硬事实（2026-09，用真实响应核对，勿再凭注释推断）
 *
 * 1. **`buddy_id` 不是「有没有 Buddy」，而是「当前行程有没有绑定 Buddy」。**
 *    领取之后行程结束，它就归零——而那恰恰是**该再派一次**的状态。
 *    早先版本把 `buddy_id === 0` 当成「无 Buddy → 今日放弃」，方向完全搞反，
 *    导致领完奖后再也不会派第二次。**不要再用 buddy_id 判断有无 Buddy。**
 *
 * 2. **「有无 Buddy」的唯一权威判据是 `depart` 返回 `no active buddy`。**
 *    `/buddy/info` 返回 `buddy: null` 也是佐证，但不必额外调用。
 *
 * 3. **能否再派由 `daily_limit_reached` 决定，不由「一天一次」决定。**
 *    派出后它变 `true`；领取后是否回落到 `false` 由服务端说了算，
 *    所以这里**不写死任何「一天一次」的假设**，只忠实转述服务端状态。
 *
 * ## 时间处理
 *
 * - `arrive_at` / `depart_at` / `server_now` 是平台内部时间戳，与真实 Unix 秒同量级。
 *   判定「到没到」只用差值 `arrive_at - server_now`，**绝不与本机时钟比较**，
 *   因此本机时钟偏差、夏令时都不影响结果。
 * - 时间窗（可派时段）用**服务端 `server_now`** 判定，同样不依赖本机时区。
 *
 * @module workbuddy-proxy/travel
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyUpstreamClient, WorkBuddyTravelLocation, WorkBuddyTravelStatus } from './upstream.ts'

/** 只要求 resolve()，LiveCredentialStore 与 AccountCredentialStore 都满足。 */
export interface TravelCredentialStore {
  resolve(): Promise<WorkBuddyCredential>
}

/** 可派时间窗（按服务端本地时间的小时数，[start, end)）。窗外不派，领取不受影响。 */
export interface TravelWindow {
  startHour: number
  endHour: number
}

/** 默认窗口：08:00–23:00。深夜不派新猫，夜里落地的行程照常领取。 */
export const DEFAULT_TRAVEL_WINDOW: TravelWindow = { startHour: 8, endHour: 23 }

/** 到点后延迟多久去领奖（ms）。服务端 arrive_at 按分钟取整，掐点领可能被判「尚未到达」。 */
export const CLAIM_GRACE_MS = 3 * 60 * 1000

/** 单次休眠上限（ms）：即便算出 6 小时后才到点也最多睡这么久，防止状态异常时睡死。 */
export const MAX_SLEEP_MS = 6 * 60 * 60 * 1000

/** 领取成功后的重查间隔（ms）：给服务端一点时间回落 daily_limit，然后继续派。 */
export const REDISPATCH_DELAY_MS = 60 * 1000

/** 瞬时失败的指数退避序列（ms），最后一个值会一直沿用。 */
export const BACKOFF_LADDER_MS: readonly number[] = [
  10 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
]

/** 同一行程连续领取失败多少次后，改查 status 自愈。 */
export const MAX_CLAIM_ATTEMPTS = 3

/** 连续失败多少次后暂停到次日，避免死磕上游。 */
export const MAX_CONSECUTIVE_FAILURES = 6

/** 单账号的旅行状态，持久化到 state/travel-state.json。 */
export interface TravelState {
  /** 本地日期 YYYY-MM-DD；跨天重置每日字段 */
  date: string
  /** 今日是否已派出过 */
  departed: boolean
  /** 当前行程的 record_id，claim 时需要 */
  recordId: number
  /** 出发/到达时刻，取自服务端；仅用于展示与差值计算，勿与本地时钟比较 */
  departAt: number
  arriveAt: number
  /** 最近一次观察到的服务端状态，供面板展示 */
  state: 'idle' | 'traveling' | 'arrived'
  /** 去过的地点名 */
  locationName?: string
  /** 行程时长（小时） */
  durationHours?: number
  /** 预计/实际奖励积分 */
  rewardCredit?: number
  /** 今日收工：今日已派完 / 窗外 / 确认无 Buddy。跨天重置 */
  done: boolean
  /** 收工原因，供面板区分「今日已派」与「无 Buddy」 */
  doneReason?: 'daily-limit' | 'no-buddy' | 'window' | 'claimed'
  /** 面板展示用的一句话结果 */
  result?: string
  /** 最近一次领取成功的时刻（ms），用于「刚领到 +N 积分」的展示窗口 */
  claimedAtMs?: number
  /** 最近一次领取到的积分 */
  claimedCredit?: number
  /** 本行程已尝试领取的次数；达到 MAX_CLAIM_ATTEMPTS 后改查 status 自愈 */
  claimAttempts: number
  /** 连续失败次数；达到 MAX_CONSECUTIVE_FAILURES 后暂停到次日 */
  failures: number
  /** 失败重试的冷却截止时刻（绝对 ms） */
  retryAfterMs?: number
  /** 最近一次动作时间（ms） */
  attemptedAtMs?: number
}

export type TravelStateStore = Record<string, TravelState>

/** 判定结果，交给调度器决定何时再唤醒。 */
export interface TravelTickOutcome {
  /** 本次是否真的写上游（depart / claim） */
  acted: boolean
  /** 一句话结果，写入状态并打日志 */
  message: string
  /** true = 该账号今日无需再管 */
  done: boolean
  /** 该账号下一次需要被查看的绝对时刻（ms）；undefined = 交给调用方排兜底 */
  nextWakeAtMs?: number
}

export function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 构造一份「今天」的初始状态。 */
export function createTravelState(today = localDate()): TravelState {
  return {
    date: today,
    departed: false,
    recordId: 0,
    departAt: 0,
    arriveAt: 0,
    state: 'idle',
    done: false,
    claimAttempts: 0,
    failures: 0,
  }
}

/**
 * 跨天则重置每日字段；未跨天原样返回。
 *
 * 刻意**不在跨天时保留**「正在旅行」：行程跨零点属于极端边界，此时重置为 idle
 * 会让程序重新派一次，而被服务端以「今日已派」挡回——代价只是一次请求，
 * 好过把昨天的 record_id 带进今天去 claim。
 */
export function rollTravelStateToToday(entry: TravelState, today = localDate()): TravelState {
  if (entry.date === today) return entry
  const fresh = createTravelState(today)
  // 保留历史展示信息，方便面板回溯上一次行程结果。
  if (entry.locationName !== undefined) fresh.locationName = entry.locationName
  if (entry.rewardCredit !== undefined) fresh.rewardCredit = entry.rewardCredit
  if (entry.claimedCredit !== undefined) fresh.claimedCredit = entry.claimedCredit
  if (entry.claimedAtMs !== undefined) fresh.claimedAtMs = entry.claimedAtMs
  return fresh
}

/** 距离到达还有多少秒（服务端时间戳之差，≤0 表示已到）。 */
function secondsUntilArrival(status: WorkBuddyTravelStatus): number {
  if (status.arriveAt <= 0 || status.serverNow <= 0) return 0
  return status.arriveAt - status.serverNow
}

/** 把服务端「当前时刻」换算成本地日期，用于跨天判定（跟随服务端时区而非本机）。 */
function serverLocalDate(serverNowSec: number): string {
  return localDate(new Date(serverNowSec * 1000))
}

function minutesLeftText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  if (minutes < 60) return `约 ${minutes} 分钟后到达`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `约 ${hours} 小时后到达` : `约 ${hours} 小时 ${rest} 分钟后到达`
}

/** 是否处于可派时间窗内。用服务端小时数，免疫本机时区与夏令时。 */
export function withinWindow(serverNowSec: number, window: TravelWindow): boolean {
  if (serverNowSec <= 0) return true
  const hour = new Date(serverNowSec * 1000).getHours()
  return hour >= window.startHour && hour < window.endHour
}

/** 距下一个可派时刻的毫秒数（已在窗内则返回 0）。 */
export function msUntilWindowOpens(serverNowSec: number, window: TravelWindow, nowMs: number): number {
  if (withinWindow(serverNowSec, window)) return 0
  const d = new Date(serverNowSec * 1000)
  const next = new Date(d)
  next.setHours(window.startHour, 5, 0, 0)
  if (next.getTime() <= d.getTime()) next.setDate(next.getDate() + 1)
  // 用差值换算，不把绝对时刻当 Unix 秒用。
  const deltaSec = Math.floor((next.getTime() - d.getTime()) / 1000)
  return Math.max(60_000, deltaSec * 1000)
}

/** 把服务端 status 的最新事实同步进本地 entry。 */
function syncFromStatus(entry: TravelState, status: WorkBuddyTravelStatus): void {
  entry.recordId = status.recordId > 0 ? status.recordId : entry.recordId
  if (status.departAt > 0) entry.departAt = status.departAt
  if (status.arriveAt > 0) entry.arriveAt = status.arriveAt
  if (status.locationName !== '') entry.locationName = status.locationName
  if (status.durationHours > 0) entry.durationHours = status.durationHours
  if (status.rewardCredit > 0) entry.rewardCredit = status.rewardCredit
  entry.state = status.state
}

/** 到达时刻 + 余量，换算成绝对唤醒时刻。 */
function wakeAtFromStatus(status: WorkBuddyTravelStatus, nowMs: number): number {
  const leftSec = secondsUntilArrival(status)
  return nowMs + (leftSec > 0 ? leftSec * 1000 : 0) + CLAIM_GRACE_MS
}

/** 瞬时失败的退避时长：按连续失败次数取阶梯值，最后一档封顶。 */
export function backoffMs(failures: number): number {
  const i = Math.min(Math.max(failures, 1), BACKOFF_LADDER_MS.length) - 1
  return BACKOFF_LADDER_MS[i] as number
}

export class WorkBuddyTravelService {
  private readonly store: TravelCredentialStore
  private readonly client: WorkBuddyUpstreamClient
  private readonly window: TravelWindow

  constructor(store: TravelCredentialStore, client: WorkBuddyUpstreamClient, window: TravelWindow = DEFAULT_TRAVEL_WINDOW) {
    this.store = store
    this.client = client
    this.window = window
  }

  /** 查一次服务端旅行状态（只读）。 */
  async getStatus(): Promise<WorkBuddyTravelStatus> {
    const credential = await this.store.resolve()
    return await this.client.fetchTravelStatus(credential)
  }

  /**
   * 执行一次推进，并给出下一次唤醒时刻。
   *
   * `entry` 由调用方持有并先经 {@link rollTravelStateToToday} 处理；本方法就地更新它。
   */
  async tick(entry: TravelState): Promise<TravelTickOutcome> {
    const nowMs = Date.now()
    // 失败冷却中：直接睡到冷却结束，不打上游。
    if (entry.retryAfterMs !== undefined && nowMs < entry.retryAfterMs) {
      return { acted: false, message: entry.result ?? '等待重试', done: false, nextWakeAtMs: entry.retryAfterMs }
    }
    // 连续失败过多：暂停到次日，别死磕。
    if (entry.failures >= MAX_CONSECUTIVE_FAILURES) {
      return this.rest(entry, '连续失败过多，暂停到次日', 'claimed', nowMs)
    }

    let status: WorkBuddyTravelStatus
    try {
      status = await this.getStatus()
    } catch (error) {
      return this.onFailure(entry, `读取状态失败：${error instanceof Error ? error.message : String(error)}`, nowMs)
    }

    // 服务端换日：以服务端日期为准重置，跨天则 daily_limit 也会随之重置。
    const today = status.serverNow > 0 ? serverLocalDate(status.serverNow) : localDate()
    if (entry.date !== today) {
      const rolled = rollTravelStateToToday(entry, today)
      Object.assign(entry, rolled)
    }

    syncFromStatus(entry, status)

    const leftSec = secondsUntilArrival(status)

    // 1) 行程在途且未到点：睡到落地点。这是绝大多数轮次。
    if (status.state !== 'idle' && leftSec > 0) {
      entry.attemptedAtMs = nowMs
      const message = `旅行中：${status.locationName || '路上'}（${minutesLeftText(leftSec)}）`
      entry.result = message
      return { acted: false, message, done: false, nextWakeAtMs: wakeAtFromStatus(status, nowMs) }
    }

    // 2) 有可领的行程：领取。
    if (status.state !== 'idle' && status.recordId > 0) {
      if (entry.claimAttempts >= MAX_CLAIM_ATTEMPTS) {
        // 连续领不到：改用 status 自愈——服务端已回落到 idle 就当作已领。
        if (status.state === 'idle') {
          return this.finishClaimed(entry, status.rewardCredit, '奖励已领（服务端已结算）', nowMs)
        }
        entry.claimAttempts = 0
      }
      return await this.claim(entry, status, nowMs)
    }

    // 3) 空闲：能否再派由服务端说了算。
    if (status.dailyLimitReached) {
      return this.rest(entry, '今日已派（达每日上限）', 'daily-limit', nowMs)
    }
    if (!withinWindow(status.serverNow, this.window)) {
      return this.rest(entry, '不在可派时段', 'window', nowMs)
    }
    return await this.depart(entry, nowMs)
  }

  /**
   * 手动派遣（供面板「立即派遣」调用）。
   *
   * 刻意**不检查** `daily_limit_reached` 与时间窗：按钮点了才判定，正确性交给服务端，
   * 前端不做「本地预判是否可派」的判断，避免本地状态陈旧导致误禁用。
   * 重复点击被服务端 daily_limit 吸收，这里只如实转述结果。
   */
  async departNow(entry: TravelState): Promise<{ ok: boolean; message: string; status: WorkBuddyTravelStatus }> {
    const nowMs = Date.now()
    const status = await this.getStatus()
    // 无论走哪个分支都先同步：面板读的是本地 entry，不同步就会显示陈旧的 state。
    syncFromStatus(entry, status)
    entry.attemptedAtMs = nowMs

    const leftSec = secondsUntilArrival(status)
    if (status.state !== 'idle' && leftSec > 0) {
      const message = `旅行中：${status.locationName || '路上'}（${minutesLeftText(leftSec)}）`
      entry.result = message
      return { ok: false, message, status }
    }
    if (status.dailyLimitReached) {
      const message = '今日已派（达每日上限）'
      entry.result = message
      entry.done = true
      entry.doneReason = 'daily-limit'
      return { ok: false, message, status }
    }
    const outcome = await this.doDepart(entry, status, nowMs)
    return { ok: outcome.acted, message: outcome.message, status }
  }

  /** 今日收工：睡到次日窗口开启。 */
  private rest(entry: TravelState, message: string, reason: TravelState['doneReason'], nowMs: number): TravelTickOutcome {
    entry.done = true
    entry.doneReason = reason
    entry.attemptedAtMs = nowMs
    entry.result = message
    // 次日 00:05 左右再由兜底定时器叫醒；精确到点由调用方重排。
    const next = new Date(nowMs)
    next.setHours(24, 5, 0, 0)
    return { acted: false, message, done: true, nextWakeAtMs: next.getTime() }
  }

  /**
   * 领取成功后收尾。
   *
   * **实测确认（2026-09-27）：每日派遣上限是「每账号每天 1 次」的硬性次数上限，
   * 领取后不会重置。** 证据：领取后 status 为 `state=idle, daily_limit=true`，
   * 再次 depart 被拒 `message="daily limit reached", code=400`；且 config 响应里
   * **没有任何积分预算字段**（只有 locations / intro_slogans / server_now），
   * 所以不是「额度用完」而是「次数用完」。
   *
   * 因此这里**不安排 60 秒后重查**——重查必然仍是 daily_limit，纯属浪费请求。
   * 直接睡到次日：想再派就等第二天，服务端会自己把 daily_limit 归零。
   * 保留 `REDISPATCH_DELAY_MS` 供将来服务端若改为可重复派遣时使用。
   */
  private finishClaimed(entry: TravelState, credit: number, message: string, nowMs: number): TravelTickOutcome {
    entry.done = true
    entry.doneReason = 'claimed'
    entry.departed = true
    entry.state = 'idle'
    entry.claimAttempts = 0
    entry.failures = 0
    entry.retryAfterMs = undefined
    entry.claimedAtMs = nowMs
    if (credit > 0) entry.claimedCredit = credit
    const text = credit > 0 ? `${message}，+${credit} 积分` : message
    entry.result = text
    // 次日 00:05 醒，届时服务端已把 daily_limit 归零，可以再派。
    const next = new Date(nowMs)
    next.setHours(24, 5, 0, 0)
    return { acted: true, message: text, done: true, nextWakeAtMs: next.getTime() }
  }

  /** 瞬时失败：退避重试；连续过多则暂停到次日。 */
  private onFailure(entry: TravelState, message: string, nowMs: number): TravelTickOutcome {
    entry.failures += 1
    entry.attemptedAtMs = nowMs
    if (entry.failures >= MAX_CONSECUTIVE_FAILURES) {
      entry.done = true
      entry.doneReason = 'claimed'
      entry.result = `${message}（连续失败 ${entry.failures} 次，暂停到次日）`
      const next = new Date(nowMs)
      next.setHours(24, 5, 0, 0)
      return { acted: false, message: entry.result, done: true, nextWakeAtMs: next.getTime() }
    }
    entry.retryAfterMs = nowMs + backoffMs(entry.failures)
    entry.result = message
    return { acted: false, message, done: false, nextWakeAtMs: entry.retryAfterMs }
  }

  /** 派猫出发（由 tick 调用，已确认可派）。 */
  private async depart(entry: TravelState, nowMs: number): Promise<TravelTickOutcome> {
    let status: WorkBuddyTravelStatus
    try {
      status = await this.getStatus()
    } catch (error) {
      return this.onFailure(entry, `读取状态失败：${error instanceof Error ? error.message : String(error)}`, nowMs)
    }
    return await this.doDepart(entry, status, nowMs)
  }

  /**
   * depart 的实际动作，tick 与 {@link departNow} 共用。
   *
   * 就地更新 `entry`，因此手动派遣后面板也能立刻看到新行程。
   */
  private async doDepart(
    entry: TravelState,
    known: WorkBuddyTravelStatus,
    nowMs: number,
  ): Promise<TravelTickOutcome> {
    const credential = await this.store.resolve()
    const config = await this.client.fetchTravelConfig(credential)
    const locations = config.locations
    if (!config.enabled || locations.length === 0) {
      return this.onFailure(entry, '无可用旅行地点', nowMs)
    }

    // 随机选点（无偏好：时长与奖励都是区间，随机即可）。
    const pick = locations[Math.floor(Math.random() * locations.length)] as WorkBuddyTravelLocation
    let res: Awaited<ReturnType<WorkBuddyUpstreamClient['departTravel']>>
    try {
      res = await this.client.departTravel(credential, pick.id)
    } catch (error) {
      return this.onFailure(entry, `派发失败：${error instanceof Error ? error.message : String(error)}`, nowMs)
    }

    entry.attemptedAtMs = nowMs

    if (!res.ok) {
      // 并发 / 网页端抢先：当成已在旅行，按落地点排下一次。
      if (res.already) {
        const status = await this.getStatus()
        syncFromStatus(entry, status)
        entry.departed = true
        entry.done = false
        entry.doneReason = undefined
        const message = `已在旅行中：${status.locationName || pick.name}`
        entry.result = message
        return { acted: true, message, done: false, nextWakeAtMs: wakeAtFromStatus(status, nowMs) }
      }
      // 服务端权威判定：这个账号真的没有 Buddy。
      if (res.noBuddy) return this.rest(entry, '无 Buddy，跳过旅行', 'no-buddy', nowMs)
      if (res.dailyLimitReached) return this.rest(entry, '今日已派（达每日上限）', 'daily-limit', nowMs)
      entry.result = `派发失败：${res.message}`
      return this.onFailure(entry, entry.result, nowMs)
    }

    // 派出成功：再查一次拿 arrive_at / record_id。
    const status = await this.getStatus()
    syncFromStatus(entry, status)
    entry.departed = true
    entry.done = false
    entry.doneReason = undefined
    entry.claimAttempts = 0
    entry.failures = 0
    entry.retryAfterMs = undefined
    const place = status.locationName !== '' ? status.locationName : pick.name
    entry.locationName = place
    const left = secondsUntilArrival(status)
    const message = `已出发去「${place}」${left > 0 ? `（${minutesLeftText(left)}）` : ''}`
    entry.result = message
    return { acted: true, message, done: false, nextWakeAtMs: wakeAtFromStatus(status, nowMs) }
  }

  /** 领奖。 */
  private async claim(entry: TravelState, status: WorkBuddyTravelStatus, nowMs: number): Promise<TravelTickOutcome> {
    const recordId = status.recordId > 0 ? status.recordId : entry.recordId
    entry.claimAttempts += 1
    entry.attemptedAtMs = nowMs

    let result: Awaited<ReturnType<WorkBuddyUpstreamClient['claimTravel']>>
    try {
      const credential = await this.store.resolve()
      result = await this.client.claimTravel(credential, recordId)
    } catch (error) {
      return this.onFailure(entry, `领取失败：${error instanceof Error ? error.message : String(error)}`, nowMs)
    }

    if (!result.ok) {
      if (result.nothingToClaim) {
        // 已被网页端领走或服务端已结算：算完成，继续下一轮循环。
        return this.finishClaimed(entry, status.rewardCredit, '奖励已领（服务端已结算）', nowMs)
      }
      if (result.notArrivedYet) {
        entry.result = '尚未到达，稍后重试'
        entry.retryAfterMs = nowMs + CLAIM_GRACE_MS
        return { acted: true, message: entry.result, done: false, nextWakeAtMs: entry.retryAfterMs }
      }
      return this.onFailure(entry, `领奖失败：${result.message}`, nowMs)
    }

    const credit = result.rewardCredit ?? status.rewardCredit
    if (status.locationName !== '') entry.locationName = status.locationName
    if (credit > 0) entry.rewardCredit = credit
    return this.finishClaimed(entry, credit, '已领取奖励', nowMs)
  }
}
