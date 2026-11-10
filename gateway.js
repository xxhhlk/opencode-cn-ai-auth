/**
 * Routing for points-funded channels.
 *
 * Three tiers, in this order:
 *
 * 1. Channels that still have today's allowance. A daily pool resets every
 *    day, so what is left of it is lost at the reset — spend it first, the
 *    soonest reset before the later ones.
 * 2. Channels whose daily pool is gone but which still hold dated points.
 *    These go by when their points lapse, soonest first.
 * 3. Everything else: no daily pool and nothing dated (a permanent balance),
 *    or a refusal resting it. Listed order.
 *
 * `soon` is a seat's windows ordered by span, longest first, so the head is
 * the long-lived grant and a daily window sits behind it. A window that
 * renews within `dailyHorizonDays` is that daily window; anything beyond it
 * is a grant that lapses.
 *
 * Nothing here sends a request: it only orders seats, and magpie tries every
 * seat whatever the order says.
 */

const DAY = 86_400_000

/** The default horizon that separates a daily window from a dated grant. */
const DAILY_HORIZON_DAYS = 2

/** The soonest daily window that has not reset yet, or 0 when none. */
function dailyResetOf(seat, now, horizon) {
  const soon = Array.isArray(seat.soon) ? seat.soon : []
  let at = 0
  for (const t of soon) {
    const n = Number(t)
    if (n > now && n - now <= horizon && (at === 0 || n < at)) at = n
  }
  return at
}

/** The soonest grant that lapses beyond the daily horizon, or Infinity. */
function expiryOf(seat, now, horizon) {
  const soon = Array.isArray(seat.soon) ? seat.soon : []
  let at = Infinity
  for (const t of soon) {
    const n = Number(t)
    if (n > now + horizon && n < at) at = n
  }
  return at
}

function spentOf(seat) {
  return seat.resting === true || (seat.known === true && Number(seat.used) >= 100)
}

export const strategies = {
  "daily-expiry": (pool, seats, options) => {
    const now = Date.now()
    const days = Number(options && options.dailyHorizonDays)
    const horizon = (Number.isFinite(days) && days > 0 ? days : DAILY_HORIZON_DAYS) * DAY

    // A model the vendor serves at no cost has no window of its own: the
    // account's own reads leave it out, so it never fills and never dates.
    // It still answers, and it costs nothing, so it goes right after today's
    // allowance and before anything that spends points.
    const freeSeat = (seat) =>
      seat.known === true && Number(seat.used) === 0 && (!Array.isArray(seat.soon) || seat.soon.length === 0)

    const marks = seats.map((seat) => {
      const daily = dailyResetOf(seat, now, horizon)
      const expiry = expiryOf(seat, now, horizon)
      const tier = daily > 0 && !spentOf(seat) ? 0 : freeSeat(seat) ? 1 : expiry < Infinity ? 2 : 3
      return { daily, expiry, tier }
    })

    const order = seats.map((_, i) => i)
    order.sort((a, b) => {
      const left = marks[a]
      const right = marks[b]
      if (left.tier !== right.tier) return left.tier - right.tier
      if (left.tier === 0 && left.daily !== right.daily) return left.daily - right.daily
      if (left.tier === 2) {
        if (left.expiry === right.expiry) return 0
        return left.expiry - right.expiry
      }
      return 0
    })
    return order
  },
}
