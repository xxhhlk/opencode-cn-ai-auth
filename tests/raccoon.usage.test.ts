/**
 * 保护 vendors/raccoon/usage.ts：服务只报每个池子还剩多少、从不报额度，
 * 所以每日池的占比要拿调用方知道的天花板（今天的 daily_grant 账单，或
 * dailyQuota 选项）算；两条能被路由读的窗口都带 reset —— 每日池在下一个
 * 北京时间 0 点，奖励池在账单里最早的那次到期。充值池只展示，月度池服务
 * 从来不发，不造窗口。
 */

import { describe, expect, test } from "bun:test"
import { balanceWindows, beijingMidnight, usageReport } from "../src/vendors/raccoon/usage.ts"
import { at } from "./helpers.ts"

const NOW = Date.parse("2026-11-13T16:30:00Z") // 2026-11-14 00:30 北京
const BALANCE = { available: 1234, daily: 100, monthly: 200, reward: 30, topup: 900 }
const TODAY_GRANT = { biz_type: "daily_grant", points: 400, created_at: "2026-11-13T17:00:00Z" }

describe("balanceWindows", () => {
  test("每日池按今天的天花板算占比，并在下一个北京 0 点重置", () => {
    expect(balanceWindows({ daily: 100 }, { bills: [TODAY_GRANT], now: NOW })).toStrictEqual([
      {
        name: "每日积分",
        used: 75,
        resetsAt: beijingMidnight(NOW),
        span: 86_400,
        amount: 300,
        limit: 400,
        unit: "积分",
        display: "每日 100 / 400",
      },
    ])
  })

  test("没有账单也没有 dailyQuota 时不编占比，只说还剩多少", () => {
    expect(balanceWindows({ daily: 100 }, { now: NOW })).toStrictEqual([
      {
        name: "每日积分",
        used: 0,
        resetsAt: beijingMidnight(NOW),
        span: 86_400,
        unit: "积分",
        display: "每日剩余 100",
      },
    ])
    // 空池照样能停号：没有天花板也看得出今天是 0。
    expect(at(balanceWindows({ daily: 0 }, { now: NOW }), 0).used).toBe(100)
  })

  test("dailyQuota 是没有当日账单时的天花板", () => {
    expect(balanceWindows({ daily: 100 }, { dailyQuota: 400, now: NOW })).toStrictEqual([
      {
        name: "每日积分",
        used: 75,
        resetsAt: beijingMidnight(NOW),
        span: 86_400,
        amount: 300,
        limit: 400,
        unit: "积分",
        display: "每日 100 / 400",
      },
    ])
  })

  test("奖励池按最早的一次到期排序，used 恒为 0（只排序，不停号）", () => {
    const bills = [
      TODAY_GRANT,
      { biz_type: "reward_grant", points: 50, expire_at: "2027-01-01T00:00:00Z" },
      { biz_type: "reward_grant", points: 20, expire_at: "2026-12-01T00:00:00Z" },
    ]
    const soonest = Date.parse("2026-12-01T00:00:00Z")
    expect(balanceWindows({ reward: 30 }, { bills, now: NOW })).toStrictEqual([
      {
        name: "奖励积分",
        used: 0,
        resetsAt: soonest,
        runsOutAt: soonest,
        runsOut: 20,
        span: Math.floor((soonest - NOW) / 1000),
        unit: "积分",
        display: "奖励积分 30",
      },
    ])
  })

  test("奖励池空了就不带日期：历史上领过的到期日不是余额", () => {
    const bills = [{ biz_type: "reward_grant", points: 50, expire_at: "2027-01-01T00:00:00Z" }]
    expect(balanceWindows({ reward: 0 }, { bills, now: NOW })).toStrictEqual([
      { name: "奖励积分", used: 0, unit: "积分", display: "奖励积分 0" },
    ])
  })

  test("充值池永远只展示，且服务没报的池子不造窗口", () => {
    expect(balanceWindows(BALANCE, { now: NOW })).toStrictEqual([
      {
        name: "每日积分",
        used: 0,
        resetsAt: beijingMidnight(NOW),
        span: 86_400,
        unit: "积分",
        display: "每日剩余 100",
      },
      { name: "奖励积分", used: 0, unit: "积分", display: "奖励积分 30" },
      { name: "充值积分", used: 0, aside: true, unit: "积分", display: "充值积分 900" },
    ])
    expect(balanceWindows({ available: 7 })).toStrictEqual([])
    expect(balanceWindows({})).toStrictEqual([])
  })
})

describe("usageReport", () => {
  test("available 给 balance，user 只在给定时出现", () => {
    expect(usageReport(BALANCE, { user: "138****5678", now: NOW })).toStrictEqual({
      user: "138****5678",
      balance: "1234 积分",
      windows: [
        {
          name: "每日积分",
          used: 0,
          resetsAt: beijingMidnight(NOW),
          span: 86_400,
          unit: "积分",
          display: "每日剩余 100",
        },
        { name: "奖励积分", used: 0, unit: "积分", display: "奖励积分 30" },
        { name: "充值积分", used: 0, aside: true, unit: "积分", display: "充值积分 900" },
      ],
    })
    const bare = usageReport(BALANCE, { now: NOW })
    expect(bare.balance).toBe("1234 积分")
    expect("user" in bare).toBe(false)
  })

  test("没有 available 时不编总账", () => {
    const report = usageReport({ daily: 100 }, { now: NOW })
    expect("balance" in report).toBe(false)
    expect(report.windows).toHaveLength(1)
    expect(at(report.windows ?? [], 0).name).toBe("每日积分")
  })
})
