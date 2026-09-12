/**
 * ui-billing published-price read: the table parser over the recorded pages and
 * the answer each way of failing a read produces. The fixtures are the real
 * tables the documentation pages serve, so the parser is specified against the
 * markup it will actually meet rather than an approximation of it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { DEFAULT_PRICING_URL, parsePricePage, readPrices } from '../src/published-prices.ts'
import { PRICING_EN_HTML, PRICING_ZH_HTML } from './price-page-fixture.ts'

describe('parsePricePage', () => {
  it('reads both windows of every model off the Chinese page', () => {
    const prices = parsePricePage(PRICING_ZH_HTML)
    expect(prices?.currency).toBe('CNY')
    // Exactly the two model columns, and no concurrency figure read as a price.
    expect(prices?.models).toEqual({
      'deepseek-flash': {
        cacheHit: 0.04, cacheMiss: 2, output: 8,
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      },
      'deepseek-v4-pro': {
        cacheHit: 0.3, cacheMiss: 9, output: 27,
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      },
    })
  })

  it('reads the English edition in its own currency', () => {
    const prices = parsePricePage(PRICING_EN_HTML)
    expect(prices?.currency).toBe('USD')
    expect(prices?.models['deepseek-flash']).toEqual({
      cacheHit: 0.006, cacheMiss: 0.3, output: 1.2,
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    })
    expect(prices?.models['deepseek-v4-pro']).toEqual({
      cacheHit: 0.044, cacheMiss: 1.32, output: 3.96,
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    })
  })

  it('takes the price table from a page that carries other tables too', () => {
    const prices = parsePricePage(`<table><tr><td>模型</td><td>1M</td></tr></table>${PRICING_ZH_HTML}`)
    expect(Object.keys(prices?.models ?? {})).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('refuses a page whose table names no model', () => {
    expect(parsePricePage('<p>no table at all</p>')).toBeUndefined()
    expect(parsePricePage('<table><tr><td>模型</td><td>1M</td></tr></table>')).toBeUndefined()
  })

  it('refuses a table that published only one window', () => {
    // A page that stopped publishing off-peak rows cannot be priced for the
    // hours those rows cover, so the whole read yields nothing rather than a
    // table missing half its bands.
    const peakOnly = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>高峰时段</td><td>0.04元</td></tr>',
      '<tr><td>百万tokens输入（缓存未命中）</td><td>高峰时段</td><td>2元</td></tr>',
      '<tr><td>百万tokens输出</td><td>高峰时段</td><td>8元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(peakOnly)).toBeUndefined()
  })

  it('refuses a table whose figures state two currencies', () => {
    const mixed = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02元</td></tr>',
      '<tr><td>高峰时段</td><td>$0.04</td></tr>',
      '<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td></tr>',
      '<tr><td>高峰时段</td><td>2元</td></tr>',
      '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>',
      '<tr><td>高峰时段</td><td>8元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(mixed)).toBeUndefined()
  })

  it('refuses a value that states no unit', () => {
    const unitless = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02</td></tr>',
      '<tr><td>高峰时段</td><td>0.04</td></tr>',
      '<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td></tr>',
      '<tr><td>高峰时段</td><td>2元</td></tr>',
      '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>',
      '<tr><td>高峰时段</td><td>8元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(unitless)).toBeUndefined()
  })

  it('refuses a table that carries no row', () => {
    expect(parsePricePage('<table><caption>价格</caption></table>')).toBeUndefined()
  })

  it('refuses a table that names a model but prices none of them', () => {
    // The empty row states nothing and the header row states no figure, so the
    // table yields nothing rather than a row of zeroes.
    const unpriced = '<table><tr></tr><tr><td>模型</td><td>deepseek-flash</td></tr></table>'
    expect(parsePricePage(unpriced)).toBeUndefined()
  })

  it('refuses a window label that opens no bucket', () => {
    // A price row that names its window before any row named a bucket states no
    // price of this table.
    const orphanWindow = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>高峰时段</td><td>0.04元</td></tr>',
      '<tr><td>高峰时段</td><td>2元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(orphanWindow)).toBeUndefined()
  })

  it('refuses a row whose figures do not line up with the model columns', () => {
    // A price row states one figure per model column; a row stating another
    // number of them belongs to a table this parser cannot read.
    const misaligned = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02元</td></tr>',
      '<tr><td>高峰时段</td><td>0.04元</td></tr>',
      '<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>2元</td></tr>',
      '<tr><td>高峰时段</td><td>2元</td></tr>',
      '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>',
      '<tr><td>高峰时段</td><td>8元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(misaligned)).toBeUndefined()
  })

  it('refuses a cell that states no amount and one that states an impossible one', () => {
    // Both are cells a redesigned page can carry: a dash where a figure should
    // be, and a digit run long enough to read as infinity.
    const impossible = '9'.repeat(400)
    const broken = [
      '<table>',
      '<tr><td>模型</td><td>deepseek-flash</td></tr>',
      '<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>—</td></tr>',
      '<tr><td>高峰时段</td><td>—</td></tr>',
      `<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>${impossible}元</td></tr>`,
      '<tr><td>高峰时段</td><td>2元</td></tr>',
      '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>',
      '<tr><td>高峰时段</td><td>8元</td></tr>',
      '</table>',
    ].join('')
    expect(parsePricePage(broken)).toBeUndefined()
  })
})

describe('readPrices', () => {
  const request = { url: DEFAULT_PRICING_URL, currency: 'CNY', timeoutMs: 1_000 }

  /** One page as the Host's retrieval path hands it back. */
  function page(options: { content?: string; statusCode?: number; truncated?: boolean } = {}): WebFetchResult {
    return {
      url: DEFAULT_PRICING_URL,
      statusCode: options.statusCode ?? 200,
      body: { kind: 'html', content: options.content ?? PRICING_ZH_HTML },
      truncated: options.truncated ?? false,
    }
  }

  it('reports that no retrieval path was mounted', async () => {
    // A deployment that mounts no web capability still owns the namespace; the
    // price read says what it lacked rather than reporting a transport failure.
    const result = await readPrices(request, undefined)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'noWeb' })
  })

  it('reads the published table through the retrieval path it is given', async () => {
    const fetchPage = vi.fn((_url: string, _signal: AbortSignal): Promise<WebFetchResult> => Promise.resolve(page()))
    const result = await readPrices(request, fetchPage)
    expect(fetchPage.mock.calls[0]?.[0]).toBe(DEFAULT_PRICING_URL)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.prices.currency : undefined).toBe('CNY')
    expect(result.ok ? result.prices.models['deepseek-flash']?.offPeak : undefined)
      .toEqual({ cacheHit: 0.02, cacheMiss: 1, output: 4 })
  })

  it('refuses an edition priced in another currency', async () => {
    const result = await readPrices(request, () => Promise.resolve(page({ content: PRICING_EN_HTML })))
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'currency', found: 'USD', expected: 'CNY' })
  })

  it('reports a status instead of a table', async () => {
    const result = await readPrices(request, () => Promise.resolve(page({ statusCode: 404 })))
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'http', status: 404 })
  })

  it('reports a request that never completed', async () => {
    const result = await readPrices(request, () => Promise.reject(new Error('offline')))
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'offline' })
  })

  it('reports a non-Error rejection verbatim', async () => {
    const result = await readPrices(request, () => { throw 'closed' })
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'closed' })
  })

  it('reports a page it could not read as a table', async () => {
    const result = await readPrices(request, () => Promise.resolve(page({ content: '<html>redesigned</html>' })))
    expect(result.ok ? undefined : result.failure)
      .toEqual({ kind: 'payload', detail: 'no price table on the page' })
  })

  it('refuses a body the retrieval path capped', async () => {
    // A capped body can hold a table whose price rows were cut off, which reads
    // as a page that published none of them.
    const result = await readPrices(request, () => Promise.resolve(page({ truncated: true })))
    expect(result.ok ? undefined : result.failure)
      .toEqual({ kind: 'payload', detail: 'the page was truncated' })
  })
})
