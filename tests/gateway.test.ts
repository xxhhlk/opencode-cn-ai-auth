/**
 * The daily-expiry strategy must treat a zero/invalid `soon` entry as no
 * dated window at all. Magpie serialises an unset time.Time as
 * "0001-01-01T00:00:00Z"; soonOf() filters it out, so freeSeat() has to use
 * the parsed list rather than the raw array length or the seat lands in
 * tier 3 instead of tier 1.
 */

import { describe, expect, test } from "bun:test"
import { type Seat, type Strategy, strategies } from "../gateway.js"

const DAY = 86_400_000

function seat(over: Partial<Seat> = {}): Seat {
  return { key: "x", known: true, used: 0, soon: [], ...over }
}

/** Each scenario needs its own pool: the strategy keeps frozen tier-2 state per pool. */
let poolSeq = 0

function missing(): never {
  throw new Error("gateway.js is missing the daily-expiry strategy")
}

const dailyExpiry: Strategy = strategies["daily-expiry"] ?? missing()

function orderFor(specs: Array<Partial<Seat>>) {
  const seats = specs.map((s, i) => seat({ key: `s${i}`, ...s }))
  return { seats, order: dailyExpiry(poolName(), seats, {}) }
}

function poolName(): string {
  poolSeq += 1
  return `test-pool-${poolSeq}`
}

const far = () => new Date(Date.now() + 10 * DAY).toISOString()
const near = () => new Date(Date.now() + 2 * 3_600_000).toISOString()
/** A weekly window that renews in six days and some hours: inside the week, past a day. */
const thisWeek = () => new Date(Date.now() + 6.9 * DAY).toISOString()

describe("daily-expiry / freeSeat", () => {
  test("a zero-time soon entry is not a dated window", () => {
    const { order } = orderFor([
      { soon: ["0001-01-01T00:00:00Z"], key: "zero" },
      { soon: [far()], key: "dated" },
    ])
    // zero-time seat is a free seat (tier 1) and must beat the dated tier 2 seat
    expect(order[0]).toBe(0)
  })

  test("a plain undated seat stays a free seat", () => {
    const { order } = orderFor([{ key: "free" }, { soon: [far()], key: "dated" }])
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(1)
  })

  test("a real dated window is still tier 2, not a free seat", () => {
    const { order } = orderFor([{ soon: [far()], key: "dated" }, { key: "free" }])
    expect(order[0]).toBe(1)
  })

  test("a daily reset within the horizon stays tier 0", () => {
    const { order } = orderFor([{ soon: [near()], key: "daily" }, { key: "free" }])
    expect(order[0]).toBe(0)
  })

  test("a spent zero-time seat is not a free seat", () => {
    const { order } = orderFor([{ soon: ["0001-01-01T00:00:00Z"], used: 100, key: "spent" }, { key: "free" }])
    expect(order[0]).toBe(1)
  })
})

describe("daily-expiry / weekly windows", () => {
  test("a weekly renewal inside the week is tier 0 even past a day", () => {
    // A subscription whose 5-hour window has not opened yet carries only the
    // weekly renewal; it must lead the order, not queue behind lapsed points.
    const { order } = orderFor([
      { soon: [thisWeek()], key: "week" },
      { soon: [far()], key: "points" },
    ])
    expect(order[0]).toBe(0)
  })

  test("the daily renewal still goes before the weekly one", () => {
    const { order } = orderFor([
      { soon: [thisWeek()], key: "week" },
      { soon: [near()], key: "daily" },
    ])
    expect(order).toStrictEqual([1, 0])
  })

  test("a lapse beyond the week stays tier 2, behind every weekly seat", () => {
    const { order } = orderFor([
      { soon: [far()], key: "points" },
      { soon: [thisWeek()], key: "week" },
    ])
    expect(order).toStrictEqual([1, 0])
  })
})
