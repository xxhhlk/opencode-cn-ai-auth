/**
 * Routing for points-funded channels.
 *
 * Four tiers, in this order:
 *
 * 0. Channels with an allowance that renews within the week, soonest reset
 *    first. A subscription's windows renew while its allowance is still
 *    unspent, so its shortest window leads the tier when it exists — and a
 *    seat whose short window has not opened yet (a fresh week, or a
 *    subscription whose 5-hour window only starts with the first request)
 *    still carries a dated renewal inside the week, so it stays here rather
 *    than falling back to tier 2 among points that simply lapse.
 * 1. A model served at no cost: no window of its own, so it never fills and
 *    never dates. It goes after today's allowance and before points are spent.
 * 2. Channels holding dated points, soonest lapse first. A grant that lapses
 *    within the week is therefore at the front of this tier, not excluded
 *    from it (the old two-day horizon did exactly that).
 * 3. Everything else: permanent balance, or a refusal resting it. Listed order.
 *
 * Tier 2 is the only tier that holds a frozen order. Its lapse dates move by
 * whole grants as points are spent, so two channels a day apart used to swap
 * places after every few requests. A frozen tier-2 order is reused until the
 * anchor channel has spent five days' worth of grants (its earliest lapse
 * moved five days), or a grant close to expiring needs rescuing. Tiers 0, 1
 * and 3 are recomputed every call, so daily allowances and free models still
 * take effect immediately.
 *
 * The module's runtime is kept by the host, so the frozen orders survive
 * across calls; they are deliberately in memory only and fail open to the
 * freshly computed order whenever they are missing or no longer fit.
 *
 * Nothing here sends a request: it only orders seats, and magpie tries every
 * seat whatever the order says.
 */

const DAY = 86_400_000

/** Defaults, all overridable with options on the group. */
// A week, not a day: a subscription renews on 5-hour and weekly windows, and
// the weekly one is the only date a seat has when its short window has not
// opened yet. With a one-day horizon those seats looked dateless-and-distant
// and were sorted among lapsed points instead of leading the order.
const DEFAULT_DAILY_HORIZON_DAYS = 7
const DEFAULT_SWITCH_DAYS = 5
const DEFAULT_RESCUE_DAYS = 2
const DEFAULT_RESCUE_LEAD_DAYS = 5

/** pool -> { keys, anchor, anchorExpiry }, for the tier-2 segment only. */
const frozen = new Map()

function optionDays(options, name, fallback) {
  const n = Number(options && options[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** `soon` is unix ms; accept a date string too, so a differently shaped
 * reading never silently turns every window into NaN. */
function timeOf(t) {
  const n = typeof t === "number" ? t : Date.parse(t)
  return Number.isFinite(n) ? n : 0
}

function soonOf(seat) {
  return Array.isArray(seat.soon) ? seat.soon.map(timeOf).filter((n) => n > 0) : []
}

/** The soonest daily window that has not reset yet, or 0 when none. */
function dailyResetOf(seat, now, horizon) {
  let at = 0
  for (const n of soonOf(seat)) {
    if (n > now && n - now <= horizon && (at === 0 || n < at)) at = n
  }
  return at
}

/** The soonest grant that lapses beyond the daily horizon, or Infinity. */
function expiryOf(seat, now, horizon) {
  let at = Infinity
  for (const n of soonOf(seat)) {
    if (n > now + horizon && n < at) at = n
  }
  return at
}

function spentOf(seat) {
  return seat.resting === true || (seat.known === true && Number(seat.used) >= 100)
}

/** Use the parsed list: a zero or invalid time is not a dated window. */
function freeSeat(seat) {
  return seat.known === true && Number(seat.used) === 0 && soonOf(seat).length === 0
}

function keyOf(seat, i) {
  const key = seat.key
  return typeof key === "string" && key.length > 0 ? key : `#${i}`
}

function marksOf(seats, now, horizon) {
  return seats.map((seat) => {
    const daily = dailyResetOf(seat, now, horizon)
    const expiry = expiryOf(seat, now, horizon)
    const tier = daily > 0 && !spentOf(seat) ? 0 : freeSeat(seat) ? 1 : expiry < Infinity ? 2 : 3
    return { daily, expiry, tier }
  })
}

/** The plain order, computed fresh on every call. */
function baseOrderOf(seats, marks) {
  const order = seats.map((_, i) => i)
  order.sort((a, b) => {
    const left = marks[a]
    const right = marks[b]
    if (left.tier !== right.tier) return left.tier - right.tier
    if (left.tier === 0 && left.daily !== right.daily) return left.daily - right.daily
    if (left.tier === 2 && left.expiry !== right.expiry) return left.expiry - right.expiry
    return 0
  })
  return order
}

/** tier 2 is contiguous after a tier sort: [start, end). */
function tier2Segment(order, marks) {
  const start = order.findIndex((i) => marks[i].tier === 2)
  if (start < 0) return null
  let end = start
  while (end < order.length && marks[order[end]].tier === 2) end++
  return { start, end }
}

/** The frozen order mapped onto today's seats, or null when the seats moved. */
function mappedFrozen(seats, marks, state, segment, order) {
  const current = order.slice(segment.start, segment.end).map((i) => keyOf(seats[i], i))
  if (current.length !== state.keys.length) return null
  const nowSet = new Set(current)
  if (state.keys.some((k) => !nowSet.has(k))) return null

  const indexByKey = new Map()
  for (let p = segment.start; p < segment.end; p++) {
    indexByKey.set(keyOf(seats[order[p]], order[p]), order[p])
  }
  const mapped = []
  for (const k of state.keys) {
    const i = indexByKey.get(k)
    if (i === undefined || marks[i].tier !== 2) return null
    mapped.push(i)
  }
  return mapped
}

function remember(pool, seats, marks, segment, order) {
  const keys = order.slice(segment.start, segment.end).map((i) => keyOf(seats[i], i))
  if (keys.length === 0) {
    frozen.delete(pool)
    return
  }
  const head = order[segment.start]
  frozen.set(pool, { keys, anchor: keys[0], anchorExpiry: marks[head].expiry })
  // A pool id per group is a handful, but never let a long-lived process
  // accumulate one entry per rotating pool name forever.
  if (frozen.size > 32) frozen.clear()
}

/** Whether the frozen tier-2 order may be recomputed now. */
function shouldUnfreeze(seats, marks, state, segment, order, cfg, now) {
  let anchorExpiry = Infinity
  for (let p = segment.start; p < segment.end; p++) {
    const i = order[p]
    if (keyOf(seats[i], i) === state.anchor) {
      anchorExpiry = marks[i].expiry
      break
    }
  }
  // The anchor's grant is gone, or it has spent the agreed number of days'
  // worth of grants: either way the ordering is allowed to move on.
  if (!Number.isFinite(anchorExpiry)) return true
  if (anchorExpiry - state.anchorExpiry >= cfg.switchDays * DAY) return true

  // A grant close to expiring that the frozen order would leave behind. The
  // lead condition keeps a run of grants one day apart from unfreezing daily.
  for (let p = segment.start; p < segment.end; p++) {
    const mark = marks[order[p]]
    if (
      mark.expiry <= now + cfg.rescueDays * DAY &&
      state.anchorExpiry - mark.expiry >= cfg.rescueLeadDays * DAY
    ) {
      return true
    }
  }
  return false
}

function validOrder(order, seats) {
  if (!Array.isArray(order) || order.length !== seats.length) return false
  const seen = new Set(order)
  return seen.size === seats.length && order.every((i) => Number.isInteger(i) && i >= 0 && i < seats.length)
}

/** Applies the frozen tier-2 segment to a fresh order, fail open throughout. */
function withFrozen(pool, seats, marks, order, cfg, now) {
  const segment = tier2Segment(order, marks)
  if (segment === null) {
    frozen.delete(pool)
    return order
  }
  try {
    const state = frozen.get(pool)
    if (!state || !Array.isArray(state.keys) || !Number.isFinite(state.anchorExpiry)) {
      remember(pool, seats, marks, segment, order)
      return order
    }
    const mapped = mappedFrozen(seats, marks, state, segment, order)
    if (mapped === null || shouldUnfreeze(seats, marks, state, segment, order, cfg, now)) {
      remember(pool, seats, marks, segment, order)
      return order
    }
    const next = order.slice()
    next.splice(segment.start, segment.end - segment.start, ...mapped)
    return next
  } catch {
    frozen.delete(pool)
    return order
  }
}

export const strategies = {
  "daily-expiry": (pool, seats, options) => {
    const now = Date.now()
    const cfg = {
      horizon: optionDays(options, "dailyHorizonDays", DEFAULT_DAILY_HORIZON_DAYS) * DAY,
      switchDays: optionDays(options, "switchDays", DEFAULT_SWITCH_DAYS),
      rescueDays: optionDays(options, "rescueDays", DEFAULT_RESCUE_DAYS),
      rescueLeadDays: optionDays(options, "rescueLeadDays", DEFAULT_RESCUE_LEAD_DAYS),
    }
    const listed = seats.map((_, i) => i)
    try {
      const marks = marksOf(seats, now, cfg.horizon)
      const base = baseOrderOf(seats, marks)
      const order = withFrozen(String(pool ?? ""), seats, marks, base, cfg, now)
      return validOrder(order, seats) ? order : listed
    } catch {
      return listed
    }
  },
}
