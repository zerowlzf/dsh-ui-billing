/**
 * Cost folds for the billing surfaces.
 *
 * Two folds exist because the two surfaces have different evidence. The
 * session meter accumulates exactly: the `tokenUsage` projection is a running
 * total whose growth between two reads is precisely what one route was billed,
 * so summing those deltas prices a session that switched models mid-way
 * without needing per-route history. The turn meter starts from the durable
 * turn-tail accounting — the same number the shipped Turn-usage panel shows —
 * and prices each attempt at the rate of the route that produced it.
 *
 * Both folds charge every stretch in the price window it was observed in,
 * because a published rate is not one number per day: the peak window and the
 * off-peak window that surrounds it are priced apart, and a stretch carries the
 * moment it happened so the charge can follow the clock rather than the rates
 * alone.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/cost
 */

import type { TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { bandAt, bandFor, priceUsage, priceWindowAt, routeKey, type PriceWindow } from '../settings.ts'
import type { ModelRate } from '../settings.ts'

/**
 * Exact provider-reported token accounting for every attempt in one completed
 * Turn, as the Chat contract carries it on the tail node.
 *
 * Derived from the payload rather than imported, because the Chat package
 * exports the tail payload but not the accounting type itself: this package
 * reads the accounting the tail carries and never names a shape of its own.
 */
type TurnTokenUsage = NonNullable<TurnTailChatData['tokenUsage']>

/** Rate lookup: one route's configured rates, keyed `provider/model`. */
export type RateTable = Readonly<Record<string, ModelRate>>

/** The four disjoint buckets one session accumulated up to a point. */
export interface SessionBuckets {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** One stretch of a session billed under a single route. */
export interface SessionCostStep {
  /** `provider/model` the stretch was billed under. */
  readonly route: string
  /** Epoch milliseconds the stretch was observed at; it selects the price window. */
  readonly at: number
  /** Buckets billed during the stretch. */
  readonly buckets: SessionBuckets
}

/** Token buckets one turn was billed for. */
export interface TurnBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One charge a turn incurred: a route, the window it was billed in, and its buckets. */
export interface TurnRouteUsage {
  readonly route: string
  /**
   * Price window the row is charged in. A route publishing one price for the
   * whole day is charged at `peak`, which for that route is simply its price.
   */
  readonly window: PriceWindow
  readonly buckets: TurnBuckets
}

/** Priced turn total plus the routes that were priced. */
export interface TurnCost {
  /** Cost of every priced route in the turn. */
  readonly total: number
  /** Routes that had configured rates and contributed to {@link TurnCost.total}. */
  readonly priced: readonly string[]
  /** Routes the turn used that carry no rates, so their share is not in the total. */
  readonly unpriced: readonly string[]
}

/**
 * Read the buckets a session accumulated from its projection value.
 * @param usage - the session's `tokenUsage` projection value.
 * @returns the same four prompt-side and output buckets this package prices.
 */
export function sessionBuckets(usage: TokenUsageProjection): SessionBuckets {
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
  }
}

/**
 * Buckets added between two reads of the running session total.
 * @param previous - the total before the change.
 * @param next - the total after it.
 * @returns each bucket's non-negative growth.
 */
export function bucketDelta(previous: SessionBuckets, next: SessionBuckets): SessionBuckets {
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - previous.uncachedInputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
  }
}

/**
 * Whether one delta carries no billed tokens.
 * @param buckets - one delta or running total.
 * @returns whether every bucket is zero, which means there is nothing to price.
 */
export function isEmptyBuckets(buckets: SessionBuckets): boolean {
  return buckets.uncachedInputTokens === 0
    && buckets.cacheReadTokens === 0
    && buckets.cacheWriteTokens === 0
    && buckets.outputTokens === 0
}

/**
 * Price a session from its billed stretches.
 *
 * A step whose route carries no rates contributes nothing, and the caller
 * reports that absence separately rather than showing a wrong total.
 * @param steps - billed stretches in accumulation order.
 * @param rates - configured rates by route.
 * @returns the priced total in the configured currency.
 */
export function sessionCost(steps: readonly SessionCostStep[], rates: RateTable): number {
  let total = 0
  for (const step of steps) {
    const rate = rates[step.route]
    if (rate === undefined) continue
    total += priceUsage(bandAt(rate, step.at), {
      // Cache writes are billed as uncached input, which is the bucket the
      // provider already reported them in for the prompt-side total.
      cacheMissTokens: step.buckets.uncachedInputTokens + step.buckets.cacheWriteTokens,
      cacheHitTokens: step.buckets.cacheReadTokens,
      outputTokens: step.buckets.outputTokens,
    })
  }
  return total
}

/**
 * The window one route's charge is identified by.
 * @param route - the `provider/model` key charged.
 * @param at - epoch milliseconds of the charge.
 * @param rates - configured rates by route.
 * @returns the window in force at `at`, or `peak` for a route that publishes one price.
 */
export function chargeWindow(route: string, at: number, rates: RateTable): PriceWindow {
  return rates[route]?.offPeak === undefined ? 'peak' : priceWindowAt(at)
}

/**
 * Place one turn's exact accounting on the routes it was billed for.
 *
 * The turn-tail accounting carries one aggregate per bucket plus the set of
 * routes that billed it, and nothing per attempt: the loaded Chat nodes carry
 * each attempt's usage and settle time, but not the route that served it, and a
 * route guessed from a retry record names a provider without a model. So the
 * aggregate is priced only when a single route is named — every billed attempt
 * ran there, and the figure is exact — and a turn that ran on several routes
 * yields no row rather than stating the aggregate under each of them, which
 * would charge the turn once per route. The caller names the routes it could
 * not attribute while no row is returned.
 *
 * A route is split by window only when its rates state one, because a route
 * with a single published price charges the same figure at every hour and two
 * rows would state that once each.
 * @param usage - the turn's exact accounting.
 * @param rates - configured rates by route, which say whether a route prices by window.
 * @param at - epoch milliseconds the turn closed, which selects the price window.
 * @returns one row for a turn its accounting attributes to one route, otherwise no rows.
 */
export function turnRouteUsage(
  usage: TurnTokenUsage,
  rates: RateTable,
  at: number,
): TurnRouteUsage[] {
  const named = turnRoutes(usage)
  const [only] = named
  return named.length === 1 && only !== undefined
    ? [{ route: only, window: chargeWindow(only, at, rates), buckets: turnBuckets(usage) }]
    : []
}

/**
 * One turn's aggregate accounting as priceable buckets.
 * @param usage - the turn's exact accounting.
 * @returns the four buckets, with the absent cache counts read as zero.
 */
function turnBuckets(usage: TurnTokenUsage): TurnBuckets {
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * Price one turn's charge rows.
 * @param rows - the turn's per-charge buckets.
 * @param rates - configured rates by route.
 * @returns the priced total plus which routes were priced.
 */
export function turnCost(rows: readonly TurnRouteUsage[], rates: RateTable): TurnCost {
  let total = 0
  const priced: string[] = []
  const unpriced: string[] = []
  for (const row of rows) {
    const rate = rates[row.route]
    if (rate === undefined) {
      if (!unpriced.includes(row.route)) unpriced.push(row.route)
      continue
    }
    if (!priced.includes(row.route)) priced.push(row.route)
    total += priceUsage(bandFor(rate, row.window), {
      cacheMissTokens: row.buckets.uncachedInputTokens + row.buckets.cacheWriteTokens,
      cacheHitTokens: row.buckets.cacheReadTokens,
      outputTokens: row.buckets.outputTokens,
    })
  }
  return { total, priced, unpriced }
}

/**
 * Routes a turn billed, as its own durable accounting names them.
 * @param usage - the turn's exact accounting.
 * @returns route keys in the order the log declared them.
 */
export function turnRoutes(usage: TurnTokenUsage): string[] {
  return usage.routes?.map(route => routeKey(route.provider, route.model)) ?? []
}
