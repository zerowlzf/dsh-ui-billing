/**
 * ui-billing pure folds: the cost arithmetic, the magnitude-adaptive money
 * format, the rate parser, and the provider-route discovery join. These are
 * the pieces the three surfaces share, so they are specified once here rather
 * than through each renderer.
 */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelRate, RouteUsage } from '../src/settings.ts'
import { bandAt, bandFor, parseRate, priceUsage, priceWindowAt, routeKey, splitRouteKey } from '../src/settings.ts'
import {
  bucketDelta, isEmptyBuckets, sessionCost, turnCost, turnRouteUsage,
  turnRoutes, type SessionBuckets, type TurnAttempt, type TurnBuckets, type TurnRouteUsage,
} from '../src/client/cost.ts'
import {
  ageOf, balanceFailureText, currencySymbol, formatAmount, formatBalance, priceFailureText, windowKey,
} from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import { modelIdsOf, providerRoutes, valueAtPath } from '../src/client/routes.ts'

/** One price at every hour: the row a provider publishing a single figure has. */
const FLAT: ModelRate = { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }

/** The same row with an off-peak band at half those figures. */
const BANDED: ModelRate = { ...FLAT, offPeak: { cacheHit: 0.075, cacheMiss: 2.25, output: 6.75 } }

/** Beijing 09:00 on Monday 2024-01-01, the first minute of the daily peak window. */
const PEAK_AT = Date.UTC(2024, 0, 1, 1, 0)

/** Beijing 12:00 the same Monday, the first off-peak minute after the morning peak. */
const OFF_PEAK_AT = Date.UTC(2024, 0, 1, 4, 0)

function buckets(partial: Partial<SessionBuckets> = {}): SessionBuckets {
  return {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...partial,
  }
}

describe('rate rows', () => {
  it('composes and splits one provider/model key', () => {
    expect(routeKey('bai', 'glm-5.3-flash')).toBe('bai/glm-5.3-flash')
    expect(splitRouteKey('bai/glm-5.3-flash')).toEqual({ provider: 'bai', model: 'glm-5.3-flash' })
  })

  it('refuses a key that names no model', () => {
    expect(splitRouteKey('bai')).toBeUndefined()
    expect(splitRouteKey('/model')).toBeUndefined()
    expect(splitRouteKey('provider/')).toBeUndefined()
  })
})

describe('priceUsage', () => {
  it('charges each bucket at its own rate per million tokens', () => {
    const usage: RouteUsage = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(priceUsage(FLAT, usage)).toBeCloseTo(0.15 + 4.5 + 13.5, 10)
  })

  it('prices an empty bucket set at zero', () => {
    expect(priceUsage(FLAT, { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 })).toBe(0)
  })
})

describe('price windows', () => {
  it('opens the peak window at Beijing 09:00 and closes it at 12:00', () => {
    expect(priceWindowAt(PEAK_AT)).toBe('peak')
    expect(priceWindowAt(PEAK_AT + 2 * 3_600_000)).toBe('peak')
    expect(priceWindowAt(PEAK_AT + 3 * 3_600_000 - 1)).toBe('peak')
    expect(priceWindowAt(OFF_PEAK_AT)).toBe('offPeak')
  })

  it('opens the afternoon peak at Beijing 14:00 and closes it at 18:00', () => {
    expect(priceWindowAt(Date.UTC(2024, 0, 1, 6, 0))).toBe('peak')
    expect(priceWindowAt(Date.UTC(2024, 0, 1, 9, 59))).toBe('peak')
    expect(priceWindowAt(Date.UTC(2024, 0, 1, 10, 0))).toBe('offPeak')
  })

  it('is off-peak all weekend, Beijing time', () => {
    // Saturday 2024-01-06 10:00 Beijing, an hour that is peak on a weekday.
    expect(priceWindowAt(Date.UTC(2024, 0, 6, 2, 0))).toBe('offPeak')
    // Sunday 2024-01-07 15:00 Beijing.
    expect(priceWindowAt(Date.UTC(2024, 0, 7, 7, 0))).toBe('offPeak')
    // The Friday before, at the same Beijing hour, is peak.
    expect(priceWindowAt(Date.UTC(2024, 0, 5, 2, 0))).toBe('peak')
  })

  it('reads the window in Beijing rather than in the viewer time zone', () => {
    // Beijing 09:00 on Monday is 01:00 UTC, which is still Sunday in the west.
    expect(priceWindowAt(Date.UTC(2024, 0, 1, 1, 0))).toBe('peak')
    expect(priceWindowAt(Date.UTC(2024, 0, 1, 0, 59))).toBe('offPeak')
  })

  it('selects the band a moment is charged at', () => {
    expect(bandAt(BANDED, PEAK_AT)).toEqual(FLAT)
    expect(bandAt(BANDED, OFF_PEAK_AT)).toEqual(BANDED.offPeak)
    expect(bandFor(BANDED, 'offPeak')).toEqual(BANDED.offPeak)
    expect(bandFor(BANDED, 'peak')).toEqual(FLAT)
  })

  it('charges a row with one price the same figure in either window', () => {
    expect(bandAt(FLAT, PEAK_AT)).toEqual(FLAT)
    expect(bandAt(FLAT, OFF_PEAK_AT)).toEqual(FLAT)
  })

  it('names each window through the dictionary', () => {
    expect(windowKey('peak')).toBe('window.peak')
    expect(windowKey('offPeak')).toBe('window.offPeak')
  })
})

describe('session accumulation', () => {
  it('reads each bucket delta and never negative', () => {
    const delta = bucketDelta(
      buckets({ uncachedInputTokens: 10, outputTokens: 5 }),
      buckets({ uncachedInputTokens: 3, cacheReadTokens: 7, outputTokens: 9 }),
    )
    expect(delta).toEqual({
      uncachedInputTokens: 0, cacheReadTokens: 7, cacheWriteTokens: 0, outputTokens: 4,
    })
  })

  it('reports an empty delta', () => {
    expect(isEmptyBuckets(buckets())).toBe(true)
    expect(isEmptyBuckets(buckets({ outputTokens: 1 }))).toBe(false)
  })

  it('prices each stretch under its own route and skips unpriced ones', () => {
    const total = sessionCost([
      {
        route: 'bai/glm-5.3-flash',
        at: PEAK_AT,
        buckets: buckets({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }),
      },
      { route: 'bai/unpriced', at: PEAK_AT, buckets: buckets({ outputTokens: 1_000_000 }) },
      { route: 'bai/glm-5.3-flash', at: PEAK_AT, buckets: buckets({ outputTokens: 1_000_000 }) },
    ], { 'bai/glm-5.3-flash': FLAT })
    expect(total).toBeCloseTo(4.5 + 13.5 + 13.5, 10)
  })

  it('charges cache writes as uncached input', () => {
    const total = sessionCost(
      [{ route: 'r', at: PEAK_AT, buckets: buckets({ cacheWriteTokens: 1_000_000 }) }],
      { r: FLAT },
    )
    expect(total).toBeCloseTo(4.5, 10)
  })

  it('charges each stretch at the band in force when it was observed', () => {
    const total = sessionCost([
      { route: 'r', at: PEAK_AT, buckets: buckets({ outputTokens: 1_000_000 }) },
      { route: 'r', at: OFF_PEAK_AT, buckets: buckets({ outputTokens: 1_000_000 }) },
      { route: 'flat', at: OFF_PEAK_AT, buckets: buckets({ outputTokens: 1_000_000 }) },
    ], { r: BANDED, flat: FLAT })
    expect(total).toBeCloseTo(13.5 + 6.75 + 13.5, 10)
  })
})

describe('turn splits', () => {
  const turnBuckets = (uncachedInputTokens: number, outputTokens: number): TurnBuckets => ({
    uncachedInputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
  const attempt = (route: string, buckets: TurnBuckets, at = PEAK_AT): TurnAttempt => ({ route, at, buckets })

  it('sums one turn’s attempts per route, in first-billed order', () => {
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      attempt('a/m', turnBuckets(10, 2)),
      attempt('b/m', turnBuckets(5, 1)),
      attempt('a/m', turnBuckets(15, 2)),
    ], { 'a/m': FLAT, 'b/m': FLAT }, PEAK_AT)
    expect(rows).toEqual([
      { route: 'a/m', window: 'peak', buckets: turnBuckets(25, 4) },
      { route: 'b/m', window: 'peak', buckets: turnBuckets(5, 1) },
    ])
  })

  it('gives one route one row per price window it was billed in', () => {
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      attempt('a/m', turnBuckets(10, 2), PEAK_AT),
      attempt('a/m', turnBuckets(20, 3), OFF_PEAK_AT),
    ], { 'a/m': BANDED }, PEAK_AT)
    expect(rows).toEqual([
      { route: 'a/m', window: 'peak', buckets: turnBuckets(10, 2) },
      { route: 'a/m', window: 'offPeak', buckets: turnBuckets(20, 3) },
    ])
    // The off-peak row is charged at the half-price band, the peak row in full.
    expect(turnCost(rows, { 'a/m': BANDED }).total).toBeCloseTo(
      (10 * 4.5 + 2 * 13.5) / 1_000_000 + (20 * 2.25 + 3 * 6.75) / 1_000_000,
      10,
    )
  })

  it('keeps one row for a route that publishes a single price', () => {
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      attempt('a/m', turnBuckets(10, 2), PEAK_AT),
      attempt('a/m', turnBuckets(20, 3), OFF_PEAK_AT),
    ], { 'a/m': FLAT }, PEAK_AT)
    expect(rows).toEqual([{ route: 'a/m', window: 'peak', buckets: turnBuckets(30, 5) }])
  })

  it('charges a retried attempt remainder at the last route', () => {
    const usage = {
      uncachedInputTokens: 50, outputTokens: 9, totalTokens: 59, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      attempt('a/m', turnBuckets(10, 2)),
      attempt('b/m', turnBuckets(20, 3)),
    ], { 'a/m': FLAT, 'b/m': FLAT }, PEAK_AT)
    expect(rows).toEqual([
      { route: 'a/m', window: 'peak', buckets: turnBuckets(10, 2) },
      { route: 'b/m', window: 'peak', buckets: turnBuckets(40, 7) },
    ])
  })

  it('has no rows without loaded attempts', () => {
    expect(turnRouteUsage({
      uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
    }, [], {}, PEAK_AT)).toEqual([])
  })

  it('prices an unattempted turn under its single named route', () => {
    // One named route is exact even with no surviving attempt: every billed
    // attempt ran there, and the turn's own close time places it in a window.
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35,
      routes: [{ provider: 'a', model: 'm' }],
    }
    expect(turnRouteUsage(usage, [], { 'a/m': BANDED }, PEAK_AT))
      .toEqual([{ route: 'a/m', window: 'peak', buckets: turnBuckets(30, 5) }])
    expect(turnRouteUsage(usage, [], { 'a/m': BANDED }, OFF_PEAK_AT))
      .toEqual([{ route: 'a/m', window: 'offPeak', buckets: turnBuckets(30, 5) }])
  })

  it('declines a turn whose several routes have no surviving attempt', () => {
    // Stating the aggregate under each route would charge the turn once per
    // route, so the fold returns nothing and the caller names what it could not
    // attribute.
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35,
      routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }],
    }
    const rates = { 'a/m': FLAT, 'b/n': FLAT }
    expect(turnRouteUsage(usage, [], rates, PEAK_AT)).toEqual([])
    expect(turnCost(turnRouteUsage(usage, [], rates, PEAK_AT), rates).total).toBe(0)
  })

  it('prices priced rows, reports unpriced routes, and counts each route once', () => {
    const rows: TurnRouteUsage[] = [
      { route: 'a/m', window: 'peak', buckets: turnBuckets(1_000_000, 1_000_000) },
      { route: 'x/m', window: 'peak', buckets: turnBuckets(5, 5) },
      { route: 'a/m', window: 'offPeak', buckets: turnBuckets(1_000_000, 0) },
      { route: 'x/m', window: 'offPeak', buckets: turnBuckets(5, 5) },
    ]
    const cost = turnCost(rows, { 'a/m': BANDED })
    expect(cost.total).toBeCloseTo(4.5 + 13.5 + 2.25, 10)
    // One route in two windows is one priced route and one unpriced route, each
    // named once however many rows it billed.
    expect(cost.priced).toEqual(['a/m'])
    expect(cost.unpriced).toEqual(['x/m'])
  })

  it('names the routes a turn billed as its own accounting declares them', () => {
    expect(turnRoutes({
      uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
      routes: [{ provider: 'a', model: 'm' }],
    })).toEqual(['a/m'])
    // A turn-tail that recorded no route at all names none, which is what the
    // dialog states instead of inventing an attribution.
    expect(turnRoutes({ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 })).toEqual([])
  })
})

describe('money format', () => {
  it('widens precision as the amount shrinks', () => {
    expect(formatAmount(0, 'CNY')).toBe('¥0.00')
    expect(formatAmount(0.0000042, 'CNY')).toBe('¥0.000004')
    expect(formatAmount(0.0042, 'CNY')).toBe('¥0.00420')
    expect(formatAmount(0.042, 'CNY')).toBe('¥0.0420')
    expect(formatAmount(0.42, 'CNY')).toBe('¥0.420')
    expect(formatAmount(4.2, 'CNY')).toBe('¥4.20')
    expect(formatAmount(42_000, 'CNY')).toBe('¥42000')
  })

  it('keeps two decimals on a balance and drops the sign it cannot render', () => {
    expect(formatBalance(12.345, 'CNY')).toBe('¥12.35')
    expect(formatBalance(0, 'USD')).toBe('$0.00')
    expect(formatBalance(0.004, 'EUR')).toBe('€0.0040')
    expect(formatAmount(Number.NaN, 'CNY')).toBe('-')
    expect(formatBalance(Number.POSITIVE_INFINITY, 'CNY')).toBe('-')
  })

  it('falls back to the yuan sign for an unknown currency code', () => {
    expect(currencySymbol('XYZ')).toBe('¥')
    expect(currencySymbol('USD')).toBe('$')
  })
})

describe('balance failure copy', () => {
  /** The Chinese surface's seat over the package dictionary. */
  const t = makeTranslate(zh, zh)

  it('states each structured reason in the surface language', () => {
    expect(balanceFailureText({ kind: 'noKey', ref: 'DEEPSEEK_API_KEY' }, t))
      .toBe('未找到 API key（DEEPSEEK_API_KEY），余额无法读取')
    expect(balanceFailureText({ kind: 'http', status: 401 }, t)).toBe('余额读取失败：HTTP 401')
    expect(balanceFailureText({ kind: 'network', detail: '' }, t)).toBe('余额读取失败：请求未能完成')
    expect(balanceFailureText({ kind: 'payload', detail: '' }, t)).toBe('余额读取失败：响应无法解析')
  })

  it('keeps the untranslatable detail on a second clause', () => {
    expect(balanceFailureText({ kind: 'network', detail: 'socket closed' }, t))
      .toBe('余额读取失败：请求未能完成 · 详情：socket closed')
    expect(balanceFailureText({ kind: 'payload', detail: 'no balance_infos array' }, t))
      .toBe('余额读取失败：响应无法解析 · 详情：no balance_infos array')
  })

  it('states each published-price reason in the surface language', () => {
    expect(priceFailureText({ kind: 'noWeb' }, t)).toBe('官方价格读取失败：此部署没有挂载网页读取能力')
    expect(priceFailureText({ kind: 'http', status: 502 }, t)).toBe('官方价格读取失败：HTTP 502')
    expect(priceFailureText({ kind: 'network', detail: '' }, t)).toBe('官方价格读取失败：请求未能完成')
    expect(priceFailureText({ kind: 'payload', detail: 'no price table on the page' }, t))
      .toBe('官方价格读取失败：页面里没有可用的价格表 · 详情：no price table on the page')
    expect(priceFailureText({ kind: 'currency', found: 'USD', expected: 'CNY' }, t))
      .toBe('官方价格页面按 USD 计价，与当前币种 CNY 不一致，未采用')
  })
})

describe('age buckets', () => {
  const now = 1_000_000_000

  it('buckets each range', () => {
    expect(ageOf(now, now)).toEqual({ kind: 'justNow' })
    expect(ageOf(now - 90_000, now)).toEqual({ kind: 'minutes', count: 1 })
    expect(ageOf(now - 3 * 3_600_000, now)).toEqual({ kind: 'hours', count: 3 })
    expect(ageOf(now - 2 * 86_400_000, now)).toEqual({ kind: 'days', count: 2 })
  })

  it('reads a future timestamp as just now rather than a negative age', () => {
    expect(ageOf(now + 5_000, now)).toEqual({ kind: 'justNow' })
  })
})

describe('rate parsing', () => {
  it('accepts a non-negative number and blanks', () => {
    expect(parseRate(' 4.5 ')).toBe(4.5)
    expect(parseRate('')).toBe(0)
    expect(parseRate('0')).toBe(0)
  })

  it('rejects text and negative numbers', () => {
    expect(parseRate('four')).toBeUndefined()
    expect(parseRate('-1')).toBeUndefined()
  })
})

describe('provider route discovery', () => {
  it('reads model ids out of a provider profile', () => {
    expect(modelIdsOf({ models: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { name: 'no id' }] })).toEqual(['a', 'b'])
    expect(modelIdsOf({ models: 'none' })).toEqual([])
    expect(modelIdsOf(null)).toEqual([])
    // An entry that is not a profile object declares no model, so it is skipped
    // rather than read as one.
    expect(modelIdsOf({ models: [null, 'glm-5.3-flash', { id: 'a' }] })).toEqual(['a'])
  })

  it('walks a settings path', () => {
    expect(valueAtPath({ providers: { bai: { models: [] } } }, ['providers', 'bai'])).toEqual({ models: [] })
    expect(valueAtPath({ providers: {} }, ['providers', 'bai'])).toBeUndefined()
    expect(valueAtPath(undefined, ['providers'])).toBeUndefined()
  })

  it('joins the directory with the profiles their settings hold', () => {
    const groups = providerRoutes(
      [
        { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
        { provider: 'x', displayName: 'X', settingsNs: 'llm-x', settingsPath: [] },
      ],
      [{ id: 'live-only', name: 'Live only' }],
      [
        { ns: 'llm-pi-ai', value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } } },
        { ns: 'deepseek-official', value: {} },
      ],
    )
    expect(groups).toEqual([
      {
        provider: 'bai',
        displayName: 'BAI',
        models: ['glm-5.3-flash'],
        modelsReadable: true,
        official: false,
        configured: true,
      },
      { provider: 'x', displayName: 'X', models: [], modelsReadable: false, official: false, configured: false },
      {
        provider: 'live-only',
        displayName: 'Live only',
        models: [],
        modelsReadable: false,
        official: false,
        configured: true,
      },
    ])
  })

  it('leaves a catalogue provider the user never configured out of the priced set', () => {
    const [catalogue, configured] = providerRoutes(
      [
        { provider: 'zai', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
        { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
      ],
      [],
      [{
        ns: 'llm-pi-ai',
        value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } },
        user: { providers: { bai: { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }] } } },
      }],
    )
    expect(catalogue?.configured).toBe(false)
    expect(configured?.configured).toBe(true)
  })

  it('marks the official DeepSeek route by provider id or settings namespace', () => {
    expect(providerRoutes(
      [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }],
      [],
      [],
    )[0]?.official).toBe(true)
    expect(providerRoutes(
      [{ provider: 'renamed', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }],
      [],
      [],
    )[0]?.official).toBe(true)
  })
})
