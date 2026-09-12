/**
 * Published DeepSeek prices, used as the fallback rate for the official
 * provider's routes.
 *
 * The page still owns the numbers: a route the user has priced is billed at
 * that row, then the newest table the Host read from the published page, and
 * these values fill in whatever neither covers, so an official session reads a
 * cost out of the box and offline. They are the provider's published
 * per-million-token prices for the model ids the shipped adapter reports,
 * stated in CNY; the page publishes the same figures in USD for its English
 * edition, which is why a read of that edition is refused rather than mixed in.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/official-rates
 */

import type { ModelRate, PriceSnapshot } from '../settings.ts'
import type { RateTable } from './cost.ts'
import { OFFICIAL_PROVIDER } from './routes.ts'

/**
 * DeepSeek-V4.1-Flash: peak cache hit / miss / output, then the off-peak band,
 * which the page publishes at half these figures.
 */
const FLASH: ModelRate = {
  cacheHit: 0.04,
  cacheMiss: 2,
  output: 8,
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
}

/** DeepSeek-V4-Pro-0813, on the same two-window schedule as Flash. */
const PRO: ModelRate = {
  cacheHit: 0.3,
  cacheMiss: 9,
  output: 27,
  offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
}

/**
 * Route → published rate, keyed `provider/model` exactly as stored rates are.
 *
 * The two legacy Flash model ids are listed because the adapter still reports
 * them and the page still defines their price: their models are retired and
 * their requests are served, and billed, as Flash.
 */
export const OFFICIAL_RATES: RateTable = {
  [`${OFFICIAL_PROVIDER}/deepseek-flash`]: FLASH,
  [`${OFFICIAL_PROVIDER}/deepseek-v4-flash`]: FLASH,
  [`${OFFICIAL_PROVIDER}/deepseek-v4-flash-vision-exp`]: FLASH,
  [`${OFFICIAL_PROVIDER}/deepseek-v4-pro`]: PRO,
}

/** Model ids the published page no longer lists but bills as another model. */
const PUBLISHED_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/**
 * Routes one published price table prices.
 *
 * The Host reads model ids off a page that knows nothing about DSH routes, so
 * the official provider id is what turns each one into a route here; a legacy
 * id absent from the table is priced at the model the page says serves it.
 * @param snapshot - the newest Host-read table, or null before one succeeded.
 * @returns the published rows keyed by route; empty without a snapshot.
 */
export function publishedRates(snapshot: PriceSnapshot | null | undefined): RateTable {
  if (snapshot === null || snapshot === undefined) return {}
  const rows: Record<string, ModelRate> = {}
  for (const [model, rate] of Object.entries(snapshot.models)) {
    rows[`${OFFICIAL_PROVIDER}/${model}`] = rate
  }
  for (const [legacy, served] of Object.entries(PUBLISHED_ALIASES)) {
    const route = `${OFFICIAL_PROVIDER}/${legacy}`
    const rate = rows[`${OFFICIAL_PROVIDER}/${served}`]
    if (rate !== undefined && rows[route] === undefined) rows[route] = rate
  }
  return rows
}

/**
 * Rates to price a session with: the shipped table, overridden by the newest
 * published read, overridden by every row the user stored.
 * @param stored - the namespace's stored rate rows, if any.
 * @param published - the newest Host-read price table, if any.
 * @returns the rate table the folds price with.
 */
export function effectiveRates(
  stored: Readonly<Record<string, ModelRate>> | undefined,
  published?: PriceSnapshot | null,
): RateTable {
  return { ...OFFICIAL_RATES, ...publishedRates(published), ...stored }
}

/**
 * The rate one route falls back to when the user stored none.
 * @param route - a `provider/model` key.
 * @param published - the newest Host-read price table, if any.
 * @returns the newest published rate, the shipped one, or undefined for a route neither carries.
 */
export function defaultRateOf(route: string, published?: PriceSnapshot | null): ModelRate | undefined {
  return publishedRates(published)[route] ?? OFFICIAL_RATES[route]
}
