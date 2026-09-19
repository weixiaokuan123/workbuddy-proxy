/**
 * WorkBuddy 每日签到适配层。
 *
 * 直接复用 WorkBuddyUpstreamClient 已实现的两个端点（改自上游插件，MIT）：
 *   POST {billing}/v2/billing/meter/checkin-activity-status  今日状态
 *   POST {billing}/v2/billing/meter/daily-checkin            领取（幂等）
 * 本模块只负责把它们包成签到调度器需要的 ClaimOutcome。
 *
 * 只读 access token；token 刷新走 client.refreshToken（内存，不落地）。
 *
 * @module workbuddy-proxy/signin
 */

import type { LiveCredentialStore } from './auth.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

export interface WorkBuddySigninView {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  totalCredits?: number
  claimButtonText?: string
  raw?: unknown
}

export class WorkBuddySigninService {
  private readonly store: LiveCredentialStore
  private readonly client: WorkBuddyUpstreamClient

  constructor(store: LiveCredentialStore, client: WorkBuddyUpstreamClient) {
    this.store = store
    this.client = client
  }

  async getStatus(): Promise<WorkBuddySigninView> {
    const credential = await this.store.resolve()
    const s = await this.client.fetchCheckinStatus(credential)
    return {
      active: s.active,
      todayCheckedIn: s.todayCheckedIn,
      streakDays: s.streakDays,
      dailyCredit: s.dailyCredit,
      todayCredit: s.todayCredit,
      ...(s.claimButtonText ? { claimButtonText: s.claimButtonText } : {}),
      raw: s,
    }
  }

  /** 签到；已签则零写入。返回调度器需要的三态结果。 */
  async claim(): Promise<{ claimed: boolean; already: boolean; message: string }> {
    const view = await this.getStatus()
    if (view.todayCheckedIn) {
      return { claimed: false, already: true, message: `今天已签到（连签 ${view.streakDays} 天）` }
    }
    if (!view.active) {
      return { claimed: false, already: false, message: '签到活动未开启' }
    }
    const credential = await this.store.resolve()
    const result = await this.client.claimDailyCheckin(credential)
    return {
      claimed: true,
      already: false,
      message: `签到成功，+${result.credit} 积分（连签 ${result.streakDays} 天）`,
    }
  }
}
