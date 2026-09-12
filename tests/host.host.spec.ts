/**
 * ui-billing Host half: the namespace registration and the two refresh chains.
 * The settings provider is a real in-memory subclass of the seam, the credential
 * store is the credentials package's own in-memory provider, and the web
 * capability is the real service Definition with one stub retrieval provider, so
 * what is asserted here is this package's own contract — the namespace it
 * registers under, what a settled read writes back, that a failed read keeps the
 * previous value, that activation waits for the store, and that disposal stops
 * the chains.
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { DEFAULT_BASE_URL, readBalance } from '../src/account.ts'
import { Config } from '../src/index.ts'
import { apply, inject } from '../src/index.ts'
import { DEFAULT_PRICING_URL } from '../src/published-prices.ts'
import { DEFAULT_CURRENCY, NS } from '../src/settings.ts'
import { PRICING_EN_HTML, PRICING_ZH_HTML } from './price-page-fixture.ts'

/**
 * In-memory settings provider: the smallest real subclass of the Service
 * Definition, standing in for the file-backed provider a deployment mounts.
 */
class MemorySettings extends SettingsProvider {
  /** Raw document the provider's storage currently holds. */
  doc: Record<string, unknown>
  /** Every persist() call observed, in order. */
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  private readonly writableFlag: boolean

  constructor(
    ctx: ConstructorParameters<typeof SettingsProvider>[0],
    options: { doc?: Record<string, unknown>; writable?: boolean } = {},
  ) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
    this.writableFlag = options.writable ?? true
  }

  get writable(): boolean {
    return this.writableFlag
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Key resolution as the plugin performs it, over the environment alone here. */
const fromEnv = (): Promise<string | undefined> => Promise.resolve(process.env['BILLING_TEST_KEY'])

/** The balance the stubbed account endpoint answers with. */
const BALANCE_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Resolve one cached read out of the provider's stored document. */
function storedCache(settings: MemorySettings): unknown {
  const section = settings.doc[NS] as Record<string, unknown> | undefined
  return section?.['cache']
}

/** Resolve the stored published table out of the provider's document. */
function storedOfficial(settings: MemorySettings): unknown {
  const section = settings.doc[NS] as Record<string, unknown> | undefined
  return section?.['official']
}

/** One published page, defaulting to the table the recorded live page serves. */
function pageOf(options: { content?: string; statusCode?: number; truncated?: boolean } = {}): WebFetchResult {
  return {
    url: DEFAULT_PRICING_URL,
    statusCode: options.statusCode ?? 200,
    body: { kind: 'html', content: options.content ?? PRICING_ZH_HTML },
    truncated: options.truncated ?? false,
  }
}

/** What one test's two reads answer, and whether the deployment has a web capability at all. */
interface Answers {
  /** Account endpoint answer; defaults to a funded account. */
  balance?: () => Promise<Response>
  /** Published page answer; defaults to the recorded Chinese table. */
  prices?: () => Promise<WebFetchResult>
  /** Mount no web capability, as a deployment that mounts none. */
  web?: boolean
}

/**
 * Answer both Host reads, each through the path its read uses: the account
 * endpoint through the global fetch this package's own request goes out on, the
 * published page through the web capability's registered provider.
 * @param answers - per-read overrides; each defaults to a successful answer.
 * @returns both stubs, so a test can assert what each was asked for.
 */
function stubReads(answers: Answers = {}) {
  // The second parameter keeps the stub's call records shaped like the real
  // fetch signature, so the balance assertion can read the request headers.
  const fetchImpl = vi.fn((url: string, _init?: RequestInit): Promise<Response> => {
    if (!url.includes('/user/balance')) {
      // The published page is read through `ctx.web`; a request here would mean
      // this package still retrieves the page itself.
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }
    return answers.balance?.() ?? Promise.resolve(Response.json(BALANCE_BODY))
  })
  vi.stubGlobal('fetch', fetchImpl)
  const page = vi.fn((_request: WebFetchRequest, _signal?: AbortSignal): Promise<WebFetchResult> =>
    answers.prices?.() ?? Promise.resolve(pageOf()))
  return { fetchImpl, page }
}

/** Mount the web capability with one provider standing in for the deployment's retrieval backend. */
function mountWeb(ctx: Context, fetchPage: WebFetchProvider['fetch']): void {
  new WebRuntime(ctx).registerFetchProvider({ id: 'stub-fetch', available: () => true, fetch: fetchPage })
}

/**
 * Mount the in-memory settings provider the way a deployment mounts its own:
 * through the Loader, so its document is loaded before any dependent activates.
 * @param ctx - the context to register the provider into.
 * @param options - the document it starts from, and whether writes are accepted.
 * @returns the provider holding the writes.
 */
async function mountSettings(
  ctx: Context,
  options: { doc?: Record<string, unknown>; writable?: boolean } = {},
): Promise<MemorySettings> {
  await ctx.plugin(MemorySettings, options)
  const provider = ctx.get('settings') as MemorySettings | undefined
  if (provider === undefined) throw new Error('the settings provider did not register')
  return provider
}

/** Values the Loader resolves from the plugin's own `Config` schema. */
const RESOLVED_CONFIG = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: DEFAULT_BASE_URL,
  currency: DEFAULT_CURRENCY,
  refreshIntervalMs: 0,
  pricingUrl: DEFAULT_PRICING_URL,
  pricingRefreshIntervalMs: 0,
  requestTimeoutMs: 15_000,
} satisfies Config

/**
 * Mount the Host half over the in-memory provider, beside the web capability a
 * deployment mounts.
 * @param config - plugin configuration overrides.
 * @param answers - what each read answers, and whether a web capability exists.
 * @param stored - the settings document the provider starts from.
 * @returns the context, the provider holding the writes, both read stubs, and the plugin fiber.
 */
async function mount(
  config: Partial<Config> = {},
  answers: Answers = {},
  stored: Record<string, unknown> = {},
): Promise<{
  ctx: Context
  settings: MemorySettings
  fiber: { dispose: () => Promise<void> }
  fetchImpl: ReturnType<typeof stubReads>['fetchImpl']
  page: ReturnType<typeof stubReads>['page']
}> {
  const ctx = new Context()
  // The real timer service mixes `timeout` onto the context, which is the API
  // the plugin's refresh chain re-arms through.
  await ctx.plugin(Timer)
  const settings = await mountSettings(ctx, { doc: stored })
  new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
  const { fetchImpl, page } = stubReads(answers)
  if (answers.web !== false) mountWeb(ctx, page)
  const fiber = ctx.plugin({ inject, apply }, { ...RESOLVED_CONFIG, ...config })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return { ctx, settings, fiber, fetchImpl, page }
}

describe('configuration', () => {
  it('defaults every key the plugin reads', () => {
    // The empty object is what a deployment that sets nothing resolves from;
    // the schema fills every key, which is the fact under test.
    const resolved = new Schema(Config)({} as never)
    expect(resolved).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: DEFAULT_BASE_URL,
      currency: DEFAULT_CURRENCY,
      refreshIntervalMs: 300_000,
      pricingUrl: DEFAULT_PRICING_URL,
      pricingRefreshIntervalMs: 15 * 86_400_000,
      requestTimeoutMs: 15_000,
    })
  })
})

describe('namespace ownership', () => {
  it('registers the ui-billing namespace and caches both reads', async () => {
    const { ctx, settings, fetchImpl, page } = await mount()

    expect(ctx.settings.describe({ redactSecrets: true }).map(view => view.ns)).toContain(NS)
    // The balance is this package's own request; the page goes through the web
    // capability, so no page request appears on the global fetch.
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([`${DEFAULT_BASE_URL}/user/balance`])
    expect(page.mock.calls.map(call => call[0])).toEqual([{ url: DEFAULT_PRICING_URL }])
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer key-under-test' })
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34, currency: 'CNY' }) })
    await vi.waitFor(() => {
      expect(storedOfficial(settings)).toMatchObject({
        currency: 'CNY',
        source: DEFAULT_PRICING_URL,
        models: {
          'deepseek-flash': {
            cacheHit: 0.04, cacheMiss: 2, output: 8,
            offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
          },
        },
      })
    })
    expect(settings.doc[NS]).toMatchObject({ cacheError: null, officialError: null })
  })

  it('waits for the credential store before its first read', async () => {
    const { fetchImpl, page } = stubReads()
    const ctx = new Context()
    await ctx.plugin(Timer)
    const settings = await mountSettings(ctx)
    mountWeb(ctx, page)
    const fiber = ctx.plugin({ inject, apply }, RESOLVED_CONFIG)
    cleanups.push(async () => { await fiber.dispose() })
    // The mount is pending on the missing service, so no read has run yet.
    expect(fetchImpl).not.toHaveBeenCalled()
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34 }) })
  })

  it('records the reason and keeps the previous snapshot when a read fails', async () => {
    const { settings } = await mount({}, { balance: () => Promise.resolve(new Response('nope', { status: 401 })) })
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ cacheError: { kind: 'http', status: 401 } })
    })
    expect(settings.doc[NS]).not.toHaveProperty('cache')
  })

  it('records why a price read produced no table and keeps the routes on the shipped snapshot', async () => {
    const { settings } = await mount({}, { prices: () => Promise.resolve(pageOf({ statusCode: 500 })) })
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ officialError: { kind: 'http', status: 500 } })
    })
    expect(settings.doc[NS]).not.toHaveProperty('official')
  })

  it('records that no page could be read when the deployment mounts no web capability', async () => {
    const { settings } = await mount({}, { web: false })
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ officialError: { kind: 'noWeb' } })
    })
    // The balance read is this package's own request, so mounting no web
    // capability leaves it untouched.
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34 }) })
    expect(settings.doc[NS]).not.toHaveProperty('official')
  })

  it('refuses a price page stated in another currency', async () => {
    const { settings } = await mount({}, { prices: () => Promise.resolve(pageOf({ content: PRICING_EN_HTML })) })
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({
        officialError: { kind: 'currency', found: 'USD', expected: 'CNY' },
      })
    })
    expect(settings.doc[NS]).not.toHaveProperty('official')
  })

  it('keeps a previously read balance across a failed refresh', async () => {
    vi.useFakeTimers()
    const { settings, fetchImpl } = await mount({ refreshIntervalMs: 500 })
    await vi.waitFor(() => { expect(storedCache(settings)).not.toBeUndefined() })

    // The next tick fails; the settled amount stays and the reason is recorded.
    fetchImpl.mockImplementation(() => Promise.reject(new Error('offline')))
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ cacheError: { kind: 'network', detail: 'offline' } })
    })
    expect(storedCache(settings)).toMatchObject({ total: 12.34 })
    vi.useRealTimers()
  })

  it('re-arms the refresh chain after each settlement when an interval is configured', async () => {
    const { page } = stubReads()
    const ctx = new Context()
    await ctx.plugin(Timer)
    await mountSettings(ctx)
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    mountWeb(ctx, page)
    // The chain arms through the timer service's own `timeout`, whose
    // fiber-owned effect belongs to that service.
    const timeout = vi.spyOn(ctx.timer, 'timeout')
    // The spy answers whichever overload was called; the callback form is the
    // one this chain arms, so the callback-and-delay pair is what is asserted.
    const fiber = ctx.plugin({ inject, apply }, { ...RESOLVED_CONFIG, refreshIntervalMs: 1_000 })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    await vi.waitFor(() => { expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000) })
  })

  it('re-arms the price chain on its own interval', async () => {
    const { page } = stubReads()
    const ctx = new Context()
    await ctx.plugin(Timer)
    await mountSettings(ctx)
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    mountWeb(ctx, page)
    const timeout = vi.spyOn(ctx.timer, 'timeout')
    const fiber = ctx.plugin({ inject, apply }, { ...RESOLVED_CONFIG, pricingRefreshIntervalMs: 86_400_000 })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    await vi.waitFor(() => { expect(timeout).toHaveBeenCalledWith(expect.any(Function), 86_400_000) })
  })

  it('stops the chains on disposal', async () => {
    const { settings, fiber, fetchImpl, page } = await mount()
    await vi.waitFor(() => { expect(storedCache(settings)).not.toBeUndefined() })
    await fiber.dispose()
    const balances = fetchImpl.mock.calls.length
    const pages = page.mock.calls.length
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(fetchImpl.mock.calls).toHaveLength(balances)
    expect(page.mock.calls).toHaveLength(pages)
  })

  it('keeps a refused write from breaking the chain', async () => {
    const warn = vi.fn()
    const { page } = stubReads()
    const ctx = new Context()
    await ctx.plugin(Timer)
    const readOnly = await mountSettings(ctx, { writable: false })
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    mountWeb(ctx, page)
    ctx.logger.warn = warn as never
    const fiber = ctx.plugin({ inject, apply }, RESOLVED_CONFIG)
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(warn.mock.calls[0]?.[0]).toBe('ui-billing: settings write failed')
    expect(readOnly.persisted).toEqual([])
  })

  it('falls back on the process environment for a reference the store holds no value for', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'env-key')
    const { fetchImpl } = await mount({ apiKeyEnv: 'BILLING_TEST_KEY' })
    await vi.waitFor(() => { expect(fetchImpl).toHaveBeenCalled() })
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer env-key' })
  })

  it('drops each read that settles after disposal', async () => {
    // Both chains are left holding an unanswered read, so disposal is what the
    // settlement meets; neither may write a value into a stopped plugin.
    const balance = Promise.withResolvers<Response>()
    const page = Promise.withResolvers<WebFetchResult>()
    const { settings, fiber } = await mount({}, {
      balance: () => balance.promise,
      prices: () => page.promise,
    })
    await fiber.dispose()
    balance.resolve(Response.json(BALANCE_BODY))
    page.resolve(pageOf())
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(settings.persisted).toEqual([])
    expect(settings.doc[NS]).toBeUndefined()
  })

  it('reads the page when the browser asks for it, then clears the request', async () => {
    const { ctx, settings, page } = await mount()
    await vi.waitFor(() => { expect(page).toHaveBeenCalledTimes(1) })

    // The page's request is a settings write: that document is the one store
    // both halves share, and the Host watches it for exactly this.
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['officialRequest'], value: Date.now() }])
    await vi.waitFor(() => { expect(page).toHaveBeenCalledTimes(2) })
    // It stays pending until its read settles, which is how the page shows that
    // read as in flight.
    await vi.waitFor(() => { expect(settings.doc[NS]).toMatchObject({ officialRequest: null }) })
  })

  it('serves one read for a request the page repeated', async () => {
    // The reading is left unanswered, so the repeat lands while it is in
    // flight: the same request twice is not a second read.
    const reading = Promise.withResolvers<WebFetchResult>()
    const { ctx, page } = await mount({}, { prices: () => reading.promise })
    const asked = Date.now()
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['officialRequest'], value: asked }])
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['officialRequest'], value: asked }])
    // The read start-up began, plus the one the request caused.
    await vi.waitFor(() => { expect(page).toHaveBeenCalledTimes(2) })
    reading.resolve(pageOf())
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(page).toHaveBeenCalledTimes(2)
  })

  it('leaves the request field alone for a read nobody asked for', async () => {
    const { settings } = await mount()
    await vi.waitFor(() => { expect(storedOfficial(settings)).not.toBeUndefined() })
    expect(settings.doc[NS]).not.toHaveProperty('officialRequest')
  })

  it('waits out the interval rather than re-reading a table it still covers', async () => {
    const { page, settings } = await mount({ pricingRefreshIntervalMs: 86_400_000 }, {}, {
      [NS]: { official: { models: {}, currency: 'CNY', at: Date.now() - 60_000, source: DEFAULT_PRICING_URL } },
    })
    // The balance chain still settles, which is what proves the plugin ran: a
    // published price list moves rarely, so a restart inside the interval is
    // not a reason to read the page again.
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34 }) })
    expect(page).not.toHaveBeenCalled()
  })

  it('re-reads a table the interval has passed', async () => {
    const { page } = await mount({ pricingRefreshIntervalMs: 86_400_000 }, {}, {
      [NS]: { official: { models: {}, currency: 'CNY', at: Date.now() - 2 * 86_400_000, source: DEFAULT_PRICING_URL } },
    })
    await vi.waitFor(() => { expect(page).toHaveBeenCalledTimes(1) })
  })
})

describe('readBalance', () => {
  const request = {
    baseURL: `${DEFAULT_BASE_URL}/`, apiKeyEnv: 'BILLING_TEST_KEY', currency: 'CNY', timeoutMs: 1_000,
  }

  it('reports a missing credential without a request', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const result = await readBalance(request, fromEnv)
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'noKey', ref: 'BILLING_TEST_KEY' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('prefers the configured currency and reports availability', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      is_available: false,
      balance_infos: [
        { currency: 'USD', total_balance: '1.5' },
        { currency: 'CNY', total_balance: '10.25' },
      ],
    }))))
    const result = await readBalance(request, fromEnv)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.balance : undefined).toMatchObject({
      total: 10.25, currency: 'CNY', available: false,
    })
  })

  it('falls back to the first reported currency', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      balance_infos: [{ currency: 'USD', total_balance: '2' }],
    }))))
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? result.balance.currency : undefined).toBe('USD')
  })

  it('refuses each malformed response', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    for (const [body, detail] of [
      // A parse failure's own message is the runtime's, so only the shape of
      // this package's answer is pinned for it; the rest name the gap itself.
      ['not json', undefined],
      ['"scalar"', 'not an object'],
      ['{}', 'no balance_infos array'],
      ['{"balance_infos":[]}', 'no usable amount'],
      ['{"balance_infos":[null]}', 'no usable amount'],
      ['{"balance_infos":["x"]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"CNY"}]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"","total_balance":"1"}]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"CNY","total_balance":"abc"}]}', 'no usable amount'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))))
      const result = await readBalance(request, fromEnv)
      expect(result.ok, body).toBe(false)
      const failure = result.ok ? undefined : result.failure
      expect(failure?.kind, body).toBe('payload')
      if (detail !== undefined) expect(failure, body).toEqual({ kind: 'payload', detail })
    }
  })

  it('reports a transport failure', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('socket closed'))))
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'socket closed' })
  })

  it('reports a thrown value that is not an Error as its own text', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    // A transport can fail with anything at all; the read states what it was
    // given rather than claiming a cause it cannot name.
    vi.stubGlobal('fetch', vi.fn(() => { throw 'closed' }))
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'closed' })
  })
})
