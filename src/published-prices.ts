/**
 * The provider's published price page: one read, and the table it carries.
 *
 * DeepSeek publishes no price endpoint — its API serves completions, files, a
 * model list of ids, and the account balance, and nothing that answers what a
 * token costs — so the only machine-readable statement of the prices is the
 * table on the documentation page. This module reads that page through the
 * Host's own web capability and turns its table into rates; anything it cannot
 * recognise produces a structured failure and leaves the shipped snapshot in
 * charge, so a redesigned page costs an outdated default rather than a wrong
 * bill.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/published-prices
 */

import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import type { PriceWindow, ModelRate, PriceFailure, RateBand } from './settings.ts'

/** Published price page in the currency this package prices in by default. */
export const DEFAULT_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/**
 * Retrieve one page.
 *
 * The plugin body owns this because the Host's web capability is a service it
 * resolves from its own context; a read only needs the page. The capability
 * throws its own structured error when no provider is usable and answers a
 * non-2xx response descriptively, which is why this seam returns the result
 * rather than a status alone.
 */
export type PageFetcher = (url: string, signal: AbortSignal) => Promise<WebFetchResult>

/** The rates one page stated, and the currency it stated them in. */
export interface PublishedPrices {
  /** Model id → both windows, as the page lists them. */
  readonly models: Record<string, ModelRate>
  /** Currency the figures were stated in. */
  readonly currency: string
}

/** Everything one read needs. */
export interface PriceReadRequest {
  /** Page to read. */
  readonly url: string
  /** Currency the rates are stored and displayed in; a page stating another is refused. */
  readonly currency: string
  /** Whole-request deadline in milliseconds. */
  readonly timeoutMs: number
}

/** Result of one price read. */
export type PriceRead =
  | { readonly ok: true; readonly prices: PublishedPrices }
  | { readonly ok: false; readonly failure: PriceFailure }

/** One cell's text: markup dropped, entities decoded, whitespace collapsed. */
function cellText(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** The rows of one table, each row the text of its cells. */
function tableRows(table: string): string[][] {
  return (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [])
    .map(row => (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText))
}

/** Drop the footnote marker a published label or model id carries. */
function withoutFootnote(text: string): string {
  return text.replace(/[(（]\d+[)）]$/, '').trim()
}

/** Whether one header cell names a model rather than a column heading. */
function isModelId(text: string): boolean {
  return /^[a-z][a-z0-9._-]*$/.test(text)
}

/** One billed bucket a price row states. */
type Bucket = 'cacheHit' | 'cacheMiss' | 'output'

/** Which billed bucket a row labels, or undefined for a row that labels none. */
function bucketOf(label: string): Bucket | undefined {
  const text = label.toUpperCase()
  if (text.includes('未命中') || text.includes('CACHE MISS')) return 'cacheMiss'
  if (text.includes('命中') || text.includes('CACHE HIT')) return 'cacheHit'
  if (text.includes('输出') || text.includes('OUTPUT')) return 'output'
  return undefined
}

/** Which price window a row labels, or undefined for a row that labels none. */
function windowOf(label: string): PriceWindow | undefined {
  const text = label.toUpperCase().replace(/[\s-]/g, '')
  if (text.includes('空闲') || text.includes('OFFPEAK')) return 'offPeak'
  if (text.includes('高峰') || text.includes('PEAK')) return 'peak'
  return undefined
}

/** One published figure: its amount and the currency its page stated it in. */
interface Figure {
  readonly amount: number
  readonly currency: string
}

const CURRENCY_MARKS: readonly (readonly [string, string])[] = [
  ['元', 'CNY'],
  ['CNY', 'CNY'],
  ['$', 'USD'],
  ['USD', 'USD'],
]

/** Read one cell as a published figure, or undefined when it states no amount and unit. */
function figureOf(text: string): Figure | undefined {
  const amount = /(\d+(?:\.\d+)?)/.exec(text)
  if (amount === null) return undefined
  const value = Number(amount[1])
  if (!Number.isFinite(value)) return undefined
  const upper = text.toUpperCase()
  for (const [mark, currency] of CURRENCY_MARKS) {
    if (upper.includes(mark.toUpperCase())) return { amount: value, currency }
  }
  return undefined
}

/** The model columns one table's header row names. */
function modelsOf(rows: readonly string[][]): string[] {
  for (const cells of rows) {
    const heading = cells.findIndex(cell => /^(模型|MODEL)$/i.test(cell))
    if (heading < 0) continue
    const models = cells.slice(heading + 1).map(withoutFootnote).filter(isModelId)
    if (models.length > 0) return models
  }
  return []
}

/**
 * Read the price table out of one rendered documentation page.
 *
 * The table states each model in its own column and each window in its own row
 * pair, with the row that opens a bucket carrying its label and the row beside
 * it carrying only the other window: a row is therefore read by its leading
 * label, whichever of the two labels it is. Every bucket of every model must be
 * present for a window to be usable, and all figures must state one currency,
 * so a page that changed its layout yields nothing rather than half a table.
 * @param html - the page's markup.
 * @returns the published rates and their currency, or undefined when the page carries no usable table.
 */
export function parsePricePage(html: string): PublishedPrices | undefined {
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const parsed = parsePriceTable(tableRows(table))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** One labeled fact a row carries: the value a cell states and the column it sits in. */
interface Labelled<T> {
  readonly value: T
  readonly at: number
}

/**
 * The first label at or after `from` that one reader recognizes.
 * @param cells - one row's cell texts.
 * @param read - reads one cell as the label being looked for.
 * @param from - first column to consider.
 * @returns the label with its column, or undefined when no cell states one.
 */
function labelledAt<T>(
  cells: readonly string[],
  read: (cell: string) => T | undefined,
  from: number,
): Labelled<T> | undefined {
  for (const [at, cell] of cells.entries()) {
    if (at < from) continue
    const value = read(cell)
    if (value !== undefined) return { value, at }
  }
  return undefined
}

/**
 * Read one table's rows into published rates.
 *
 * The price block states its bucket in the row that opens it and its window in
 * the row that follows, so a row is read by whichever of the two labels it
 * carries, in either of the two leading cells; every other row of the table is
 * skipped because it labels neither.
 */
function parsePriceTable(rows: readonly string[][]): PublishedPrices | undefined {
  const models = modelsOf(rows)
  if (models.length === 0) return undefined
  const collected = new Map<string, Figure>()
  let bucket: Bucket | undefined
  for (const cells of rows) {
    const opened = labelledAt(cells, bucketOf, 0)
    if (opened !== undefined) bucket = opened.value
    const labelled = labelledAt(cells, windowOf, opened === undefined ? 0 : opened.at + 1)
    // A window label on its own states no bucket, and a row that states no
    // window is not a price row of this table.
    if (labelled === undefined || bucket === undefined) continue
    const values = cells.slice(labelled.at + 1)
    if (values.length !== models.length) continue
    values.forEach((text, index) => {
      const figure = figureOf(text)
      const model = models[index]
      if (figure === undefined || model === undefined) return
      collected.set(`${model}\u0000${labelled.value}\u0000${bucket}`, figure)
    })
  }

  const currency = [...collected.values()][0]?.currency
  if (currency === undefined) return undefined
  if ([...collected.values()].some(figure => figure.currency !== currency)) return undefined

  const rates: Record<string, ModelRate> = {}
  for (const model of models) {
    const peak = bandOf(collected, model, 'peak')
    const offPeak = bandOf(collected, model, 'offPeak')
    if (peak === undefined || offPeak === undefined) continue
    rates[model] = { ...peak, offPeak }
  }
  return Object.keys(rates).length === 0 ? undefined : { models: rates, currency }
}

/** One model's complete band for one window, or undefined when any bucket is missing. */
function bandOf(collected: ReadonlyMap<string, Figure>, model: string, window: PriceWindow): RateBand | undefined {
  const read = (bucket: Bucket): number | undefined =>
    collected.get(`${model}\u0000${window}\u0000${bucket}`)?.amount
  const cacheHit = read('cacheHit')
  const cacheMiss = read('cacheMiss')
  const output = read('output')
  if (cacheHit === undefined || cacheMiss === undefined || output === undefined) return undefined
  return { cacheHit, cacheMiss, output }
}

/**
 * Read one published price page.
 * @param request - page, expected currency, and deadline.
 * @param fetchPage - retrieves the page, or undefined when the deployment mounts no web capability.
 * @returns the published rates or the structured reason none were read.
 */
export async function readPrices(
  request: PriceReadRequest,
  fetchPage: PageFetcher | undefined,
): Promise<PriceRead> {
  if (fetchPage === undefined) return { ok: false, failure: { kind: 'noWeb' } }
  let page: WebFetchResult
  try {
    page = await fetchPage(request.url, AbortSignal.timeout(request.timeoutMs))
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'network', detail: messageOf(error) } }
  }
  if (page.statusCode !== 200) {
    return { ok: false, failure: { kind: 'http', status: page.statusCode } }
  }
  // A body the capability capped can hold a table with its price rows cut off,
  // which reads as a page that published none of them.
  if (page.truncated) {
    return { ok: false, failure: { kind: 'payload', detail: 'the page was truncated' } }
  }
  const prices = parsePricePage(page.body.content)
  if (prices === undefined) {
    return { ok: false, failure: { kind: 'payload', detail: 'no price table on the page' } }
  }
  if (prices.currency !== request.currency) {
    return { ok: false, failure: { kind: 'currency', found: prices.currency, expected: request.currency } }
  }
  return { ok: true, prices }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
