/**
 * DeepSeek account-balance reads for the Host half.
 *
 * The plugin owns this call rather than the LLM adapter because the balance is
 * an account fact, not a route fact: the page shows it while the session runs
 * on any provider. One read asks the caller's resolver for the credential,
 * sends the single documented request, and reports either the balance or the
 * structured reason it produced none, which the browser turns into copy.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/account
 */

import type { BalanceFailure, BalanceSnapshot } from './settings.ts'

/** Official DeepSeek API base; the account endpoints hang off it directly. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Credential reference resolved when config names none. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Result of one balance read: the newest snapshot, or why none was produced. */
export type BalanceRead =
  | { readonly ok: true; readonly balance: BalanceSnapshot }
  | { readonly ok: false; readonly failure: BalanceFailure }

/** Everything one read needs besides the key itself. */
export interface BalanceReadRequest {
  /** Endpoint base; the `/user/balance` path is appended. */
  readonly baseURL: string
  /** Credential reference this read reports when nothing holds it. */
  readonly apiKeyEnv: string
  /** Currency to report when the account carries several. */
  readonly currency: string
  /** Whole-request deadline in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Resolve the API key for the next read.
 *
 * The caller owns this because resolving a credential belongs to the plugin
 * body that declares the credential service; a read only needs the value.
 * @returns the key, or undefined when neither the credential store nor the
 * process environment holds one.
 */
export type ApiKeyResolver = () => Promise<string | undefined>

interface BalanceInfo {
  readonly currency: string
  readonly totalBalance: number
}

/**
 * Narrow one `balance_infos` entry.
 * @param value - untrusted array element.
 * @returns the currency and amount, or undefined when either is missing.
 */
function balanceInfo(value: unknown): BalanceInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const currency = entry['currency']
  const total = entry['total_balance']
  if (typeof currency !== 'string' || currency.length === 0) return undefined
  if (typeof total !== 'string') return undefined
  const amount = Number.parseFloat(total)
  if (!Number.isFinite(amount)) return undefined
  return { currency, totalBalance: amount }
}

/**
 * Pick the entry to display: the configured currency when the account carries
 * it, otherwise the first one the provider listed.
 * @param infos - every parsed balance entry.
 * @param currency - preferred currency code.
 * @returns the chosen entry.
 */
function preferred(infos: readonly BalanceInfo[], currency: string): BalanceInfo | undefined {
  return infos.find(info => info.currency === currency) ?? infos[0]
}

/**
 * Read one DeepSeek account balance.
 * @param request - endpoint, credential reference, currency preference, and deadline.
 * @param resolveKey - resolves the API key for this read.
 * @returns the newest snapshot or the structured reason none was produced.
 */
export async function readBalance(
  request: BalanceReadRequest,
  resolveKey: ApiKeyResolver,
): Promise<BalanceRead> {
  const apiKey = await resolveKey()
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, failure: { kind: 'noKey', ref: request.apiKeyEnv } }
  }

  const url = `${request.baseURL.replace(/\/+$/, '')}/user/balance`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(request.timeoutMs),
    })
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'network', detail: messageOf(error) } }
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status } }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'payload', detail: messageOf(error) } }
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, failure: { kind: 'payload', detail: 'not an object' } }
  }
  const raw = (payload as Record<string, unknown>)['balance_infos']
  if (!Array.isArray(raw)) {
    return { ok: false, failure: { kind: 'payload', detail: 'no balance_infos array' } }
  }
  const infos = raw.map(balanceInfo).filter((info): info is BalanceInfo => info !== undefined)
  const chosen = preferred(infos, request.currency)
  if (chosen === undefined) {
    return { ok: false, failure: { kind: 'payload', detail: 'no usable amount' } }
  }
  return {
    ok: true,
    balance: {
      total: chosen.totalBalance,
      currency: chosen.currency,
      available: (payload as Record<string, unknown>)['is_available'] !== false,
      at: Date.now(),
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
