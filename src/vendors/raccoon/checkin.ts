/**
 * The daily check-in.
 *
 * Raccoon has no check-in endpoint. The day's points are handed out when the
 * desktop client opens its workspace, and the one call that does that is the
 * workspace read (`office/v3/setting_info`) carrying the client's own
 * headers. So the check-in is that read, with the income bills read either
 * side of it: its answer says nothing about a grant, and the bills are where
 * a grant shows up.
 *
 * The one-time desktop sign-in reward is left alone: it is settled once per
 * account, and this hook has nowhere to keep that flag, so asking for it on
 * every check-in would be a request the account does not need.
 */

import { SignInExpiredError } from "../../core/errors.ts"
import type { Fetcher } from "../../core/http.ts"
import type { CheckinResult } from "../../core/types.ts"
import { fetchBills, openWorkspace, type RaccoonBill } from "./api.ts"
import { RACCOON_ID } from "./product.ts"

const BEIJING_OFFSET_MS = 8 * 3600_000

/** The vendor's day is Beijing's: the grant belongs to the day it lands in. */
function beijingDay(now = Date.now()): string {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/** A bill this check-in could have caused: today's, and a grant, not a spend. */
function isGrant(bill: RaccoonBill, day: string): boolean {
  const points = Math.floor(bill.points ?? 0)
  if (points <= 0) return false
  if ((bill.created_at ?? "").slice(0, 10) !== day) return false
  const biz = bill.biz_type ?? ""
  return biz === "" || biz === "daily_grant" || biz === "reward_grant"
}

/** What tells two bills apart when the day's grants are counted again. */
function billKey(bill: RaccoonBill): string {
  return `${bill.created_at ?? ""}:${bill.points ?? 0}:${bill.biz_type ?? ""}`
}

function grantsToday(bills: readonly RaccoonBill[], day: string): RaccoonBill[] {
  return bills.filter((bill) => isGrant(bill, day))
}

export async function performCheckin(
  fetcher: Fetcher,
  access: string,
  orgCode: string | undefined,
): Promise<CheckinResult> {
  const day = beijingDay()

  // The bills before the read, so a grant that was already there today is not
  // reported as this press's. A read that fails leaves the check-in able to
  // run; it then says the day is done, which is all it can prove.
  const before = await fetchBills(fetcher, access, orgCode)
  if (!before.ok && before.signedOut) {
    throw new SignInExpiredError(RACCOON_ID, `签到被拒绝：${before.message}`)
  }
  const seen = new Set(before.ok ? grantsToday(before.data, day).map(billKey) : [])

  const opened = await openWorkspace(fetcher, access, orgCode)
  if (!opened.ok) {
    if (opened.signedOut) throw new SignInExpiredError(RACCOON_ID, `签到被拒绝：${opened.message}`)
    return { outcome: "failed", message: opened.message }
  }
  if (!before.ok) return { outcome: "done", message: "已签到（账单读取失败，未能核对积分）" }

  const after = await fetchBills(fetcher, access, orgCode)
  if (!after.ok) return { outcome: "done", message: "已签到（积分账单读取失败）" }

  let credit = 0
  const names: string[] = []
  for (const bill of grantsToday(after.data, day)) {
    if (seen.has(billKey(bill))) continue
    credit += Math.floor(bill.points ?? 0)
    const name = bill.event_name ?? "今日积分"
    if (!names.includes(name)) names.push(name)
  }
  if (credit <= 0) return { outcome: "done", message: "今日已签到" }
  return { outcome: "claimed", credit, message: `${names.join(" + ")} +${credit}` }
}
