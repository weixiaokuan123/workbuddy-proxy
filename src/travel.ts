/**
 * WorkBuddy「派猫猫旅行」（成长中心）适配层。
 *
 * 与每日签到不同，旅行不是「每天随机一次」而是两阶段状态机：
 *
 *   idle ──depart──▶ traveling ──(arrive_at 到点)──▶ arrived ──claim──▶ idle
 *
 * 因此本模块不套用 {@link SigninScheduler}（随机时刻语义不匹配），而是
 * 由 serve.ts 按固定间隔轮询 {@link WorkBuddyTravelService.tick}：
 *   - idle 且未达每日上限   → depart（随机挑一个地点）
 *   - traveling 且已到点     → claim 领积分
 *   - traveling 未到点       → 什么都不做
 *   - 无 Buddy（buddy_id=0） → 全程跳过，不发任何 depart
 *
 * 实测要点（2026-09，已用真实响应核对，勿再凭源码注释推断）：
 *   - 成长中心**只有国内版**有；国际版账号一律不调用（见 travelSupported）。
 *   - status 的 `daily_limit_reached` 在 `traveling` 时就是 `true`：
 *     即「每天只能派一次」，派出即达上限。故领取后**不可再派**，
 *     判断「今天还有没有事做」只看 `daily_limit_reached`，不看 state。
 *   - `arrive_at` / `depart_at` / `server_now` 是**平台内部的朴素时间戳**，
 *     不是 Unix 秒（写此文件时实测 arrive_at 约 1.79e9，与真实秒级相差甚远）。
 *     因此**只使用它们之间的差值**（`arrive_at - server_now`）判断到没到点，
 *     绝不把绝对值和本地时钟做比较。
 *   - 「到点但服务端仍报 traveling」是正常现象：以时间差为准自行推进到 claim。
 *
 * @module workbuddy-proxy/travel
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyUpstreamClient, WorkBuddyTravelLocation, WorkBuddyTravelStatus } from './upstream.ts'

/** 只要求 resolve()，LiveCredentialStore 与 AccountCredentialStore 都满足。 */
export interface TravelCredentialStore {
  resolve(): Promise<WorkBuddyCredential>
}

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
  /** 最近一次观察到服务端状态（每次 tick 都会写回，供面板展示） */
  state: 'idle' | 'traveling' | 'arrived'
  /** 去过的地点名 */
  locationName?: string
  /** 行程时长（小时） */
  durationHours?: number
  /** 预计/实际奖励积分 */
  rewardCredit?: number
  /** 今日是否已完成（领过奖 / 无 Buddy / 达每日上限） */
  done: boolean
  /** 面板展示用的一句话结果 */
  result?: string
  /** 最近一次尝试时间 ms */
  attemptedAtMs?: number
  /** 失败重试的冷却截止时刻 ms */
  retryAfterMs?: number
}

export type TravelStateStore = Record<string, TravelState>

/** 判定结果，交给 tick 决定是否继续。 */
export interface TravelTickOutcome {
  /** 本次是否真的调用了上游 */
  acted: boolean
  /** 一句话结果，写入状态并打日志 */
  message: string
  /** true = 今日该账号已无待办（已领/无 Buddy/达上限），当天不再重试 */
  done: boolean
}

/** 未成功且值得重试时的冷却（10 分钟）：旅行是长周期动作，无需高频重试。 */
export const RETRY_COOLDOWN_MS = 10 * 60 * 1000

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
  }
}

/**
 * 跨天则重置每日字段；未跨天原样返回。
 *
 * 刻意**不在跨天时保留**「正在旅行」：行程跨零点属于极端边界，此时重置为
 * idle 会让程序重新派一次，而被服务端以「今日已派」挡回——代价只是一次
 * 请求，好过把昨天的 record_id 带进今天去 claim。
 */
export function rollTravelStateToToday(entry: TravelState, today = localDate()): TravelState {
  if (entry.date === today) return entry
  const fresh = createTravelState(today)
  // 保留历史展示信息，方便面板回溯上一次行程结果。
  if (entry.locationName !== undefined) fresh.locationName = entry.locationName
  if (entry.rewardCredit !== undefined) fresh.rewardCredit = entry.rewardCredit
  return fresh
}

/** 距离到达还有多少秒（以服务端时间戳之差计算，负数表示已到）。 */
function secondsUntilArrival(status: WorkBuddyTravelStatus): number {
  if (status.arriveAt <= 0 || status.serverNow <= 0) return 0
  return status.arriveAt - status.serverNow
}

function minutesLeftText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  if (minutes < 60) return `约 ${minutes} 分钟后到达`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `约 ${hours} 小时后到达` : `约 ${hours} 小时 ${rest} 分钟后到达`
}

/** 把服务端 status 的最新事实同步进本地 entry（每次 tick 都做，面板据此展示）。 */
function syncFromStatus(entry: TravelState, status: WorkBuddyTravelStatus): void {
  entry.recordId = status.recordId > 0 ? status.recordId : entry.recordId
  if (status.departAt > 0) entry.departAt = status.departAt
  if (status.arriveAt > 0) entry.arriveAt = status.arriveAt
  if (status.locationName !== '') entry.locationName = status.locationName
  if (status.durationHours > 0) entry.durationHours = status.durationHours
  if (status.rewardCredit > 0) entry.rewardCredit = status.rewardCredit
  entry.state = status.state
}

export class WorkBuddyTravelService {
  private readonly store: TravelCredentialStore
  private readonly client: WorkBuddyUpstreamClient

  constructor(store: TravelCredentialStore, client: WorkBuddyUpstreamClient) {
    this.store = store
    this.client = client
  }

  /** 查一次服务端旅行状态（只读）。 */
  async getStatus(): Promise<WorkBuddyTravelStatus> {
    const credential = await this.store.resolve()
    return await this.client.fetchTravelStatus(credential)
  }

  /**
   * 执行一次推进：查状态 → 按状态 depart / claim / 等待。
   *
   * `entry` 由调用方持有并先经 {@link rollTravelStateToToday} 处理。
   * 本方法会就地更新 `entry`；返回 `done: true` 表示当天不必再管该账号。
   */
  async tick(entry: TravelState): Promise<TravelTickOutcome> {
    const credential = await this.store.resolve()
    const status = await this.client.fetchTravelStatus(credential)

    // 无 Buddy：官方 depart 必然返回 "no active buddy"，提前短路，不发无用请求。
    if (status.buddyId === 0) {
      syncFromStatus(entry, status)
      entry.state = 'idle'
      entry.done = true
      entry.attemptedAtMs = Date.now()
      const message = '无 Buddy，跳过旅行'
      entry.result = message
      return { acted: false, message, done: true }
    }

    // 服务端说今天已达上限：无论是 traveling 还是已被别处领掉，都不该再派。
    if (status.dailyLimitReached) {
      return await this.finishWhenLimited(credential, entry, status)
    }

    syncFromStatus(entry, status)

    switch (status.state) {
      case 'traveling': {
        const left = secondsUntilArrival(status)
        if (left > 0) {
          // 未到点：记下状态等下一轮，不碰上游任何写接口。
          entry.attemptedAtMs = Date.now()
          const message = `旅行中：${status.locationName || '路上'}（${minutesLeftText(left)}）`
          entry.result = message
          return { acted: false, message, done: false }
        }
        // 已到点：服务端偶尔仍报 traveling，自行推进到领取。
        entry.state = 'arrived'
        return await this.claim(credential, entry, status)
      }

      case 'arrived':
        return await this.claim(credential, entry, status)

      case 'idle':
      default: {
        // 已派出过又回到 idle，且未达上限：可能是网页端领掉后重置，视为完成今日。
        if (entry.departed || entry.done) {
          entry.done = true
          entry.attemptedAtMs = Date.now()
          const message = '今日已完成'
          entry.result = message
          return { acted: false, message, done: true }
        }
        return await this.depart(credential, entry)
      }
    }
  }

  /**
   * 已派过（daily_limit_reached）时的收尾。
   *
   * 若状态是 traveling 且已到点，说明还欠一次 claim——这是**唯一**需要在
   * 「已到上限」后依然调用上游的情形；其余一律按今日完成处理。
   */
  private async finishWhenLimited(
    credential: WorkBuddyCredential,
    entry: TravelState,
    status: WorkBuddyTravelStatus,
  ): Promise<TravelTickOutcome> {
    syncFromStatus(entry, status)
    entry.departed = true

    const claimable = status.state !== 'idle' && status.recordId > 0 && secondsUntilArrival(status) <= 0
    if (claimable) return await this.claim(credential, entry, status)

    entry.attemptedAtMs = Date.now()
    if (status.state === 'idle') {
      entry.done = true
      const message = '今日已完成'
      entry.result = message
      return { acted: false, message, done: true }
    }
    // 已派且在旅行中：今日没有待办（不会再派），但行程尚未结束，
    // 下一轮仍需回来看一眼是否需要 claim，故 done=false。
    const message = `旅行中：${status.locationName || '路上'}（今日已派）`
    entry.result = message
    return { acted: false, message, done: false }
  }

  /** 派猫出发：随机挑一个可用地点。 */
  private async depart(credential: WorkBuddyCredential, entry: TravelState): Promise<TravelTickOutcome> {
    const config = await this.client.fetchTravelConfig(credential)
    const { locations } = config
    if (!config.enabled || locations.length === 0) {
      entry.attemptedAtMs = Date.now()
      const message = '无可用旅行地点'
      entry.result = message
      return { acted: false, message, done: false }
    }

    // 随机选点，避免每次都去咖啡馆。
    const pick = locations[Math.floor(Math.random() * locations.length)] as WorkBuddyTravelLocation
    const result = await this.client.departTravel(credential, pick.id)
    entry.attemptedAtMs = Date.now()

    if (!result.ok) {
      // 服务端可能在两次请求之间已经派出（并发 / 网页端操作）：按已派出处理。
      if (result.already) {
        const status = await this.client.fetchTravelStatus(credential)
        syncFromStatus(entry, status)
        entry.departed = true
        const message = `已在旅行中：${status.locationName || pick.name}`
        entry.result = message
        return { acted: true, message, done: false }
      }
      if (result.dailyLimitReached) {
        entry.departed = true
        entry.done = true
        const message = '今日已派（达每日上限）'
        entry.result = message
        return { acted: true, message, done: true }
      }
      if (result.noBuddy) {
        entry.done = true
        const message = '无 Buddy，跳过旅行'
        entry.result = message
        return { acted: false, message, done: true }
      }
      const message = `派发失败：${result.message}`
      entry.result = message
      entry.retryAfterMs = Date.now() + RETRY_COOLDOWN_MS
      return { acted: true, message, done: false }
    }

    // 派出成功：再查一次状态拿 arrive_at / record_id。
    const status = await this.client.fetchTravelStatus(credential)
    syncFromStatus(entry, status)
    entry.departed = true
    entry.state = status.state === 'idle' ? 'traveling' : status.state
    const place = status.locationName !== '' ? status.locationName : pick.name
    entry.locationName = place
    const left = secondsUntilArrival(status)
    // 派出即达每日上限（实测），这里不下结论，等下一轮由 status 决定。
    const message = `已出发去「${place}」${left > 0 ? `（${minutesLeftText(left)}）` : ''}`
    entry.result = message
    return { acted: true, message, done: false }
  }

  /** 领奖。 */
  private async claim(
    credential: WorkBuddyCredential,
    entry: TravelState,
    status: WorkBuddyTravelStatus,
  ): Promise<TravelTickOutcome> {
    const recordId = status.recordId > 0 ? status.recordId : entry.recordId
    if (recordId <= 0) {
      entry.done = true
      entry.state = 'idle'
      const message = '无待领行程'
      entry.result = message
      return { acted: false, message, done: true }
    }

    const result = await this.client.claimTravel(credential, recordId)
    entry.attemptedAtMs = Date.now()

    if (!result.ok) {
      // 「没有可领的行程」= 已被网页端领走，或本就已领，算完成。
      if (result.nothingToClaim) {
        entry.done = true
        entry.departed = true
        entry.state = 'idle'
        const message = '奖励已领（网页端）'
        entry.result = message
        return { acted: true, message, done: true }
      }
      // 「还没到」：下一轮再试。
      if (result.notArrivedYet) {
        entry.state = 'arrived'
        entry.retryAfterMs = Date.now() + RETRY_COOLDOWN_MS
        const message = '尚未到达，稍后重试'
        entry.result = message
        return { acted: true, message, done: false }
      }
      const message = `领奖失败：${result.message}`
      entry.result = message
      entry.retryAfterMs = Date.now() + RETRY_COOLDOWN_MS
      return { acted: true, message, done: false }
    }

    entry.done = true
    entry.departed = true
    entry.state = 'idle'
    if (status.locationName !== '') entry.locationName = status.locationName
    const credit = result.rewardCredit ?? status.rewardCredit
    if (credit > 0) entry.rewardCredit = credit
    const message = `已领取「${entry.locationName ?? '旅行'}」奖励${credit > 0 ? `，+${credit} 积分` : ''}`
    entry.result = message
    return { acted: true, message, done: true }
  }
}
