// @vitest-environment jsdom
/**
 * The published prices this package prices the official routes with: the
 * snapshot it ships, the table the Host reads from the price page, and the
 * daily window each charge is billed in. They price the official provider's
 * routes until the user stores a row of their own, and they never touch any
 * other provider's route.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { makeTranslate, stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { BillingSettings, PriceSnapshot } from '../src/settings.ts'
import { DEFAULT_CURRENCY } from '../src/settings.ts'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { OFFICIAL_RATES, defaultRateOf, effectiveRates } from '../src/client/official-rates.ts'
import { SessionCostMeter } from '../src/client/CostMeter.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(en, zh)

/** Beijing 09:00 on Monday 2024-01-01, inside the published peak window. */
const PEAK_AT = Date.UTC(2024, 0, 1, 1, 0)

/** Beijing 12:00 the same Monday, the first off-peak minute after the morning peak. */
const OFF_PEAK_AT = Date.UTC(2024, 0, 1, 4, 0)

/** A table as the Host would store one, priced above the shipped snapshot. */
const PUBLISHED: PriceSnapshot = {
  models: {
    'deepseek-flash': {
      cacheHit: 0.08, cacheMiss: 4, output: 16,
      offPeak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
  },
  currency: 'CNY',
  at: PEAK_AT,
  source: 'https://example.test/pricing',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function snapshot(partial: Partial<SettingsScopeSnapshot<BillingSettings>> = {}): SettingsScopeSnapshot<BillingSettings> {
  return {
    status: 'ready',
    value: {
      currency: DEFAULT_CURRENCY,
      models: {},
      cache: null,
      cacheError: null,
      official: null,
      officialError: null,
      officialRequest: null,
    },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

/** The framework seats the renderer supplies, stubbed as in the component specs. */
function seats() {
  return {
    useSession: (() => undefined) as never,
    sessionId: 'session-1' as never,
    useConversation: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useChat: (() => undefined) as never,
    useTrajectory: (() => undefined) as never,
    useSessions: (() => [] as never) as never,
    useSessionPendingInteraction: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    usePanelInfo: (() => undefined) as never,
    useResource: (() => undefined) as never,
    close: (() => {}) as never,
  }
}

/** The plugin's injected face over one namespace stub. */
function billingFace(stub: StubSettingsScope<BillingSettings>) {
  return {
    useBilling: ((selector: (value: SettingsScopeSnapshot<BillingSettings>) => unknown) =>
      selector(stub.scope.getSnapshot())) as never,
    useBillingGroups: (() => []) as never,
    saveRate: vi.fn(async () => {}),
    clearRate: vi.fn(async () => {}),
    refreshPrices: vi.fn(async () => {}),
    routeGroups: async () => {},
  }
}

/** Render the session meter over one namespace value and one token total. */
function renderSession(value: Partial<BillingSettings>, usage: TokenUsageProjection, model: string): void {
  const stub = stubSettingsScope<BillingSettings>()
  stub.publish(snapshot({
    value: {
      currency: 'CNY',
      models: {},
      cache: null,
      cacheError: null,
      official: null,
      officialError: null,
      officialRequest: null,
      ...value,
    },
  }))
  render(
    <SessionCostMeter {...seats()}
      useProjection={((key: string) => key === 'tokenUsage'
        ? usage
        : { lastUsed: { provider: 'deepseek-official', model }, next: null })}
      {...billingFace(stub)}
      t={t} />,
  )
}

/** One million uncached prompt tokens on an official route. */
const ONE_MILLION_UNCACHED: TokenUsageProjection = {
  uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
}

describe('official rate defaults', () => {
  it('prices the official provider’s published routes in both windows', () => {
    expect(defaultRateOf('deepseek-official/deepseek-v4-flash')).toEqual({
      cacheHit: 0.04, cacheMiss: 2, output: 8,
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    })
    expect(defaultRateOf('deepseek-official/deepseek-v4-pro')).toEqual({
      cacheHit: 0.3, cacheMiss: 9, output: 27,
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    })
    expect(Object.keys(OFFICIAL_RATES).every(route => route.startsWith('deepseek-official/'))).toBe(true)
  })

  it('lets a stored row override a published price and leaves other providers alone', () => {
    const rates = effectiveRates({ 'deepseek-official/deepseek-v4-flash': { cacheHit: 9, cacheMiss: 9, output: 9 } })
    expect(rates['deepseek-official/deepseek-v4-flash']).toEqual({ cacheHit: 9, cacheMiss: 9, output: 9 })
    expect(rates['deepseek-official/deepseek-v4-pro']).toEqual(defaultRateOf('deepseek-official/deepseek-v4-pro'))
    expect(rates['bai/glm-5.3-flash']).toBeUndefined()
    expect(defaultRateOf('bai/glm-5.3-flash')).toBeUndefined()
  })

  it('puts the read table above the shipped snapshot and below a stored row', () => {
    const routes = [
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-flash-vision-exp',
    ]
    const rates = effectiveRates({}, PUBLISHED)
    for (const route of routes) expect(rates[route]).toEqual(PUBLISHED.models['deepseek-flash'])
    // A model the page does not list keeps the shipped snapshot.
    expect(rates['deepseek-official/deepseek-v4-pro']).toEqual(OFFICIAL_RATES['deepseek-official/deepseek-v4-pro'])
    // A stored row still wins over everything published.
    const stored = effectiveRates({ 'deepseek-official/deepseek-flash': { cacheHit: 1, cacheMiss: 1, output: 1 } }, PUBLISHED)
    expect(stored['deepseek-official/deepseek-flash']).toEqual({ cacheHit: 1, cacheMiss: 1, output: 1 })
    expect(defaultRateOf('deepseek-official/deepseek-flash', PUBLISHED)).toEqual(PUBLISHED.models['deepseek-flash'])
  })

  it('prices a session on an official route the document never priced', () => {
    vi.spyOn(Date, 'now').mockReturnValue(PEAK_AT)
    renderSession({}, ONE_MILLION_UNCACHED, 'deepseek-v4-flash')
    // 1M uncached input at the published peak 2 per million.
    expect(screen.getByText('¥2.00')).toBeDefined()
    fireEvent.click(screen.getByLabelText('¥2.00 this session'))
    expect(screen.getByText('deepseek-official/deepseek-v4-flash')).toBeDefined()
    expect(screen.getByText('peak')).toBeDefined()
  })

  it('charges the same session at the off-peak band outside the peak window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(OFF_PEAK_AT)
    renderSession({}, ONE_MILLION_UNCACHED, 'deepseek-v4-flash')
    expect(screen.getByText('¥1.00')).toBeDefined()
    fireEvent.click(screen.getByLabelText('¥1.00 this session'))
    expect(screen.getByText('off-peak')).toBeDefined()
  })

  it('charges a session from the read table rather than the shipped snapshot', () => {
    vi.spyOn(Date, 'now').mockReturnValue(PEAK_AT)
    renderSession({ official: PUBLISHED }, ONE_MILLION_UNCACHED, 'deepseek-flash')
    // The read table's peak cache-miss price is 4 per million.
    expect(screen.getByText('¥4.00')).toBeDefined()
  })
})
