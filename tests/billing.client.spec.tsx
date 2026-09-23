// @vitest-environment jsdom
/**
 * ui-billing browser half: the two composer-dock cost pills, the per-turn cost
 * row, the Billing settings page, and the plugin's three slot registrations
 * against the real SlotRegistry (fiber teardown must remove all of them).
 *
 * The components take the framework's seats as plain props, so these specs
 * drive them directly and assert what a reader sees: amounts, route rows, and
 * the writes a Save queues.
 */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import {
  makeTranslate, stubConfigForm, TestRemote, type StubConfigForm,
} from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { DEFAULT_CURRENCY, NS, type BillingSettings } from '../src/settings.ts'
import { providerRoutes, type ProviderRouteGroup } from '../src/client/routes.ts'
import { SessionCostMeter, currencyOf, freshness, groupSteps } from '../src/client/CostMeter.tsx'
import { TurnCostMeter } from '../src/client/TurnCostMeter.tsx'
import { BillingPage, type BillingPageProps } from '../src/client/BillingPage.tsx'
import type { BillingPageInjected, BillingPillsInjected } from '../src/client/face.ts'
import { apply, inject } from '../src/client/index.ts'
import { rateOps } from '../src/client/rate-ops.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(en, zh)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Snapshot fields a spec may override; the namespace value may be partial. */
type SnapshotParts =
  & Partial<Omit<ConfigFormSnapshot<BillingSettings>, 'value'>>
  & { readonly value?: Partial<BillingSettings> }

function snapshot(partial: SnapshotParts = {}): ConfigFormSnapshot<BillingSettings> {
  const { value, ...rest } = partial
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
      ...value,
    },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...rest,
  }
}

/**
 * The plugin's injected face, as the renderer hands it to a component: the
 * namespace read is a selector hook over a bare source, and the provider
 * directory arrives as loaded data plus the loader that refreshes it.
 *
 * The directory source is a real observable so a spec observes the same
 * re-render the page sees. `ctx` is optional because the pill specs need only
 * the namespace read.
 */
function billingFace(stub: StubConfigForm<BillingSettings>, ctx?: Context) {
  const groups = createSnapshotStore<readonly ProviderRouteGroup[]>([])
  // The renderer binds the injected source with useSyncExternalStore; the spec
  // runs the same binding so a published snapshot re-renders the component
  // exactly as it does in the app.
  const subscribe = (notify: () => void): (() => void) => stub.scope.subscribe(notify)
  const subscribeGroups = (notify: () => void): (() => void) => groups.subscribe(notify)
  return {
    useBilling: ((selector: (value: ConfigFormSnapshot<BillingSettings>) => unknown) =>
      useSyncExternalStore(subscribe, () => selector(stub.scope.getSnapshot()))) as never,
    useBillingGroups: ((selector: (value: readonly ProviderRouteGroup[]) => unknown) =>
      useSyncExternalStore(subscribeGroups, () => selector(groups.getSnapshot()))) as never,
    routeGroups: async () => {
      if (ctx === undefined) return
      const describe = (ctx as unknown as {
        configForms: {
          describe(): {
            ensure(): Promise<void>
            getSnapshot(): { view?: { namespaces: readonly { ns: string; value: unknown; user?: unknown }[] } }
          }
        }
      }).configForms.describe()
      const [registered, directory] = await Promise.all([
        ctx.remote.llm.listProviders(),
        ctx.remote.llm.listConfigurableProviders(),
      ])
      if (!registered.ok || !directory.ok) return
      await describe.ensure()
      const view = describe.getSnapshot().view
      if (view === undefined) return
      groups.set(providerRoutes(directory.value, registered.value, view.namespaces.map(entry => ({
        ns: entry.ns,
        value: entry.value,
        ...entry.user === undefined ? {} : { user: entry.user },
      }))))
    },
  }
}


/**
 * Render the configuration page the way the Plugins page does.
 *
 * The owner re-renders a page when its entry's form changes, so the harness
 * subscribes to the same stub the spec publishes through, and hands the page
 * the form of the entry the row names. `mutate` is the spy a save is asserted
 * against; it answers acceptance, which is what re-seeds the page's drafts.
 * @param stub - the entry form stub the spec publishes through.
 * @param face - the plugin's injected face for this spec.
 * @returns the write spy, so a spec can assert what a save sent.
 */
function renderPage(
  stub: StubConfigForm<BillingSettings>,
  face: ReturnType<typeof billingFace>,
): { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn(async () => true) as unknown as ReturnType<typeof vi.fn>
  function Harness() {
    const state = useSyncExternalStore(
      (notify: () => void) => stub.scope.subscribe(notify),
      () => stub.scope.getSnapshot(),
    ) as unknown as ConfigFormSnapshot<Record<string, unknown>>
    return (
      <BillingPage
        {...seats()}
        view="page"
        form={{ state, mutate: mutate as unknown as NonNullable<BillingPageProps['form']>['mutate'] }}
        useBillingGroups={face.useBillingGroups}
        routeGroups={face.routeGroups}
        t={t}
      />
    )
  }
  render(<Harness />)
  return { mutate }
}

/**
 * The framework seats the renderer supplies to a slot entry. These specs drive
 * each component directly and read only its owner share, the plugin's injected
 * face, and its locale seat, so every other seat is a stub here; the members are
 * typed `never` because no spec reads them.
 * @returns one stub per standard seat, including the settings page's `close`.
 */
function seats() {
  return {
    useSession: (() => undefined) as never,
    sessionId: 'session-1' as never,
    useProjection: (() => undefined) as never,
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
    useSessionStatus: (() => undefined) as never,
    useSessionRetainInfo: (() => undefined) as never,
  }
}

/** A projection seat over one fixed value. */
function projection(values: Record<string, unknown>) {
  return (key: string): unknown => values[key]
}

const FLASH_RATES = { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }

/** A moment inside the published peak window, so a windowed row is deterministic. */
const AT = Date.UTC(2024, 0, 1, 1, 0)

describe('currency selection', () => {
  it('uses the account currency, then the configured one', () => {
    expect(currencyOf({ total: 1, currency: 'USD', available: true, at: 0 }, 'CNY')).toBe('USD')
    expect(currencyOf(null, 'EUR')).toBe('EUR')
  })
})

describe('session cost pill', () => {
  it('renders nothing before any usage or balance exists', () => {
    const stub = stubConfigForm<BillingSettings>()
    const { container } = render(
      <SessionCostMeter {...seats()} useProjection={projection({}) as never} {...billingFace(stub)} t={t} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('prices the running total and shows the account balance beside it', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 12.75, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥18.00')).toBeDefined()
    // The visible text is the bare figure; the accessible name states what each
    // figure is, which is what a reader hears and what hover shows. Both pills
    // are reached by that name because the balance pill also carries its amount
    // inside a localized label.
    expect(screen.getByLabelText('¥18.00 this session')).toBeDefined()
    expect(screen.getByLabelText('DeepSeek account balance ¥12.75')).toBeDefined()
    expect(screen.getByLabelText('DeepSeek account balance ¥12.75').textContent).toContain('12.75')
  })

  it('reprices when a rate is edited', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥13.50')).toBeDefined()
    await act(async () => {
      stub.publish(snapshot({
        value: {
          currency: 'CNY',
          models: { 'bai/glm-5.3-flash': { ...FLASH_RATES, output: 20 } },
          cache: null,
          cacheError: null,
        },
      }))
    })
    expect(screen.getByText('¥20.00')).toBeDefined()
  })

  it('names an unpriced route instead of inventing a total', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'x', model: 'y' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    // The visible text is the bare dash for both figures, so the pill is
    // addressed by what it means.
    const pill = screen.getByLabelText('Session cost unavailable')
    expect(pill.textContent).toContain('-')
    fireEvent.click(pill)
    expect(screen.getByText('No route has rates yet, so no cost can be computed. Set them in this plugin’s row configuration on the Plugins page.')).toBeDefined()
    expect(screen.getByText('x/y')).toBeDefined()
    expect(screen.getByText('No rates configured')).toBeDefined()
  })

  it('shows the balance dialog with freshness and a recorded failure', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: { total: 3, currency: 'USD', available: false, at: Date.now() - 120_000 },
        cacheError: { kind: 'http', status: 401 },
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('DeepSeek account balance $3.00'))
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek account balance' })
    expect(within(dialog).getByText('Insufficient balance')).toBeDefined()
    expect(within(dialog).getByText('2 min ago')).toBeDefined()
    expect(within(dialog).getByText('Balance read failed: HTTP 401')).toBeDefined()
  })

  it('closes on Escape and on an outside pointer', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({ value: { currency: 'CNY', models: {}, cache: null, cacheError: { kind: 'network', detail: 'offline' } } }))
    render(<SessionCostMeter {...seats()} useProjection={projection({}) as never} {...billingFace(stub)} t={t} />)
    const trigger = screen.getByLabelText('DeepSeek account balance unavailable')
    fireEvent.click(trigger)
    // The panel is still hidden until the placement clamp measures it, which
    // jsdom reports as zero-size geometry, so the role query includes it.
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance', hidden: true })).toBeDefined()
    // A key that is not Escape leaves it open.
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance', hidden: true })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance', hidden: true })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })

  it('keeps one dialog open at a time', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'a/b': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('¥4.50 this session'))
    expect(screen.getByRole('dialog', { name: 'Session cost' })).toBeDefined()
    fireEvent.click(screen.getByLabelText('DeepSeek account balance ¥1.00'))
    expect(screen.queryByRole('dialog', { name: 'Session cost' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance' })).toBeDefined()
  })

  it('closes a pill by clicking it a second time', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    render(<SessionCostMeter {...seats()} useProjection={projection({}) as never} {...billingFace(stub)} t={t} />)
    const trigger = screen.getByLabelText('DeepSeek account balance ¥1.00')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance' })).toBeDefined()
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog', { name: 'DeepSeek account balance' })).toBeNull()
  })

  it('names the route it cannot identify while the selection is unread', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'a/b': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    // The running total grew, but nothing says which model was selected: the
    // stretch belongs to a route this browser never observed.
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({ tokenUsage: usage }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('Session cost unavailable'))
    expect(screen.getByText('unknown')).toBeDefined()
  })

  it('shows the balance alone while the running total is still zero', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'a/b': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const zero: TokenUsageProjection = {
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: zero,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    // A projection that exists but holds no tokens is not a priced session, and
    // the dialog has no stretch to break down.
    fireEvent.click(screen.getByLabelText('Session cost unavailable'))
    expect(screen.getByRole('dialog', { name: 'Session cost' })).toBeDefined()
    expect(document.querySelector('[data-billing-session-routes]')).toBeNull()
  })

  it('adds one stretch each time the running total grows', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'a/b': FLASH_RATES }, cache: null, cacheError: null },
    }))
    const selection = { lastUsed: { provider: 'a', model: 'b' }, next: null }
    const view = render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: { uncachedInputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          modelSelection: selection,
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥13.50')).toBeDefined()
    // The second million output tokens are a growth of the running total, so
    // they are priced as their own stretch under the same route.
    view.rerender(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: { uncachedInputTokens: 0, outputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          modelSelection: selection,
        })}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥27.00')).toBeDefined()
  })

  it('drops the running total when the projection goes away', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'a/b': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const view = render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥4.50')).toBeDefined()
    // No projection at all — the session was switched, or its usage is not
    // loaded — means no accumulated total either; the balance stays.
    view.rerender(
      <SessionCostMeter {...seats()} useProjection={projection({})} {...billingFace(stub)} t={t} />,
    )
    expect(screen.queryByText('¥4.50')).toBeNull()
    expect(screen.getByText('¥1.00')).toBeDefined()
  })
})

describe('reactive namespace read', () => {
  it('binds one observable source per plugin face and releases it with the entry', () => {
    const stub = stubConfigForm<BillingSettings>()
    // What the plugin hands the renderer: a bare source, not a hook.
    const source = {
      getSnapshot: () => stub.scope.getSnapshot(),
      subscribe: (notify: () => void) => stub.scope.subscribe(notify),
    }
    expect(source.getSnapshot().value).toBeUndefined()
    stub.publish(snapshot({ value: { currency: 'USD', models: {}, cache: null, cacheError: null } }))
    expect(source.getSnapshot().value?.currency).toBe('USD')
    // The renderer derives `useBilling` from this source; the framework's own
    // binding is pinned by ui-renderer's `hooks` specs, so what this package
    // owns is the source and the snapshot identity it answers with.
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
  })
})

describe('turn cost row', () => {
  const nodes = [
    {
      key: 'turn-tail', kind: 'turn-tail', target: 'chat', anchorSeq: 3, location: { kind: 'session' },
      visibility: 'visible', id: 'turn-tail',
      data: {
        turn: 1,
        time: AT,
        tokenUsage: {
          uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          routes: [{ provider: 'bai', model: 'glm-5.3-flash' }],
        },
      },
    },
    {
      // A row of another kind: the pill reads the turn-tail payload alone, and a
      // node of another kind is skipped rather than inspected.
      key: 'tool-1', kind: 'tool-call', target: 'chat', anchorSeq: 2, location: { kind: 'session' },
      visibility: 'visible', id: 'tool-1',
      data: { turn: 1 },
    },
    {
      // A Turn that ran only on a route with no rate at all, official prices
      // included: the unpriced arm needs a provider of its own.
      key: 'turn-tail-3', kind: 'turn-tail', target: 'chat', anchorSeq: 7, location: { kind: 'session' },
      visibility: 'visible', id: 'turn-tail-3',
      data: {
        turn: 3,
        time: AT,
        tokenUsage: {
          uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          routes: [{ provider: 'x', model: 'other' }],
        },
      },
    },
  ] as unknown as readonly ChatConversationViewNode[]

  function useChat<T>(select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => T): T {
    return select({ nodes: { values: () => nodes } })
  }

  /** One Chat node carrying the members this plugin reads; every other member is a stub. */
  function node(kind: string, id: string, data: unknown): ChatConversationViewNode {
    return {
      key: id, kind, target: 'chat', anchorSeq: 1, location: { kind: 'session' },
      visibility: 'visible', id, data,
    } as unknown as ChatConversationViewNode
  }

  /** A Chat selector over one node list. */
  function chatOver(list: readonly ChatConversationViewNode[]) {
    return ((select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => unknown) =>
      select({ nodes: { values: () => list } })) as never
  }

  /** One turn-tail: the turn's own aggregate accounting, and the routes it names. */
  function tail(turn: number, time: number, routes?: readonly { provider: string; model: string }[]) {
    return node('turn-tail', `tail-${String(turn)}`, {
      turn,
      time,
      tokenUsage: {
        uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        ...routes === undefined ? {} : { routes },
      },
    })
  }

  it('renders the turn total and its route', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('Cost ¥18.00')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Cost ¥18.00'))
    const dialog = screen.getByRole('dialog', { name: 'Turn cost' })
    const rows = dialog.querySelector('[data-billing-turn-routes]')
    expect(rows?.textContent).toContain('bai/glm-5.3-flash')
    expect(rows?.textContent).toContain('¥18.00')
    // The dialog's footnote names the route it priced and the three figures it
    // charged it at.
    expect(within(dialog).getByText(/bai\/glm-5\.3-flash: 0\.15 \/ 4\.5 \/ 13\.5/)).toBeDefined()
  })

  it('shows no figure for a turn whose own accounting is incomplete', () => {
    // The session projection is a session-wide running total, so it can never
    // stand in for one turn: a turn whose token accounting is absent — its
    // events paged out, an attempt that never settled — reads as no figure,
    // exactly as its own Turn-usage pill reads.
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const view = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 9 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(view.container.innerHTML).toBe('')
  })

  it('reports an unpriced turn and stays silent without accounting', () => {
    // Turn 3 ran only on a route nothing prices, official defaults included.
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const { unmount } = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 3 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('Cost -')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Cost -'))
    expect(screen.getByText('No rates configured; this turn is not billed')).toBeDefined()
    unmount()

    const empty = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 9 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(empty.container.innerHTML).toBe('')
  })

  it('declines a turn whose own accounting names several routes', () => {
    // Nothing loaded states which attempt ran on which route, so the pill
    // withholds the figure and the dialog names what it could not attribute
    // instead of charging the aggregate once per route.
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES, 'x/other': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const unattributed = [
      {
        key: 'turn-tail', kind: 'turn-tail', target: 'chat', anchorSeq: 3, location: { kind: 'session' },
        visibility: 'visible', id: 'turn-tail',
        data: {
          turn: 1,
          tokenUsage: {
            uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            routes: [{ provider: 'bai', model: 'glm-5.3-flash' }, { provider: 'x', model: 'other' }],
          },
        },
      },
    ] as unknown as readonly ChatConversationViewNode[]
    const nodes = (select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => unknown) =>
      select({ nodes: { values: () => unattributed } })
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={nodes as never}
        {...billingFace(stub)}
        t={t} />,
    )
    const pill = screen.getByLabelText('Cost -')
    expect(pill.textContent).toContain('-')
    fireEvent.click(pill)
    expect(screen.getByText('This turn ran on several routes (bai/glm-5.3-flash, x/other) and its own accounting cannot split them, so no cost is counted')).toBeDefined()
  })

  it('prices a turn that ran in the off-peak window and names the window it used', () => {
    const stub = stubConfigForm<BillingSettings>()
    const banded = { ...FLASH_RATES, offPeak: { cacheHit: 0.075, cacheMiss: 2.25, output: 6.75 } }
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'deepseek-official/deepseek-v4-flash': banded },
        cache: null,
        cacheError: null,
      },
    }))
    const offPeakAt = Date.UTC(2024, 0, 1, 4, 0)
    const list = [tail(1, offPeakAt, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])]
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={chatOver(list)}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('Cost ¥2.25')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Cost ¥2.25'))
    const dialog = screen.getByRole('dialog', { name: 'Turn cost' })
    // The row states the window it was charged in, and the footnote quotes that
    // window's figures rather than the peak ones.
    expect(within(dialog).getByText('off-peak')).toBeDefined()
    expect(within(dialog).getByText('deepseek-official/deepseek-v4-flash · off-peak: 0.075 / 2.25 / 6.75')).toBeDefined()
  })

  it('states that a turn whose accounting named no route cannot be attributed', () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'bai/glm-5.3-flash': FLASH_RATES }, cache: null, cacheError: null },
    }))
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={chatOver([tail(1, AT)])}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('Cost -'))
    expect(screen.getByText('This turn carries no route evidence to attribute, so no cost is counted')).toBeDefined()
  })

  it('prices an official turn before the settings document has loaded', () => {
    // Nothing is published yet, so the shipped price table is all there is and
    // the figure is stated in the package's default currency.
    const stub = stubConfigForm<BillingSettings>()
    const list = [
      node('turn-tail', 'tail-1', {
        turn: 1,
        time: AT,
        tokenUsage: {
          uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
        },
      }),
    ]
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={chatOver(list)}
        {...billingFace(stub)}
        t={t} />,
    )
    // Shipped peak figures: 2 per million uncached input and 8 per million output.
    expect(screen.getByText('Cost ¥10.00')).toBeDefined()
  })
})

describe('settings page', () => {
  /** A Remote double carrying the provider directory the page reads. */
  function remoteDouble(): { llm: Record<string, unknown> } {
    return {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [{ id: 'bai', name: 'BAI' }] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [{ provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] }],
        }),
      },
    }
  }

  /**
   * The describe mirror's answer with `bai` in the user layer, which is what
   * makes the page treat it as a provider the user configured.
   */
  function baiDirectory(overrides: { value?: unknown; user?: unknown } = {}) {
    // The user layer is what marks `bai` configured; its profile carries the
    // model list the page prices.
    const profile = { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }] }
    return {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [{
            ns: 'llm-pi-ai',
            value: overrides.value ?? { providers: { bai: profile } },
            user: overrides.user ?? { providers: { bai: profile } },
          }],
        },
      }),
    }
  }

  function contextDouble(
    remote: { llm: Record<string, unknown> },
    describe: unknown,
  ): Context {
    const ctx = new Context()
    // The real double also provides `remote.<namespace>`, which is what a
    // plugin injecting `remote.llm` waits on.
    new TestRemote(ctx, remote)
    ctx.provide('configForms', { describe: () => describe } as never)
    return ctx
  }

  it('lists the configured models with their stored rates', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 12.75, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const ctx = contextDouble(remoteDouble(), baiDirectory({
      value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
      user: { providers: { bai: { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
    }))
    const face1 = billingFace(stub, ctx)
    renderPage(stub, face1)

    await waitFor(() => { expect(screen.queryByText('BAI')).not.toBeNull() })
    expect(screen.getByText('DeepSeek account balance')).toBeDefined()
    expect(screen.getByText('¥12.75')).toBeDefined()
    // A closed card summarises what it holds: two models, one of them priced.
    expect(screen.getByText('2 models')).toBeDefined()
    expect(screen.getByText('1 priced')).toBeDefined()
    expect(screen.queryByLabelText('bai/glm-5.3-flash Cache hit')).toBeNull()

    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    const saved = screen.getByLabelText('bai/glm-5.3-flash Cache hit') as HTMLInputElement
    expect(saved.value).toBe('0.15')
    const blank = screen.getByLabelText('bai/qwen3.8-flash Cache hit') as HTMLInputElement
    expect(blank.value).toBe('')
    // The control reads as its opposite state while the card is open.
    fireEvent.click(screen.getByLabelText('Collapse rates for bai'))
    expect(screen.queryByLabelText('bai/glm-5.3-flash Cache hit')).toBeNull()
  })

  it('shows one band per non-official route and reveals a second on request', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    renderPage(stub, face)

    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    // This provider prices one figure at every hour, so its fields carry no
    // window to name and the second band stays off the page.
    expect(screen.getByLabelText('bai/glm-5.3-flash Cache hit')).toBeDefined()
    expect(screen.queryByLabelText('bai/glm-5.3-flash off-peak Cache hit')).toBeNull()
    // Asking for it turns the row into the two labelled bands a provider that
    // bills by window carries.
    fireEvent.click(screen.getByLabelText('Add an off-peak rate to bai/glm-5.3-flash'))
    const hit = screen.getByLabelText('bai/glm-5.3-flash peak Cache hit') as HTMLInputElement
    expect(hit.value).toBe('0.15')
    const offPeak = screen.getByLabelText('bai/glm-5.3-flash off-peak Cache hit') as HTMLInputElement
    expect(offPeak.value).toBe('')
    expect(offPeak.placeholder).toBe('same as peak')
    expect(screen.queryByLabelText('Add an off-peak rate to bai/glm-5.3-flash')).toBeNull()
  })

  it('shows both bands of a route that already stores a second one', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {
          'bai/glm-5.3-flash': { ...FLASH_RATES, offPeak: { cacheHit: 0.075, cacheMiss: 2.25, output: 6.75 } },
        },
        cache: null,
        cacheError: null,
      },
    }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    renderPage(stub, face)

    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    // A route that holds a second band shows it unasked: what a route is billed
    // at is never hidden state.
    const offPeak = screen.getByLabelText('bai/glm-5.3-flash off-peak Cache hit') as HTMLInputElement
    expect(offPeak.value).toBe('0.075')
    expect(screen.queryByLabelText('Add an off-peak rate to bai/glm-5.3-flash')).toBeNull()
  })

  it('shows the published official price as the fallback a route is billed at', async () => {
    // The official provider is configured by the deployment rather than by the
    // user layer, and its model carries no stored rate: the card is priced by
    // the published table, and the fields show it as the placeholder the user
    // overrides, one row of fields per price window.
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: null,
        cacheError: null,
        official: {
          models: {
            'deepseek-v4-flash': {
              cacheHit: 0.04, cacheMiss: 2, output: 8,
              offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
            },
          },
          currency: 'CNY',
          at: Date.now(),
          source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
        },
        officialError: null,
      },
    }))
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [{ id: 'deepseek-official', name: 'DeepSeek' }] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [{
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek',
            settingsPath: ['providers', 'deepseek-official'],
          }],
        }),
      },
    }
    const directory = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [{
            ns: 'llm-deepseek',
            value: { providers: { 'deepseek-official': { models: [{ id: 'deepseek-v4-flash' }] } } },
          }],
        },
      }),
    }
    const face = billingFace(stub, contextDouble(remote, directory))
    const { mutate } = renderPage(stub, face)

    await screen.findByText('DeepSeek')
    expect(screen.getByText('1 priced')).toBeDefined()
    // The published table the Host read is stated on its own card, with where
    // it came from.
    const card = document.querySelector('[data-billing-official-card]')
    expect(card?.textContent).toContain('Published DeepSeek prices')
    expect(card?.textContent).toContain('1 models')
    expect(card?.textContent).toContain('api-docs.deepseek.com')
    // The official card names the window in force above its two rows of fields,
    // so each row is read against the figure the provider charges now.
    fireEvent.click(screen.getByLabelText('Edit rates for deepseek-official'))
    expect(screen.getByText(/Only the official DeepSeek provider bills in two windows/)).toBeDefined()
    const hit = screen.getByLabelText('deepseek-official/deepseek-v4-flash peak Cache hit') as HTMLInputElement
    expect(hit.value).toBe('')
    expect(hit.placeholder).toBe('0.04')
    const offPeak = screen.getByLabelText('deepseek-official/deepseek-v4-flash off-peak Cache hit') as HTMLInputElement
    expect(offPeak.placeholder).toBe('0.02')
    expect(screen.getByText('default rate')).toBeDefined()
    // A typed second band is handed to the plugin as its own set of fields.
    fireEvent.change(offPeak, { target: { value: '0.03' } })
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    // The page hands the entry's form the operation the row describes: the
    // typed off-peak figure at its own path, and nothing for the fields the
    // user left alone.
    expect(mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['models', 'deepseek-official/deepseek-v4-flash', 'offPeak', 'cacheHit'], value: 0.03 }],
      1,
    )
  })

  it('reports why the Host could not read the published prices', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: null,
        cacheError: null,
        official: null,
        officialError: { kind: 'currency', found: 'USD', expected: 'CNY' },
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)

    const card = document.querySelector('[data-billing-official-card]')
    expect(card?.textContent).toContain('Not read')
    expect(card?.textContent)
      .toContain('The published price page states USD while this document prices in CNY, so it was not adopted')
    expect(card?.textContent).toContain('No published price has been read yet')

    // A deployment that mounts no web capability never had a page to read, and
    // says exactly that.
    await act(async () => {
      stub.publish(snapshot({
        value: {
          currency: 'CNY',
          models: {},
          cache: null,
          cacheError: null,
          official: null,
          officialError: { kind: 'noWeb' },
        },
      }))
    })
    expect(document.querySelector('[data-billing-official-card]')?.textContent)
      .toContain('Published price read failed: this deployment mounts no web fetch capability')
  })

  it('queues one path-addressed write per edited field', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const ctx = contextDouble(remoteDouble(), baiDirectory())
    const face2 = billingFace(stub, ctx)
    const { mutate } = renderPage(stub, face2)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))

    const hit = screen.getByLabelText('bai/glm-5.3-flash Cache hit')
    fireEvent.change(hit, { target: { value: '0.15' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Cache miss'), { target: { value: '4.5' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Output'), { target: { value: '13.5' } })
    fireEvent.click(screen.getAllByText('Save')[0] as HTMLElement)
    await act(async () => { await Promise.resolve() })
    // The page hands the plugin both bands as typed; the plugin owns how they
    // become settings writes. This provider bills one figure at every hour, so
    // it offers no off-peak fields and hands over an empty band.
    expect(mutate).toHaveBeenCalledWith(
      [
        { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'cacheHit'], value: 0.15 },
        { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'cacheMiss'], value: 4.5 },
        { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'output'], value: 13.5 },
      ],
      1,
    )
  })

  it('clears a stored row and reports a refused write', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'bai/glm-5.3-flash': FLASH_RATES }, cache: null, cacheError: null },
    }))
    const ctx = contextDouble(remoteDouble(), baiDirectory({
      value: { providers: { bai: { models: [] } } },
      user: { providers: { bai: {} } },
    }))
    const face3 = billingFace(stub, ctx)
    const { mutate } = renderPage(stub, face3)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    // Clear stages the row's removal; the page's own save is what writes it, as
    // one unset of the whole stored row.
    fireEvent.click(screen.getByText('Clear'))
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['models', 'bai/glm-5.3-flash'] }], 1)

    // A save the Host refuses says so and keeps the drafts, so the user can try again.
    mutate.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByText('Clear'))
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
  })

  it('adds a route by hand and validates its form', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face4 = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face4)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')

    // The page's own entry point opens the provider it names, so a route no
    // directory declares is still priceable.
    const field = screen.getByLabelText('Add a route manually')
    fireEvent.change(field, { target: { value: 'bai' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('Enter provider/model, for example bai/glm-5.3-flash')).toBeDefined()

    fireEvent.change(field, { target: { value: 'custom/model' } })
    fireEvent.click(screen.getByText('Add'))
    expect(screen.getByLabelText('custom/model Cache hit')).toBeDefined()
    // A route the user adds by hand belongs to no provider that bills by time
    // of day, so the page offers it one band of fields.
    expect(screen.queryByLabelText('custom/model off-peak Cache hit')).toBeNull()
    expect(screen.queryAllByLabelText('custom/model Cache hit')).toHaveLength(1)
  })

  it('keeps a configured provider that has no model list, so its routes can be added', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    // x is configured in the user layer but its settings path names no models.
    const directory = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [
            { ns: 'llm-pi-ai', value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } },
              user: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } } },
            { ns: 'llm-x', value: {}, user: { providers: { x: {} } } },
          ],
        },
      }),
    }
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [
            { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
            { provider: 'x', displayName: 'X', settingsNs: 'llm-x', settingsPath: ['providers', 'x'] },
          ],
        }),
      },
    }
    const face5 = billingFace(stub, contextDouble(remote, directory))
    renderPage(stub, face5)
    expect(await screen.findByText('BAI')).toBeDefined()
    // The configured-but-modelless provider keeps its card as the seat for a
    // hand-added route; an unconfigured catalogue row adds none.
    expect(screen.getByText('X')).toBeDefined()
    expect(screen.queryByText('0 models')).toBeDefined()
  })

  it('disables editing on a read-only document and reports a failed balance read', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      writable: false,
      value: { currency: 'USD', models: {}, cache: null, cacheError: { kind: 'http', status: 401 } },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face6 = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face6)
    await screen.findByText('This deployment stores settings read-only, so rates cannot be saved.')
    expect(screen.getByText('Balance read failed: HTTP 401')).toBeDefined()
    // Neither card has a figure to show: the balance and the published table
    // are both unread.
    expect(screen.getAllByText('Not read')).toHaveLength(2)
  })

  it('reloads the provider directory when the adapter roster changes', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const ctx = new Context()
    const remote = new TestRemote(ctx, remoteDouble())
    ctx.provide('configForms', { describe: () => describeFace } as never)
    const face7 = billingFace(stub, ctx)
    renderPage(stub, face7)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')
    // Both invalidation channels the page follows converge on the same reload.
    await act(async () => { remote.emit('llm/adapters-updated', []) })
    await act(async () => { ctx.emit('connection/reset') })
    expect(screen.getByText('BAI')).toBeDefined()
  })

  it('renders before the settings document has loaded', async () => {
    // No value yet: the page states what it has — nothing — rather than
    // inventing rates, and the currency it would price in is the shipped one.
    const stub = stubConfigForm<BillingSettings>()
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')
    expect(screen.getAllByText('Not read')).toHaveLength(2)
    expect(screen.getByText('CNY')).toBeDefined()
  })

  it('shows a stored zero as its own figure rather than an empty field', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': { cacheHit: 0, cacheMiss: 4.5, output: 13.5 } },
        cache: null,
        cacheError: null,
      },
    }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    renderPage(stub, face)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    expect(screen.getByLabelText<HTMLInputElement>('bai/glm-5.3-flash Cache hit').value).toBe('0')
  })

  it('leaves an unconfigured catalogue provider out of the priced cards', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    // The catalogue can configure it, but nothing here does: no user profile,
    // no live registration, and no stored row, so it carries nothing to price.
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [{
            provider: 'cat',
            displayName: 'Catalogue',
            settingsNs: 'llm-cat',
            settingsPath: ['providers', 'cat'],
          }],
        }),
      },
    }
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remote, describeFace))
    renderPage(stub, face)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')
    expect(screen.queryByText('Catalogue')).toBeNull()
  })

  it('keeps a hand-added route on the card of a provider already listed', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    renderPage(stub, face)
    await screen.findByText('BAI')

    // The provider already has a card, so the typed route joins it rather than
    // creating a second one.
    const field = screen.getByLabelText('Add a route manually')
    fireEvent.change(field, { target: { value: 'bai/new-model' } })
    fireEvent.click(screen.getByText('Add'))
    expect(screen.getByLabelText('bai/new-model Cache hit')).toBeDefined()
    expect(screen.getAllByText('BAI')).toHaveLength(1)
  })

  it('adds a route from the card’s own Add control', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    renderPage(stub, face)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))

    const models = document.querySelector('[data-billing-provider-models="bai"]') as HTMLElement
    const field = within(models).getByLabelText('Add a route to bai')
    fireEvent.change(field, { target: { value: 'bai/typed-model' } })
    fireEvent.click(within(models).getByText('Add'))
    expect(screen.getByLabelText('bai/typed-model Cache hit')).toBeDefined()
  })

  it('keeps one row for a route typed twice', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')

    const field = screen.getByLabelText('Add a route manually')
    for (const _ of [0, 1]) {
      fireEvent.change(field, { target: { value: 'custom/model' } })
      fireEvent.keyDown(field, { key: 'Enter' })
    }
    expect(screen.queryAllByLabelText('custom/model Cache hit')).toHaveLength(1)
  })

  it('adds a route from the card of a provider whose model list is empty', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot())
    // bai is configured with a model; x is configured but its profile names none.
    const directory = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [
            { ns: 'llm-pi-ai', value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } },
              user: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } } },
            { ns: 'llm-x', value: {}, user: { providers: { x: {} } } },
          ],
        },
      }),
    }
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [
            { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
            { provider: 'x', displayName: 'X', settingsNs: 'llm-x', settingsPath: ['providers', 'x'] },
          ],
        }),
      },
    }
    const face = billingFace(stub, contextDouble(remote, directory))
    renderPage(stub, face)
    await screen.findByText('X')
    fireEvent.click(screen.getByLabelText('Edit rates for x'))
    expect(screen.getByText('This provider has no model to price; add a route below.')).toBeDefined()

    // The card's own field takes a route the same way the page's does, and a
    // key that is not one reports the form error on that card.
    const field = screen.getByLabelText('Add a route to x')
    fireEvent.change(field, { target: { value: 'x' } })
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.keyDown(field, { key: 'Enter' })
    // Each entry point keeps its own typed text and its own error, so a key
    // mistyped in one marks that input alone: one shared state would light up
    // the other as well, and would mirror every keystroke into it.
    const invalid = 'Enter provider/model, for example bai/glm-5.3-flash'
    expect(screen.getAllByText(invalid)).toHaveLength(1)
    fireEvent.change(field, { target: { value: 'x/only' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByLabelText('x/only Cache hit')).toBeDefined()
    expect(screen.queryByText(invalid)).toBeNull()

    // The page-level field ignores every key but Enter, and carries its own error.
    const entry = screen.getByLabelText<HTMLInputElement>('Add a route manually')
    fireEvent.keyDown(entry, { key: 'a' })
    expect(screen.queryAllByLabelText('a Cache hit')).toHaveLength(0)
    fireEvent.change(entry, { target: { value: 'nope' } })
    fireEvent.keyDown(entry, { key: 'Enter' })
    expect(screen.getAllByText(invalid)).toHaveLength(1)
    // Each input also shows what was typed into it: a field reading the other
    // entry point's text still passes the checks above, because both hand their
    // own state to `addManual`.
    expect(entry.value).toBe('nope')
    expect(screen.getByLabelText<HTMLInputElement>('Add a route to x').value).toBe('')
  })

  it('states a refused write that is not an Error', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'bai/glm-5.3-flash': FLASH_RATES }, cache: null, cacheError: null },
    }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    const { mutate } = renderPage(stub, face)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    // A save writes what was staged, so one field is staged before the refusal.
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Cache hit'), { target: { value: '0.2' } })

    mutate.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
  })

  it('reports a refused clear, whatever the refusal was', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES, 'bai/qwen3.8-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory({
      value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
      user: { providers: { bai: { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
    })))
    const { mutate } = renderPage(stub, face)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))

    // Clearing two rows stages two removals, and the one save writes both.
    fireEvent.click(screen.getAllByText('Clear')[0] as HTMLElement)
    fireEvent.click(screen.getAllByText('Clear')[1] as HTMLElement)
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    const [ops] = mutate.mock.calls.at(-1) as [{ op: string; path: readonly string[] }[]]
    expect(ops).toHaveLength(2)
    for (const op of ops) {
      expect(op.op).toBe('unset')
      expect(op.path[0]).toBe('models')
      expect(op.path).toHaveLength(2)
    }

    mutate.mockResolvedValueOnce(false)
    fireEvent.click(screen.getAllByText('Clear')[0] as HTMLElement)
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
  })

  it('marks an unavailable balance on its card', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: { total: 0, currency: 'CNY', available: false, at: Date.now() },
        cacheError: null,
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)
    await screen.findByText('Insufficient balance')
  })

  it('states how long ago each read was taken', async () => {
    const now = Date.now()
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: { total: 1, currency: 'CNY', available: true, at: now - 90_000 },
        cacheError: null,
        official: {
          models: {}, currency: 'CNY', at: now - 2 * 3_600_000, source: 'https://api-docs.deepseek.com/x',
        },
        officialError: null,
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)
    expect(await screen.findByText('Read 1 min ago')).toBeDefined()
    expect(screen.getByText('Read 2 h ago')).toBeDefined()

    await act(async () => {
      stub.publish(snapshot({
        value: {
          currency: 'CNY',
          models: {},
          cache: { total: 1, currency: 'CNY', available: true, at: now - 3 * 86_400_000 },
          cacheError: null,
          officialError: null,
        },
      }))
    })
    expect(screen.getByText('Read 3 d ago')).toBeDefined()
  })

  it('states a read request the Host answered as refused', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        official: { models: {}, currency: 'CNY', at: Date.now(), source: 'https://api-docs.deepseek.com/x' },
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    const { mutate } = renderPage(stub, face)

    // A refused write answers rather than rejecting, and a request the Host
    // never took would otherwise look asked for.
    mutate.mockResolvedValueOnce(false)
    fireEvent.click(await screen.findByText('Read now'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
  })

  it('states a save whose transport failed', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({ value: { models: { 'bai/glm-5.3-flash': FLASH_RATES } } }))
    const face = billingFace(stub, contextDouble(remoteDouble(), baiDirectory()))
    const { mutate } = renderPage(stub, face)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Cache hit'), { target: { value: '0.2' } })

    // A transport failure rejects rather than answering, and the staged draft
    // stays so the save can be repeated.
    mutate.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>('bai/glm-5.3-flash Cache hit').value).toBe('0.2')
  })

  it('answers the card’s one-liner with the summary view', () => {
    // The Plugins page renders this view as the configuration card's one-liner,
    // so the card says what the page is for before anyone opens it.
    const stub = stubConfigForm<BillingSettings>()
    const face = billingFace(stub)
    render(
      <BillingPage
        {...seats()}
        view="summary"
        useBillingGroups={face.useBillingGroups}
        routeGroups={face.routeGroups}
        t={t}
      />,
    )
    expect(screen.getByText('Session cost and the DeepSeek balance, priced by the per-route rates you maintain.'))
      .toBeDefined()
  })

  it('names a deployment that serves no form for the entry', () => {
    const stub = stubConfigForm<BillingSettings>()
    const face = billingFace(stub)
    render(
      <BillingPage
        {...seats()}
        view="page"
        useBillingGroups={face.useBillingGroups}
        routeGroups={face.routeGroups}
        t={t}
      />,
    )
    expect(screen.getByText('This deployment does not serve the billing configuration, so there are no rates to edit.'))
      .toBeDefined()
  })

  it('asks the Host to read the published page now', async () => {
    const stored = {
      models: {}, currency: 'CNY', at: Date.now() - 3 * 86_400_000, source: 'https://api-docs.deepseek.com/x',
    }
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({ value: { official: stored } }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    const { mutate } = renderPage(stub, face)

    fireEvent.click(await screen.findByText('Read now'))
    await act(async () => { await Promise.resolve() })
    expect(mutate).toHaveBeenCalledTimes(1)

    // The request reads as in flight until the Host clears it with that read's
    // own settlement, so the control states that instead of inviting a second.
    await act(async () => {
      stub.publish(snapshot({ value: { official: stored, officialRequest: Date.now() } }))
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reading…' }).disabled).toBe(true)

    // A request the Host never answered — it was replaced while the read was
    // pending — stops reading as live, and the control is offered again.
    await act(async () => {
      stub.publish(snapshot({ value: { official: stored, officialRequest: Date.now() - 120_000 } }))
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Read now' }).disabled).toBe(false)
  })

  it('reports a refused read request', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        official: { models: {}, currency: 'CNY', at: Date.now(), source: 'https://api-docs.deepseek.com/x' },
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    const { mutate } = renderPage(stub, face)

    // A deployment that refuses the write refuses the request with it, and the
    // page states the refusal however the transport phrased it.
    mutate.mockRejectedValueOnce(new Error('read-only'))
    fireEvent.click(await screen.findByText('Read now'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()

    mutate.mockRejectedValueOnce('locked')
    fireEvent.click(screen.getByText('Read now'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('The save was not accepted; try again.')).toBeDefined()
  })

  it('shows a recorded source that is not a URL as it was recorded', async () => {
    const stub = stubConfigForm<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: null,
        cacheError: null,
        official: { models: {}, currency: 'CNY', at: Date.now(), source: 'docs/pricing' },
        officialError: null,
      },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    renderPage(stub, face)
    expect(await screen.findByText('Source docs/pricing')).toBeDefined()
  })
})

describe('plugin registration', () => {
  /**
   * Mount the plugin over a real SlotRegistry, the locale plugin, a settings
   * scope stub, and a directory the test drives.
   * @param replies - what the provider directory answers with.
   * @returns the context, the scope stub, the remote, and the plugin fiber.
   */
  async function mountPlugin(replies: {
    registered?: readonly unknown[]
    configurable?: readonly unknown[]
    view?: unknown
    fail?: boolean
    /** Whether the Host serves this plugin's own entry; false for the gated case. */
    served?: boolean
    /** Whether the describe mirror holds a view at all; false models a Host that answered nothing. */
    blank?: boolean
  } = {}) {
    const scope = stubConfigForm<BillingSettings>()
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const remote = new TestRemote(ctx, {
      llm: {
        listProviders: () => Promise.resolve(replies.fail === true
          ? { ok: false, error: 'unavailable' }
          : { ok: true, value: [...replies.registered ?? []] }),
        listConfigurableProviders: () => Promise.resolve(replies.fail === true
          ? { ok: false, error: 'unavailable' }
          : { ok: true, value: [...replies.configurable ?? []] }),
      },
    })
    // The mirror's view with this plugin's own entry in it: both halves ship as
    // one package, so a deployment serving the directory also serves the entry.
    const viewNow = (): unknown => {
      if (replies.blank === true) return undefined
      const view = replies.view as { namespaces?: readonly { ns: string; value: unknown }[] } | undefined
      if (replies.served === false) return view
      const namespaces = [...view?.namespaces ?? []]
      if (!namespaces.some(entry => entry.ns === NS)) namespaces.push({ ns: NS, value: {} })
      return { ...view, namespaces }
    }
    // The describe mirror and its served-namespace watch, with the real
    // service's semantics: `whileServed` registers while one watched namespace
    // is served, drops the registration when none is, and follows the mirror.
    const listeners = new Set<() => void>()
    const mirror = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({ view: viewNow() }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    ctx.provide('configForms', {
      get: () => scope.scope,
      describe: () => mirror,
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        let off: (() => void) | undefined
        const sync = (): void => {
          const served = new Set(
            ((viewNow() as { namespaces?: readonly { ns: string }[] } | undefined)?.namespaces ?? [])
              .map(entry => entry.ns))
          const watched = namespaces.some(namespace => served.has(namespace))
          if (watched && off === undefined) off = register(served)
          else if (!watched && off !== undefined) {
            off()
            off = undefined
          }
        }
        listeners.add(sync)
        sync()
        return () => {
          listeners.delete(sync)
          off?.()
          off = undefined
        }
      },
    } as never)
    // The owning views' child declarations, stood up by a bench root entry.
    ctx.slots.register({
      name: 'root',
      children: {
        'plugins.item': { kind: 'list', scope: 'root' },
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
        'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    /** Move the describe mirror, as the Host's own describe read does. */
    const serve = (view: unknown): void => {
      replies.view = view
      replies.blank = false
      for (const listener of [...listeners]) listener()
    }
    /** Leave the mirror without a view, as a describe read that answered nothing. */
    const blank = (): void => {
      replies.blank = true
      for (const listener of [...listeners]) listener()
    }
    return { ctx, scope, remote, fiber, serve, blank }
  }

  /** The face the configuration page registration injected, as the renderer resolves it. */
  function faceOf(ctx: Context): BillingPageInjected {
    const entry = ctx.slots.entries('plugins.item')[0] as { inject?: () => BillingPageInjected } | undefined
    if (entry?.inject === undefined) throw new Error('the configuration page is not registered')
    return entry.inject()
  }

  /** The face the composer figures' registration injected, as the renderer resolves it. */
  function pillFaceOf(ctx: Context): BillingPillsInjected {
    const entry = ctx.slots.entries('conversation.composer.dock')[0] as { inject?: () => BillingPillsInjected } | undefined
    if (entry?.inject === undefined) throw new Error('the composer figures are not registered')
    return entry.inject()
  }

  it('registers all three surfaces and fiber disposal removes them', async () => {
    const { ctx, fiber } = await mountPlugin()
    expect(ctx.slots.entries('plugins.item')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(1)
    // The configuration page is one of the Plugins page's official-plugin cards,
    // titled from this package's dictionary. Its id is the entry id the Host
    // serves, which is what makes the page owner hand the page that entry's form.
    expect(ctx.slots.entries('plugins.item')[0]?.options).toMatchObject({
      id: NS,
      order: 50,
    })
    // The composer figures state the display order that places them after the
    // shipped stats row, which is the entry stating order 0.
    expect(ctx.slots.entries('conversation.composer.dock')[0]?.options.order).toBe(1)

    await fiber.dispose()
    expect(ctx.slots.entries('plugins.item')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  })

  it('shows the configuration card only while the Host serves the entry', async () => {
    // A deployment whose Host half never composed the entry shows no card, the
    // way every settings page registered through the same watch behaves.
    const { ctx, serve } = await mountPlugin({ served: false })
    expect(ctx.slots.entries('plugins.item')).toHaveLength(0)

    serve({ namespaces: [{ ns: NS, value: {} }] })
    expect(ctx.slots.entries('plugins.item')).toHaveLength(1)

    serve({ namespaces: [] })
    expect(ctx.slots.entries('plugins.item')).toHaveLength(0)
  })

  it('titles the configuration card from this package’s dictionary', async () => {
    const { ctx } = await mountPlugin()
    const label = ctx.slots.entries('plugins.item')[0]?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('Billing')
  })

  it('reads the directory through its own face and republishes it on a signal', async () => {
    const { ctx, remote } = await mountPlugin({
      registered: [{ id: 'live', name: 'Live' }],
      view: {
        namespaces: [
          { ns: 'llm-live', value: {} },
          { ns: 'llm-pi-ai', value: {}, user: { providers: {} } },
        ],
      },
    })
    const face = faceOf(ctx)
    // Before any read there is nothing to refresh, so a signal is a no-op.
    await act(async () => { ctx.emit('connection/reset') })

    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot().map(group => group.provider)).toEqual(['live'])

    const notified: number[] = []
    const off = face.hooks.billingGroups.subscribe(() => { notified.push(1) })
    await act(async () => { remote.emit('llm/adapters-updated', []) })
    off()
    expect(notified.length).toBeGreaterThan(0)
  })

  it('publishes an empty directory when nothing is registered or configured', async () => {
    const { ctx } = await mountPlugin({ view: { namespaces: [] } })
    const face = faceOf(ctx)
    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot()).toEqual([])
  })

  it('keeps the last directory when the mirror loses its view', async () => {
    // A describe read that answers nothing while the page is open is not a
    // directory of nothing: the groups the last read found stay published.
    const { ctx, blank } = await mountPlugin({
      registered: [{ id: 'live', name: 'Live' }],
      view: { namespaces: [{ ns: 'llm-live', value: {} }] },
    })
    const face = faceOf(ctx)
    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot().map(group => group.provider)).toEqual(['live'])

    blank()
    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot().map(group => group.provider)).toEqual(['live'])
  })

  it('publishes nothing when the directory read fails', async () => {
    // The face answers the page with whatever the last successful read found;
    // a failed read is not a directory of nothing.
    const { ctx } = await mountPlugin({ fail: true, view: { namespaces: [] } })
    const face = faceOf(ctx)
    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot()).toEqual([])
  })

  it('publishes nothing while the settings mirror has no view', async () => {
    const { ctx } = await mountPlugin()
    const face = faceOf(ctx)
    await act(async () => { await face.routeGroups() })
    expect(face.hooks.billingGroups.getSnapshot()).toEqual([])
  })

  it('publishes the namespace read and tells its own readers', async () => {
    const { ctx, scope } = await mountPlugin({ view: { namespaces: [] } })
    const face = pillFaceOf(ctx)

    // The rates are not this half's to write: the Plugins page owns the row
    // entry's form, and the page writes through it. What this half owns is the
    // read the two pills bind, and this is the source the renderer hands them;
    // the page's own face carries no such read because it never binds one.

    // The scope stub stands in for the transport: what this package owns is the
    // source it hands the renderer, and that a publication reaches it.
    const notified: number[] = []
    const off = face.hooks.billing.subscribe(() => { notified.push(1) })
    scope.publish(snapshot({ value: { currency: 'USD', models: {}, cache: null, cacheError: null } }))
    off()
    expect(notified).toHaveLength(1)
    expect(face.hooks.billing.getSnapshot().value?.currency).toBe('USD')
  })
})

describe('rate write operations', () => {
  it('writes the peak band alone when no second band was typed', () => {
    expect(rateOps('a/b', { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' }, {}, undefined)).toEqual([
      { op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0.15 },
      { op: 'set', path: ['models', 'a/b', 'cacheMiss'], value: 4.5 },
      { op: 'set', path: ['models', 'a/b', 'output'], value: 13.5 },
    ])
  })

  it('writes a second band under its own path', () => {
    // The blank field inside a typed band is a zero, and the band is written as
    // a whole because the row carries none yet.
    expect(rateOps(
      'a/b',
      { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' },
      { cacheHit: '0.075', output: '6.75' },
      undefined,
    )).toEqual([
      { op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0.15 },
      { op: 'set', path: ['models', 'a/b', 'cacheMiss'], value: 4.5 },
      { op: 'set', path: ['models', 'a/b', 'output'], value: 13.5 },
      { op: 'set', path: ['models', 'a/b', 'offPeak', 'cacheHit'], value: 0.075 },
      { op: 'set', path: ['models', 'a/b', 'offPeak', 'output'], value: 6.75 },
    ])
  })

  it('clears the stored second band when every off-peak field is emptied', () => {
    expect(rateOps(
      'a/b',
      { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' },
      {},
      { cacheHit: 1, cacheMiss: 2, output: 3, offPeak: { cacheHit: 0.5, cacheMiss: 1, output: 1.5 } },
    )).toEqual([
      { op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0.15 },
      { op: 'set', path: ['models', 'a/b', 'cacheMiss'], value: 4.5 },
      { op: 'set', path: ['models', 'a/b', 'output'], value: 13.5 },
      { op: 'unset', path: ['models', 'a/b', 'offPeak'] },
    ])
  })

  it('leaves a field the user never touched alone', () => {
    // Only typed figures are written: blanking a field is not a way to store a
    // zero, and opening a row and saving it unchanged writes what it showed.
    expect(rateOps('a/b', { cacheHit: '0.15' }, {}, { cacheHit: 1, cacheMiss: 2, output: 3 }))
      .toEqual([{ op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0.15 }])
    expect(rateOps('a/b', { cacheHit: '0' }, {}, undefined))
      .toEqual([{ op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0 }])
  })

  it('reads an emptied row as its removal rather than a row of zeroes', () => {
    expect(rateOps('a/b', {}, {}, undefined)).toEqual([{ op: 'unset', path: ['models', 'a/b'] }])
    expect(rateOps('a/b', {}, {}, { cacheHit: 1, cacheMiss: 2, output: 3 }))
      .toEqual([{ op: 'unset', path: ['models', 'a/b'] }])
  })

  it('writes nothing at all for text that does not parse', () => {
    // A mistyped figure must not change the document, and in particular must
    // not delete the stored row behind it.
    expect(rateOps('a/b', { cacheHit: 'four' }, {}, { cacheHit: 1, cacheMiss: 2, output: 3 })).toEqual([])
    expect(rateOps('a/b', { cacheHit: 'four', cacheMiss: '4.5', output: '13.5' }, {}, undefined))
      .toEqual([
        { op: 'set', path: ['models', 'a/b', 'cacheMiss'], value: 4.5 },
        { op: 'set', path: ['models', 'a/b', 'output'], value: 13.5 },
      ])
  })

  it('trims the typed text before reading it', () => {
    expect(rateOps('a/b', { cacheHit: ' 0.15 ' }, {}, undefined))
      .toEqual([{ op: 'set', path: ['models', 'a/b', 'cacheHit'], value: 0.15 }])
    // Whitespace alone is an empty field, so a form holding only spaces is the
    // same request as one holding nothing.
    expect(rateOps('a/b', { cacheHit: '   ' }, {}, undefined)).toEqual([{ op: 'unset', path: ['models', 'a/b'] }])
  })
})

describe('shared helpers', () => {
  it('aggregates accumulated stretches per route and window', () => {
    const buckets = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
    const banded = { ...FLASH_RATES, offPeak: { cacheHit: 0.075, cacheMiss: 2.25, output: 6.75 } }
    expect(groupSteps([
      { route: 'a/b', at: AT, buckets },
      { route: 'a/b', at: AT, buckets },
      { route: 'x/y', at: AT, buckets },
    ], { 'a/b': FLASH_RATES })).toEqual([
      { route: 'a/b', window: 'peak', tokens: 2_000_000, cost: 9, priced: true },
      { route: 'x/y', window: 'peak', tokens: 1_000_000, cost: 0, priced: false },
    ])
    // A route that publishes two prices gets one row per window it was billed
    // in, each priced at its own band.
    const offPeakAt = Date.UTC(2024, 0, 1, 4, 0)
    expect(groupSteps([
      { route: 'a/b', at: AT, buckets },
      { route: 'a/b', at: offPeakAt, buckets },
    ], { 'a/b': banded })).toEqual([
      { route: 'a/b', window: 'peak', tokens: 1_000_000, cost: 4.5, priced: true },
      { route: 'a/b', window: 'offPeak', tokens: 1_000_000, cost: 2.25, priced: true },
    ])
  })

  it('formats relative freshness through the dictionary', () => {
    expect(freshness(Date.now(), t)).toBe('just now')
    expect(freshness(Date.now() - 2 * 3_600_000, t)).toBe('2 h ago')
    expect(freshness(Date.now() - 3 * 86_400_000, t)).toBe('3 d ago')
  })

  it('exposes one bound scope per namespace key', () => {
    const stub: StubConfigForm<BillingSettings> = stubConfigForm<BillingSettings>()
    expect(stub.scope.getSnapshot().status).toBe('loading')
    expect(NS).toBe('ui-billing')
  })
})
