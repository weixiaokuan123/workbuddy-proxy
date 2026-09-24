/**
 * 积分查询的短 TTL 缓存。
 *
 * 背景：`/status` 每次都要拉上游积分接口（一次网络往返，约 300ms）。
 * 而 opencode 面板与 agent-hub 会周期性轮询 `/status`，若不加缓存，
 * 每次轮询都直打上游，既拖慢面板，也在上游限流时把 `/status` 一起拖下水。
 *
 * 设计要点：
 *  - 按账号身份（domain + uid）分区，不同账号不共享；
 *  - TTL 内直接命中；过期后**只允许一个** in-flight 请求（single-flight），
 *    并发轮询不会放大成 N 次上游调用；
 *  - 上游失败时**回退到上一次成功的值**（若有），并标记 stale，避免
 *    `/status` 因为上游抖动而整块报错。
 *
 * @module workbuddy-proxy/credit-cache
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyCredits } from './upstream.ts'

/** 缓存存活时长：积分变化不频繁，60s 足够，且大幅降低轮询压力。 */
export const CREDIT_CACHE_TTL_MS = 60_000

/** 上游失败时，最多容忍多久之前的旧值继续展示。 */
const STALE_GRACE_MS = 15 * 60_000

export interface CachedCredits {
  credits: WorkBuddyCredits
  /** 数据是否来自缓存（未重新拉取）。 */
  cached: boolean
  /** 是否为上游失败后的降级旧值。 */
  stale: boolean
  /** 距上次成功拉取的毫秒数。 */
  ageMs: number
}

interface Entry {
  credits: WorkBuddyCredits
  fetchedAtMs: number
}

/** 以 domain + uid 作为账号身份键；缺 uid 时退回 domain，保证不跨账号串数据。 */
function identityOf(credential: WorkBuddyCredential): string {
  return `${credential.domain ?? ''}|${credential.uid ?? ''}`
}

export class CreditCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<WorkBuddyCredits>>()
  private readonly now: () => number
  private readonly maxConcurrent: number
  private running = 0
  /** 等待并发名额的排队者（FIFO）。 */
  private readonly waiters: Array<() => void> = []

  constructor(
    now: () => number = () => Date.now(),
    /** 同时进行的上游积分请求上限，防止池变大后瞬间打爆上游。 */
    maxConcurrent = 3,
  ) {
    this.now = now
    this.maxConcurrent = Math.max(1, maxConcurrent)
  }

  /** 取一个并发名额（无空位则排队）。 */
  private async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.running++
  }

  /** 归还并发名额，唤醒下一个排队者。 */
  private release(): void {
    this.running--
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * 取积分：TTL 内命中缓存；否则（重新）拉取。
   * 上游失败且存在未超龄的旧值时，返回旧值并标记 stale，不抛错。
   */
  async get(
    credential: WorkBuddyCredential,
    loader: (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>,
  ): Promise<CachedCredits> {
    const key = identityOf(credential)
    const nowMs = this.now()
    const hit = this.entries.get(key)
    if (hit !== undefined && nowMs - hit.fetchedAtMs < CREDIT_CACHE_TTL_MS) {
      return { credits: hit.credits, cached: true, stale: false, ageMs: nowMs - hit.fetchedAtMs }
    }

    try {
      const credits = await this.load(key, credential, loader)
      return { credits, cached: false, stale: false, ageMs: 0 }
    } catch (error: unknown) {
      // 上游抖动时用旧值兜底，超过容忍窗口才把错误抛给调用方。
      if (hit !== undefined && nowMs - hit.fetchedAtMs < STALE_GRACE_MS) {
        return { credits: hit.credits, cached: true, stale: true, ageMs: nowMs - hit.fetchedAtMs }
      }
      throw error
    }
  }

  /** single-flight：同一账号并发请求共享同一次上游调用。 */
  private load(
    key: string,
    credential: WorkBuddyCredential,
    loader: (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>,
  ): Promise<WorkBuddyCredits> {
    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing

    const task = this.acquire()
      .then(() => loader(credential))
      .then(credits => {
        this.entries.set(key, { credits, fetchedAtMs: this.now() })
        return credits
      })
      .finally(() => {
        this.release()
        this.inflight.delete(key)
      })
    this.inflight.set(key, task)
    return task
  }

  /** 仅测试/诊断用：清空缓存。 */
  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }
}
