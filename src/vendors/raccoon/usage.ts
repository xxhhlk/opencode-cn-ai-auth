/**
 * Raccoon's points, as the host's usage card and its routing read them.
 *
 * The balance endpoint answers four pools plus a total (`available_points`,
 * `reward_points`, `daily_points`, `monthly_points`, `topup_points`). The
 * service states how much is left in each pool and never how much it started
 * with, so the daily pool's share is worked out against a ceiling the caller
 * knows: the `daily_grant` bill of today, or the `dailyQuota` option.
 *
 * The host only stops an account on a window it can date, so the two windows
 * that stop it carry a reset: the daily pool at the next Beijing midnight,
 * the reward pool at the soonest lapse the income bills report. With no bill
 * to date the reward window is still shown, and simply never stops the
 * account — which is what it was before. The reward pool reports `used: 0` on
 * purpose: its balance must order accounts, never stop them.
 *
 * `docs/vendors.md` records what the fields are read from and which of them
 * are still assumptions.
 */

import type { UsageReport, UsageWindow } from "../../core/types.ts"
import type { RaccoonBalance, RaccoonBill, RaccoonEntitlement } from "./api.ts"

const OFFSET_MS = 8 * 3600 * 1000

/** A reward grant's life under the vendor's own rule: one year. */
const ONE_YEAR_MS = 365 * 86_400_000

/** The next Beijing midnight (00:00 +08:00), as epoch milliseconds. */
export function beijingMidnight(now: number): number {
  const bj = new Date(now + OFFSET_MS)
  const midnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1)
  return midnight - OFFSET_MS
}

/** The Beijing day a moment falls in, as a day number. */
function beijingDay(t: number): number {
  return Math.floor((t + OFFSET_MS) / 86_400_000)
}

/**
 * Today's daily grant, in points — the daily pool's ceiling, which the
 * balance endpoint itself never states.
 */
export function dailyQuotaOf(bills: RaccoonBill[] | undefined, now: number): number | undefined {
  const today = beijingDay(now)
  for (const item of bills ?? []) {
    if (item.biz_type !== "daily_grant") continue
    const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : 0
    if (!(created > 0) || beijingDay(created) !== today) continue
    const points = Math.floor(Number(item.points) || 0)
    if (points > 0) return points
  }
  return undefined
}

/**
 * The soonest grant that still holds points and states a lapse: when the
 * earliest of what the account keeps is lost, and how much is lost then.
 *
 * Daily grants are left out: the service hands them out with a one-off lapse
 * of their own, and the soonest of those would date the long-lived pool by
 * tomorrow. What is left is the pool that actually lapses in months or a year.
 *
 * A reward grant states no `expire_at` at all, so the vendor's own rule dates
 * it: one year from the day it was handed out. Only when neither the bill nor
 * its creation date is readable is the grant left undated — and an undated
 * pool simply never orders accounts.
 */
export function soonestGrant(
  bills: RaccoonBill[] | undefined,
  now: number,
): { at: number; points: number } | undefined {
  let at = 0
  let points = 0
  for (const item of bills ?? []) {
    if (item.biz_type === "daily_grant") continue
    const held = Math.floor(Number(item.points) || 0)
    if (held <= 0) continue
    const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : 0
    const stated = typeof item.expire_at === "string" ? Date.parse(item.expire_at) : 0
    const expire = stated > 0 ? stated : created > 0 ? created + ONE_YEAR_MS : 0
    if (!(expire > now)) continue
    if (!at || expire < at) {
      at = expire
      points = held
    } else if (expire === at) {
      points += held
    }
  }
  return at ? { at, points } : undefined
}

export interface RaccoonUsageOptions {
  user?: string
  /** Income bills: the only place a lapse date and today's grant come from. */
  bills?: RaccoonBill[]
  /** A ceiling for the daily pool when no bill states one today. */
  dailyQuota?: number
  /** The account's plan and when a paid one ends; unreadable on free accounts. */
  entitlement?: RaccoonEntitlement
  now?: number
}

/** The pools the service answered, with the two the host can route by dated. */
export function balanceWindows(balance: RaccoonBalance, options: RaccoonUsageOptions = {}): UsageWindow[] {
  const now = options.now ?? Date.now()
  const windows: UsageWindow[] = []

  const daily = balance.daily
  if (daily !== undefined) {
    const quota = dailyQuotaOf(options.bills, now) ?? options.dailyQuota
    const dated = quota !== undefined && quota > 0
    // A ceiling lets the share be a real percentage; without one the pool can
    // still say whether it is empty, which is all the routing needs.
    const used = dated ? Math.min(100, Math.max(0, (100 * (quota - daily)) / quota)) : daily > 0 ? 0 : 100
    windows.push({
      name: "每日积分",
      used,
      resetsAt: beijingMidnight(now),
      span: 86_400,
      ...(dated ? { amount: Math.max(0, quota - daily), limit: quota } : {}),
      unit: "积分",
      display: dated ? `每日 ${daily} / ${quota}` : `每日剩余 ${daily}`,
    })
  }

  // The reward pool is the long-lived one: registration grants, a year.
  // Its lapse date describes this pool alone. Once it is empty, keeping the
  // date would tell the routing strategy the account still has dated points
  // to spend before the permanent pools, when only top-ups or the daily
  // grant are left. The dated grants in the bills are history, not balance.
  const reward = balance.reward
  if (reward !== undefined) {
    const grant = reward > 0 ? soonestGrant(options.bills, now) : undefined
    windows.push({
      name: "奖励积分",
      used: 0,
      ...(grant === undefined
        ? {}
        : {
            resetsAt: grant.at,
            runsOutAt: grant.at,
            runsOut: Math.min(reward, grant.points),
            span: Math.max(3600, Math.floor((grant.at - now) / 1000)),
          }),
      unit: "积分",
      display: `奖励积分 ${reward}`,
    })
  }

  // Top-ups never lapse, so this one is only shown.
  if (balance.topup !== undefined) {
    windows.push({
      name: "充值积分",
      used: 0,
      aside: true,
      unit: "积分",
      display: `充值积分 ${balance.topup}`,
    })
  }

  return windows
}

export function usageReport(balance: RaccoonBalance, options: RaccoonUsageOptions = {}): UsageReport {
  const plan = options.entitlement?.plan
  const until = options.entitlement?.until
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(balance.available === undefined ? {} : { balance: `${balance.available} 积分` }),
    windows: balanceWindows(balance, options),
  }
}
