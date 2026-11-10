/**
 * Routing for points-funded channels.
 *
 * Two rules, in this order:
 *
 * 1. A channel whose daily allowance is used up goes last. Magpie knows a
 *    window is spent when its `used` reaches the routing's share, and `used`
 *    is the fullest window of the account, so this catches either a daily
 *    pool or a long-lived one that ran dry. `resting` covers what a vendor
 *    refused.
 * 2. The rest go by when their points lapse, soonest first. `soon` is a
 *    seat's windows ordered by span, longest first, so its head is the
 *    long-lived grant while a daily window sits behind it. A head that
 *    renews within `dailyHorizonDays` is that daily window — the channel has
 *    no dated grant, and it goes last, with the ones that never lapse.
 *
 * Nothing here sends a request: it only orders seats, and magpie tries every
 * seat whatever the order says.
 */

const DAY = 86_400_000

/** The default horizon that separates a daily window from a dated grant. */
const DAILY_HORIZON_DAYS = 2

function expiryOf(seat, now, horizon) {
  const soon = Array.isArray(seat.soon) ? seat.soon : []
  const head = soon.length > 0 ? Number(soon[0]) : 0
  // A zero time marshals as a large negative number: no window to date.
  return head > 0 && head - now > horizon ? head : Infinity
}

function spentOf(seat) {
  return seat.resting === true || (seat.known === true && Number(seat.used) >= 100)
}

export const strategies = {
  "daily-expiry": (pool, seats, options) => {
    const now = Date.now()
    const days = Number(options && options.dailyHorizonDays)
    const horizon = (Number.isFinite(days) && days > 0 ? days : DAILY_HORIZON_DAYS) * DAY

    const order = seats.map((_, i) => i)
    order.sort((a, b) => {
      const left = spentOf(seats[a]) ? 1 : 0
      const right = spentOf(seats[b]) ? 1 : 0
      if (left !== right) return left - right

      const ea = expiryOf(seats[a], now, horizon)
      const eb = expiryOf(seats[b], now, horizon)
      if (ea === eb) return 0
      if (ea === Infinity) return 1
      if (eb === Infinity) return -1
      return ea - eb
    })
    return order
  },
}
