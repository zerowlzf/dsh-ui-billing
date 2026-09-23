/**
 * Billing plugin, Host half: declares the billing fields live in its own Config
 * and keeps its two account reads fresh.
 *
 * The live fields are the whole Host surface. Rates are user configuration the
 * browser writes through the configuration form; the balance and the published
 * price table are reads of the provider's own pages, which the Host writes back
 * into the same fields the browser reads. Nothing here is model-visible and no
 * route is registered, so mounting this half only adds account facts to this
 * plugin's own configuration.
 *
 * The fields are declared volatile, so an edit does not remount the plugin: a
 * rate row the user saves reaches the running instance through the loader's
 * volatile update, and a value this half writes reaches the browser the same
 * way. The entry id the page and this half address is {@link NS}, which is also
 * the row id the web composition declares, and therefore the section the
 * removed `settings.yaml` is imported into: a document written before this
 * change migrates to these fields instead of being lost.
 *
 * @module @deepseek-ai/dsh-client-ui-billing
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only: activates the `ctx.settings` Context declaration.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: activates the `ctx.timer` Context declaration and its `ctx.timeout` mixin.
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: activates the Loader's Events declaration, whose
// `loader/volatile-update` is how a committed live-field change reaches this
// half without a remount.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: activates the `ctx.credentials` Context declaration.
import type {} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: activates the `ctx.web` Context declaration.
import type {} from '@deepseek-ai/dsh-web'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, readBalance } from './account.ts'
import { DEFAULT_PRICING_URL, readPrices, type PageFetcher } from './published-prices.ts'
import {
  BillingSettingsFields, NS,
  type BalanceSnapshot, type BillingSettings, type ModelRate, type PriceSnapshot,
  type PriceFailure, type ReadFailure,
} from './settings.ts'

/**
 * Required services: the configuration form owner, the refresh timer, and the
 * credential store. The credential store is a required wait because a read that
 * starts before its document is loaded reports a missing key as though the
 * operator had stored none.
 */
export const inject = ['settings', 'timer', 'credentials']

/** Plugin configuration. Ordinary fields are deployment-level; the rest are live. */
export interface Config {
  /** Credential reference holding the DeepSeek API key. */
  apiKeyEnv: string
  /** DeepSeek API base; `/user/balance` is appended. */
  baseURL: string
  /** Delay between balance reads; `0` reads once at startup and schedules no further read. */
  refreshIntervalMs: number
  /** Published price page rates are read from. */
  pricingUrl: string
  /**
   * Delay between automatic price reads. A published price list moves rarely,
   * so the wait is long and a restart inside it does not re-read a fresh table;
   * `0` reads once at startup and schedules no further read. The page can ask
   * for a read at any time whatever this value is.
   */
  pricingRefreshIntervalMs: number
  /** Whole-request deadline for one read. */
  requestTimeoutMs: number
  /** Currency rates are stated in, and the code every cost is displayed with. */
  currency: Volatile<string>
  /** Rate rows keyed `provider/model`; absent routes are priced by nothing. */
  models: Volatile<Record<string, ModelRate>>
  /** Newest Host-read balance, or null before the first successful read. */
  cache: Volatile<BalanceSnapshot | null>
  /** Why the newest balance read failed, or null when it succeeded or never ran. */
  cacheError: Volatile<ReadFailure | null>
  /** Newest Host-read published price table, or null before the first successful read. */
  official: Volatile<PriceSnapshot | null>
  /** Why the newest price read failed, or null when it succeeded or never ran. */
  officialError: Volatile<PriceFailure | null>
  /**
   * A price read the browser asked for, as the moment it asked, or null when
   * none is pending. The field is the one store both halves share, so the
   * request travels as this write: the Host reads the page and clears it when
   * that read settles.
   */
  officialRequest: Volatile<number | null>
}

/**
 * Configuration schema; every live field carries the value the plugin uses when
 * unset. The schema is not annotated with the interface: a live field resolves
 * to a reference rather than to the plain value a `Schema<Config>` annotation
 * would demand.
 */
export const Config = Schema.object({
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string().default(DEFAULT_BASE_URL),
  refreshIntervalMs: Schema.natural().default(300_000),
  pricingUrl: Schema.string().default(DEFAULT_PRICING_URL),
  pricingRefreshIntervalMs: Schema.natural().default(15 * 86_400_000),
  requestTimeoutMs: Schema.natural().default(15_000),
  currency: BillingSettingsFields.currency.volatile(),
  models: BillingSettingsFields.models.volatile(),
  cache: BillingSettingsFields.cache.volatile(),
  cacheError: BillingSettingsFields.cacheError.volatile(),
  official: BillingSettingsFields.official.volatile(),
  officialError: BillingSettingsFields.officialError.volatile(),
  officialRequest: BillingSettingsFields.officialRequest.volatile(),
})

/**
 * Declare the live fields and start both refresh chains.
 * @param ctx - Host context carrying the settings form, timer, and credentials.
 * @param config - endpoints, credential, timing values, and the live fields.
 */
export function apply(ctx: Context, config: Config): void {
  // This plugin carries its own configuration page, so the generated one is
  // turned off: the page is registered by the browser half against the same
  // entry id.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  // The timer service's own methods are used directly: the Context mixin
  // delegates to `this.ctx`, whose fiber is the service — an effect armed
  // through it would belong to the service, not to this plugin.
  const timer = ctx.timer
  // The credential store is a declared injection, so it is initialized before
  // this runs; the environment covers a store that holds no value for the
  // reference. The reference is the operator's own configuration value, taken
  // as written: the seam refuses a malformed one through its own lookup.
  const resolveKey = async (): Promise<string | undefined> => {
    const resolved = await ctx.credentials.resolve(config.apiKeyEnv as CredentialRef)
    return resolved?.value ?? process.env[config.apiKeyEnv]
  }
  // The Host's web capability is the deployment's own retrieval path, so the
  // price read goes through it instead of a request of this package's own. It
  // is optional: a deployment that mounts no web provider still declares the
  // fields and reads the balance, and the price read reports that it had no
  // page to read.
  const fetchPage = (): PageFetcher | undefined => {
    const web = ctx.get('web')
    return web === undefined ? undefined : (url, signal) => web.fetch({ url }, signal)
  }

  let stopped = false
  const armed = new Set<() => void>()
  let priceTimer: (() => void) | undefined

  /**
   * Arm one chain's next tick, unless the plugin stopped or configured it off.
   * @param delayMs - wait before the tick; `0` arms nothing.
   * @param run - the chain, which re-arms itself when it settles.
   * @returns the handle that cancels this tick, or undefined when none was armed.
   */
  const schedule = (delayMs: number, run: () => Promise<void>): (() => void) | undefined => {
    if (stopped || delayMs <= 0) return undefined
    const handle = timer.timeout(() => {
      armed.delete(handle)
      void run()
    }, delayMs)
    armed.add(handle)
    return handle
  }

  /**
   * Read the live value once.
   *
   * A value is read where it is used rather than held, because a field is
   * replaced wholesale when the browser saves: a captured copy would price
   * against rates the operator already changed. Every field resolves to a
   * value — the loader fills the schema's defaults — so nothing here states a
   * fallback of its own.
   * @returns the fields as the form resolves them.
   */
  const read = (): BillingSettings => ({
    currency: config.currency.get(),
    models: config.models.get(),
    cache: config.cache.get() ?? null,
    cacheError: config.cacheError.get() ?? null,
    official: config.official.get() ?? null,
    officialError: config.officialError.get() ?? null,
    officialRequest: config.officialRequest.get() ?? null,
  })

  /** Commit one read's result. A refused write leaves the previous value in place. */
  const commit = async (patch: Partial<BillingSettings>): Promise<void> => {
    try {
      await ctx.settings.update(NS, patch)
    } catch (error: unknown) {
      ctx.logger.warn('ui-billing: settings write failed')
      ctx.logger.warn(error)
    }
  }

  const refreshBalance = async (): Promise<void> => {
    const result = await readBalance({
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      currency: config.currency.get(),
      timeoutMs: config.requestTimeoutMs,
    }, resolveKey)
    if (stopped) return
    // A failed refresh keeps the previous snapshot: a stale amount with its
    // timestamp is more useful than an empty field, and the reason says why.
    await commit(result.ok
      ? { cache: result.balance, cacheError: null }
      : { cacheError: result.failure })
    schedule(config.refreshIntervalMs, refreshBalance)
  }

  /**
   * Arm the price chain's next automatic read.
   *
   * The wait is what the stored table has left of the interval rather than a
   * whole one, so a restart inside the interval waits instead of re-reading a
   * table the provider has not changed. Every settlement re-arms through here,
   * and arming replaces the outstanding timer: a read the page asked for moves
   * the automatic one out by a full interval rather than adding a second timer.
   * @param full - wait a whole interval, whatever the stored table's age.
   */
  const armPriceRead = (full = false): void => {
    const interval = config.pricingRefreshIntervalMs
    const at = read().official?.at
    const age = at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at
    // A table nobody has read, a table older than the interval, and an interval
    // of 0 are all due at once; a settlement that just happened waits a whole one.
    const due = full ? interval : Math.max(0, interval - age)
    priceTimer?.()
    priceTimer = undefined
    if (due <= 0) {
      void refreshPrices()
      return
    }
    priceTimer = schedule(due, refreshPrices)
  }

  const refreshPrices = async (): Promise<void> => {
    // A request the page made stays pending until this read settles, whichever
    // way it went, so the page can show that read as in flight. The field is
    // absent until something writes it, which is no request either.
    const requested = read().officialRequest != null
    const result = await readPrices({
      url: config.pricingUrl,
      currency: config.currency.get(),
      timeoutMs: config.requestTimeoutMs,
    }, fetchPage())
    if (stopped) return
    // Prices move far less often than a balance does, and a failed read keeps
    // the previous table: the shipped snapshot still prices the official routes.
    const outcome: Partial<BillingSettings> = result.ok
      ? {
        official: {
          models: result.prices.models,
          currency: result.prices.currency,
          at: Date.now(),
          source: config.pricingUrl,
        },
        officialError: null,
      }
      : { officialError: result.failure }
    await commit(requested ? { ...outcome, officialRequest: null } : outcome)
    if (config.pricingRefreshIntervalMs > 0) armPriceRead(true)
  }

  // A price read the page asked for: the configuration form is the one store
  // both halves share, and the Host is the half that can read the page at all
  // (the documentation origin serves the browser no readable response). A
  // request is served once; the Host's own clearing of the field is not one.
  let servedRequest: number | null = null
  ctx.on('loader/volatile-update', (paths) => {
    // Only the request field moves this chain: every other live change this
    // half sees is its own write coming back.
    if (!paths.some(path => path[0] === 'officialRequest')) return
    const request = read().officialRequest
    if (request == null || request === servedRequest) return
    servedRequest = request
    void refreshPrices()
  })

  ctx.effect(() => {
    void refreshBalance()
    armPriceRead()
    return () => {
      stopped = true
      for (const handle of armed) handle()
      armed.clear()
      priceTimer = undefined
    }
  }, 'ui-billing: account reads')
}
