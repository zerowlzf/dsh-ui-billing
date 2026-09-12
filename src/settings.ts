/**
 * The `ui-billing` settings namespace: its name, value contract, schema, and
 * the pure rate fold both faces share.
 *
 * The value mixes three kinds of fact. `models` is user configuration — one
 * rate row per `provider/model` route, written by the Billing settings page.
 * `cache` and `official` are Host-owned state: the newest DeepSeek balance and
 * the newest published price table the Host could read, which the browser
 * displays without a Remote of its own.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/settings
 */

import Schema from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const NS = 'ui-billing'

/** Route key separating a provider id from a model id inside one rate-row key. */
export const ROUTE_SEPARATOR = '/'

/**
 * Currency the shipped DeepSeek route bills in, and the display currency both
 * the namespace default and the Host account read start from.
 */
export const DEFAULT_CURRENCY = 'CNY'

/** Per-million-token rates for one route during one of a provider's price windows. */
export interface RateBand {
  /** Cached prompt input. */
  cacheHit: number
  /** Uncached prompt input, including cache writes. */
  cacheMiss: number
  /** Model output, reasoning tokens included. */
  output: number
}

/**
 * One route's rates, in the configured display currency.
 *
 * The three flat fields are the peak band, which is what a provider publishing
 * a single price charges at every hour. `offPeak` is the band charged outside
 * that provider's peak window; a row without one costs the same all day, which
 * is the honest reading of a provider that publishes one figure.
 */
export interface ModelRate extends RateBand {
  /** Rates charged outside the peak window; absent means one price at every hour. */
  offPeak?: RateBand | undefined
}

/** The three rate fields, in display order, within one band. */
export const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'output'] as const

/** Which of a provider's two daily price windows a moment falls in. */
export type PriceWindow = 'peak' | 'offPeak'

/** Beijing runs on UTC+8 with no daylight saving, and the published window is stated there. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * The price window in force at one moment.
 *
 * DeepSeek's published price page defines peak as Beijing time Monday–Friday
 * 09:00–12:00 and 14:00–18:00, and every other hour as off-peak at half the
 * peak rates. That window is the provider's published rule rather than a
 * deployment choice, so it is fixed here; a deployment billed on another
 * calendar overrides the affected routes' rates instead.
 * @param at - epoch milliseconds.
 * @returns the window in force at that instant.
 */
export function priceWindowAt(at: number): PriceWindow {
  const beijing = new Date(at + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return 'offPeak'
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'offPeak'
}

/**
 * The rates one route charged in one window.
 * @param rate - the route's stored or published row.
 * @param window - the window the charge falls in.
 * @returns the off-peak band while off-peak is in force, otherwise the row's own three figures.
 */
export function bandFor(rate: ModelRate, window: PriceWindow): RateBand {
  if (window === 'offPeak' && rate.offPeak !== undefined) return rate.offPeak
  return { cacheHit: rate.cacheHit, cacheMiss: rate.cacheMiss, output: rate.output }
}

/**
 * The rates one route charged at one moment.
 * @param rate - the route's stored or published row.
 * @param at - epoch milliseconds the charge is attributed to.
 * @returns the band in force at that instant.
 */
export function bandAt(rate: ModelRate, at: number): RateBand {
  return bandFor(rate, priceWindowAt(at))
}

/**
 * Whether one route's rates depend on the window.
 * @param rate - the route's stored or published row, or undefined when it has none.
 * @returns whether the row states an off-peak band, which is what a surface names a window for.
 */
export function pricesByWindow(rate: ModelRate | undefined): boolean {
  return rate?.offPeak !== undefined
}

/** One field of {@link ModelRate}. */
export type RateField = (typeof RATE_FIELDS)[number]

/**
 * Parse one user-typed rate.
 * @param text - the input's text.
 * @returns the parsed non-negative number, or undefined when the text is not one.
 */
export function parseRate(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One balance figure the Host read from the provider account API. */
export interface BalanceSnapshot {
  /** Total available balance in {@link BalanceSnapshot.currency}. */
  total: number
  /** Currency the provider reported; a display value, never converted. */
  currency: string
  /** Whether the provider reports the balance as sufficient for further calls. */
  available: boolean
  /** When the Host read it, in epoch milliseconds. */
  at: number
}

/**
 * Why one Host read produced no value.
 *
 * The reason is structured rather than a sentence because the browser renders
 * it: the Host half owns the read and the browser owns the copy, so a failure
 * crosses that boundary as a kind plus the values its sentence needs, with the
 * technical detail a person cannot translate riding along for a second line.
 */
export type ReadFailure =
  /** Nothing held a value for the referenced key. */
  | { readonly kind: 'noKey'; readonly ref: string }
  /** The endpoint answered with a status other than 200. */
  | { readonly kind: 'http'; readonly status: number }
  /** The request itself did not complete. */
  | { readonly kind: 'network'; readonly detail: string }
  /** The response arrived but could not be read as the documented payload. */
  | { readonly kind: 'payload'; readonly detail: string }

/** Why the balance read produced no snapshot. */
export type BalanceFailure = ReadFailure

/** Why the price read produced no usable table; a price page needs no key. */
export type PriceFailure =
  | Exclude<ReadFailure, { readonly kind: 'noKey' }>
  /** The deployment mounts no web capability, so no page can be read. */
  | { readonly kind: 'noWeb' }
  /** The page states its figures in a currency the document does not price in. */
  | { readonly kind: 'currency'; readonly found: string; readonly expected: string }

/** Rates the Host read from the provider's published price page. */
export interface PriceSnapshot {
  /** Model id → published rates, both windows, exactly as that page states them. */
  models: Record<string, ModelRate>
  /** Currency the page states its figures in. */
  currency: string
  /** When the Host read it, in epoch milliseconds. */
  at: number
  /** Page the figures came from. */
  source: string
}

/** The namespace's complete value. */
export interface BillingSettings {
  /**
   * Currency rates are stated in, and the code every cost is displayed with
   * before a balance names its own. A deployment that bills in another
   * currency sets it in the settings document.
   */
  currency: string
  /** Rate rows keyed `provider/model`; absent routes are priced by nothing. */
  models: Record<string, ModelRate>
  /** Newest Host-read balance, or null before the first successful read. */
  cache: BalanceSnapshot | null
  /** Why the newest balance read failed, or null when it succeeded or never ran. */
  cacheError: ReadFailure | null
  /** Newest Host-read published price table, or null before the first successful read. */
  official: PriceSnapshot | null
  /** Why the newest price read failed, or null when it succeeded or never ran. */
  officialError: PriceFailure | null
  /**
   * A price read the browser asked for, as the moment it asked, or null when
   * none is pending.
   *
   * A published price list moves rarely, so the automatic read is long-spaced
   * and a restart inside that interval does not re-read a fresh table. The page
   * is what knows someone wants the figures now, and the settings document is
   * the one store both halves share, so the request travels as this write: the
   * Host reads the page and clears the field when that read settles.
   */
  officialRequest: number | null
}

/**
 * Compose one rate-row key.
 * @param provider - provider id as the model directory reports it.
 * @param model - model id inside that provider.
 * @returns the `provider/model` key one rate row is stored under.
 */
export function routeKey(provider: string, model: string): string {
  return `${provider}${ROUTE_SEPARATOR}${model}`
}

/**
 * Split a rate-row key back into its route.
 * @param key - a key as {@link routeKey} composes it.
 * @returns the provider and model, or undefined for a key with no model part.
 */
export function splitRouteKey(key: string): { provider: string; model: string } | undefined {
  const at = key.indexOf(ROUTE_SEPARATOR)
  if (at <= 0 || at === key.length - 1) return undefined
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

const bandSchema: Schema<RateBand> = Schema.object({
  cacheHit: Schema.number().default(0),
  cacheMiss: Schema.number().default(0),
  output: Schema.number().default(0),
})

// The optional band is a union with `undefined` rather than a bare nested
// object: a nested object resolves an absent key into a band of zeroes, which
// would bill every off-peak hour at nothing instead of at the peak rate.
const rateSchema: Schema<ModelRate> = Schema.object({
  cacheHit: Schema.number().default(0),
  cacheMiss: Schema.number().default(0),
  output: Schema.number().default(0),
  offPeak: Schema.union([Schema.const(undefined), bandSchema]),
})

const balanceSchema: Schema<BalanceSnapshot | null> = Schema.union([
  Schema.const(null),
  Schema.object({
    total: Schema.number().default(0),
    currency: Schema.string().default(DEFAULT_CURRENCY),
    available: Schema.boolean().default(true),
    at: Schema.number().default(0),
  }),
])

// The two failure unions repeat their shared arms rather than reusing one
// array: a union's members are inferred from the literal array it is given, and
// an annotated array of member schemas is not assignable to it.
const failureSchema: Schema<BalanceFailure | null> = Schema.union([
  Schema.const(null),
  Schema.object({ kind: Schema.const('noKey').required(), ref: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('http').required(), status: Schema.number().default(0) }),
  Schema.object({ kind: Schema.const('network').required(), detail: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('payload').required(), detail: Schema.string().default('') }),
])

const priceFailureSchema: Schema<PriceFailure | null> = Schema.union([
  Schema.const(null),
  Schema.object({ kind: Schema.const('http').required(), status: Schema.number().default(0) }),
  Schema.object({ kind: Schema.const('network').required(), detail: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('payload').required(), detail: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('noWeb').required() }),
  Schema.object({
    kind: Schema.const('currency').required(),
    found: Schema.string().default(''),
    expected: Schema.string().default(''),
  }),
])

const priceSnapshotSchema: Schema<PriceSnapshot | null> = Schema.union([
  Schema.const(null),
  Schema.object({
    models: Schema.dict(rateSchema).default({}),
    currency: Schema.string().default(DEFAULT_CURRENCY),
    at: Schema.number().default(0),
    source: Schema.string().default(''),
  }),
])

/** The namespace schema; `settings.register` resolves and validates against it. */
export const BillingSettingsSchema: Schema<BillingSettings> = Schema.object({
  currency: Schema.string().default(DEFAULT_CURRENCY),
  models: Schema.dict(rateSchema).default({}),
  cache: balanceSchema.default(null),
  cacheError: failureSchema.default(null),
  official: priceSnapshotSchema.default(null),
  officialError: priceFailureSchema.default(null),
  officialRequest: Schema.union([Schema.const(null), Schema.number()]).default(null),
})

/** Token buckets one route was billed for, in the provider's own units. */
export interface RouteUsage {
  /** Uncached prompt input, including cache writes. */
  cacheMissTokens: number
  /** Cached prompt input. */
  cacheHitTokens: number
  /** Model output. */
  outputTokens: number
}

/**
 * Price one route's buckets under one band.
 *
 * Rates are per million tokens, so the result is in the configured currency.
 * Every bucket is charged at its own rate; a route with no configured row
 * prices to zero, and the caller decides whether that absence is worth
 * displaying.
 * @param rate - the rates in force for this charge, as {@link bandAt} selects them.
 * @param usage - the route's billed buckets.
 * @returns the cost in the configured currency.
 */
export function priceUsage(rate: RateBand, usage: RouteUsage): number {
  return (usage.cacheHitTokens * rate.cacheHit
    + usage.cacheMissTokens * rate.cacheMiss
    + usage.outputTokens * rate.output) / 1_000_000
}
