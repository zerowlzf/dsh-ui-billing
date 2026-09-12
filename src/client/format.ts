/**
 * Money, time, and failure formatting for the billing surfaces.
 *
 * Cost values span four orders of magnitude in ordinary use: one turn is a
 * fraction of a yuan while a long session reaches tens. A fixed precision
 * renders either `¥0.00` forever or noise, so the formatter widens with the
 * magnitude and reports pennies only where they mean something.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/format
 */

import type { BalanceFailure, PriceFailure, PriceWindow } from '../settings.ts'
import type { BillingTranslate } from './locales.ts'

/** Currency symbol used when the provider reports a code this table does not carry. */
const DEFAULT_SYMBOL = '¥'

const SYMBOLS: Readonly<Record<string, string>> = { CNY: '¥', USD: '$', EUR: '€' }

/**
 * Symbol for one currency code.
 * @param currency - ISO code the balance reported, or the configured fallback.
 * @returns the symbol this package displays it with, or the yen/yuan sign for a code the table does not carry.
 */
export function currencySymbol(currency: string): string {
  return SYMBOLS[currency] ?? DEFAULT_SYMBOL
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits)
}

/**
 * Format one amount with magnitude-adaptive precision.
 * @param amount - the amount to format.
 * @param currency - currency code selecting the symbol.
 * @returns the symbol followed by the amount, or `-` for a non-finite value.
 */
export function formatAmount(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '-'
  const symbol = currencySymbol(currency)
  const magnitude = Math.abs(amount)
  if (magnitude === 0) return `${symbol}0.00`
  // Below a yuan the leading digits are zeroes; two significant digits carry
  // the information a reader wants. Above a yuan, cents are the unit of
  // account and two decimals are both exact enough and conventional.
  if (magnitude < 0.001) return `${symbol}${fixed(amount, 6)}`
  if (magnitude < 0.01) return `${symbol}${fixed(amount, 5)}`
  if (magnitude < 0.1) return `${symbol}${fixed(amount, 4)}`
  if (magnitude < 1) return `${symbol}${fixed(amount, 3)}`
  if (magnitude < 1000) return `${symbol}${fixed(amount, 2)}`
  return `${symbol}${fixed(amount, 0)}`
}

/**
 * Format one balance, which is an account figure rather than a cost: it keeps
 * cents as soon as it is worth a cent.
 * @param amount - the balance amount.
 * @param currency - currency code selecting the symbol.
 * @returns the symbol followed by the amount, or `-` for a non-finite value.
 */
export function formatBalance(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '-'
  const symbol = currencySymbol(currency)
  const magnitude = Math.abs(amount)
  if (magnitude === 0) return `${symbol}0.00`
  if (magnitude < 0.01) return `${symbol}${fixed(amount, 4)}`
  return `${symbol}${fixed(amount, 2)}`
}

/**
 * Localized reason one balance read produced no snapshot.
 *
 * The Host half reports the kind and its values; the sentence is this side's,
 * so the Chinese and English surfaces state the same failure in their own
 * language. The technical detail a resolver or response parse produced is
 * appended after it, because a person cannot translate that string and hiding
 * it would leave a failure with nothing to act on.
 * @param failure - the structured reason the Host recorded.
 * @param t - the surface's translate seat.
 * @returns the display line, including the detail when the failure carried one.
 */
export function balanceFailureText(failure: BalanceFailure, t: BillingTranslate): string {
  switch (failure.kind) {
    case 'noKey': return t('balance.failure.noKey', { ref: failure.ref })
    case 'http': return t('balance.failure.http', { status: failure.status })
    case 'network': return withDetail(t('balance.failure.network'), failure.detail, t)
    case 'payload': return withDetail(t('balance.failure.payload'), failure.detail, t)
  }
}

/**
 * Localized reason one price read produced no table.
 *
 * The page states its own currency, so a read of an edition that prices in
 * another one is a failure with both codes named rather than a table silently
 * mixed into figures of the wrong currency.
 * @param failure - the structured reason the Host recorded.
 * @param t - the surface's translate seat.
 * @returns the display line, including the detail when the failure carried one.
 */
export function priceFailureText(failure: PriceFailure, t: BillingTranslate): string {
  switch (failure.kind) {
    case 'noWeb': return t('price.failure.noWeb')
    case 'http': return t('price.failure.http', { status: failure.status })
    case 'network': return withDetail(t('price.failure.network'), failure.detail, t)
    case 'payload': return withDetail(t('price.failure.payload'), failure.detail, t)
    case 'currency': return t('price.failure.currency', { found: failure.found, expected: failure.expected })
  }
}

function withDetail(title: string, detail: string, t: BillingTranslate): string {
  return detail === '' ? title : `${title} · ${t('read.failure.detail', { detail })}`
}

/**
 * Dictionary key naming one price window.
 * @param window - the window a charge fell in, or the one in force now.
 * @returns the key whose copy names it.
 */
export function windowKey(window: PriceWindow): 'window.peak' | 'window.offPeak' {
  return window === 'peak' ? 'window.peak' : 'window.offPeak'
}

/** Relative age of one timestamp, for the balance freshness label. */
export type AgeBucket =  | { readonly kind: 'justNow' }
  | { readonly kind: 'minutes'; readonly count: number }
  | { readonly kind: 'hours'; readonly count: number }
  | { readonly kind: 'days'; readonly count: number }

/**
 * Bucket the age of one timestamp.
 * @param at - epoch milliseconds of the fact.
 * @param now - epoch milliseconds of the current render.
 * @returns the age bucket; a future timestamp reads as `justNow`.
 */
export function ageOf(at: number, now: number): AgeBucket {
  const seconds = (now - at) / 1000
  if (seconds < 60) return { kind: 'justNow' }
  if (seconds < 3600) return { kind: 'minutes', count: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { kind: 'hours', count: Math.floor(seconds / 3600) }
  return { kind: 'days', count: Math.floor(seconds / 86_400) }
}
