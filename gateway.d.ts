/**
 * Types for gateway.js, the host-loaded routing module.
 *
 * The module is plain JavaScript because magpie imports it directly; this
 * declaration exists so the tests can import it under `tsc --noEmit`.
 */

/** One routable account or key, as gateway.js reads it. */
export interface Seat {
  key?: string
  account?: boolean
  known?: boolean
  learns?: boolean
  used?: number
  soon?: Array<number | string>
  pace?: number
  weight?: number
  resting?: boolean
  tokens?: number
}

export type StrategyOptions = Record<string, unknown>

export type Strategy = (pool: string, seats: Seat[], options?: StrategyOptions) => number[]

export declare const strategies: Record<string, Strategy>
