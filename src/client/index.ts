/**
 * Billing plugin, browser half: the session and turn cost pills over the
 * shipped chat surfaces, and the Billing settings page that owns the rates.
 *
 * All three surfaces read one value — the `ui-billing` settings namespace —
 * and price tokens the provider already reported. Nothing here calls a model
 * or adds a request; unmounting the plugin removes every pill and the page.
 *
 * The apply closure owns every ctx read: the bound scope reaches components as
 * a `useBilling` selector hook through the `hooks` compartment, and the provider
 * directory reaches the settings page as the `routeGroups` callback. A
 * component therefore receives plain data and callbacks, never the context.
 *
 * The settings namespace and the copy dictionary are distinct facts and are
 * named apart: a single shared identifier binds the scope to the dictionary,
 * which reads as an unregistered namespace and leaves every surface empty.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NS, type BillingSettings } from '../settings.ts'
import type { BillingInjected } from './face.ts'
import { LOCALE_NS, en, zh, type BillingKey, type BillingTranslate } from './locales.ts'
import { rateOps } from './rate-ops.ts'
import { providerRoutes, type ProviderRouteGroup } from './routes.ts'
import { SessionCostMeter } from './CostMeter.tsx'
import { TurnCostMeter } from './TurnCostMeter.tsx'
import { BillingSection } from './SettingsSection.tsx'

export type { BillingSectionProps } from './SettingsSection.tsx'
export type { SessionCostMeterProps } from './CostMeter.tsx'
export type { TurnCostMeterProps } from './TurnCostMeter.tsx'
export type { BillingInjected } from './face.ts'
export type { BillingKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Billing pill, dialog, and settings copy. */
    billing: BillingKey
  }
}

/** Required services: the slot ledger, copy dictionaries, and the settings transport. */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.llm']

/**
 * Register the dictionaries, the settings page, and the two cost pills.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-billing: copy dictionaries')
  const scope = ctx.settingsScope.bind<BillingSettings>({ namespace: NS })
  // The nav label is registration-time text, so it reads the bound translate
  // directly; every component takes the framework's own `t` seat instead.
  const t: BillingTranslate = ctx.locale.bind(LOCALE_NS)
  const groups = createSnapshotStore<readonly ProviderRouteGroup[]>([])

  /**
   * Read the provider directory and the settings mirror into route groups.
   *
   * Both reads belong to the apply world: the directory arrives over
   * `ctx.remote.llm`, and the mirror is the shared describe face every settings
   * surface derives from. A failed read keeps the previous answer.
   * @returns settlement after the store publishes.
   */
  const routeGroups = async (): Promise<void> => {
    const describe = ctx.settingsScope.describe()
    const [registered, directory] = await Promise.all([
      ctx.remote.llm.listProviders(),
      ctx.remote.llm.listConfigurableProviders(),
    ])
    if (!registered.ok || !directory.ok) return
    await describe.ensure()
    const view = describe.getSnapshot().view
    if (view === undefined) return
    groups.set(directory.value.length === 0 && registered.value.length === 0
      ? []
      : providerRoutes(directory.value, registered.value, view.namespaces.map(entry => ({
        ns: entry.ns,
        value: entry.value,
        ...entry.user === undefined ? {} : { user: entry.user },
      }))))
  }

  // The two signals that can move the directory, subscribed where the reads
  // live. Neither the subscription nor the plugin starts a load: the Billing
  // page asks when it opens, and a signal only refreshes a list that already has
  // an answer, so mounting this plugin issues no request until someone looks.
  ctx.effect(() => {
    const refresh = (): void => {
      if (groups.getSnapshot().length === 0) return
      void routeGroups()
    }
    const disposers = [
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ui-billing: provider directory invalidations')

  /**
   * Write one route's rates, or drop the row when the user emptied it.
   * @param route - the `provider/model` key to write.
   * @param peak - typed peak-window values by field name.
   * @param offPeak - typed off-peak-window values by field name.
   * @returns settlement after the namespace commits the change.
   */
  const saveRate = async (
    route: string,
    peak: Readonly<Record<string, string>>,
    offPeak: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const ops = rateOps(route, peak, offPeak, scope.getSnapshot().value?.models[route])
    // No operations means the typed text described no change: a figure that
    // does not parse writes nothing rather than clearing the stored row.
    if (ops.length > 0) await scope.mutate(ops)
  }

  /**
   * Remove one stored rate row.
   * @param route - the `provider/model` key to clear.
   * @returns settlement after the namespace commits the change.
   */
  const clearRate = async (route: string): Promise<void> => {
    await scope.mutate([{ op: 'unset', path: ['models', route] }])
  }

  /**
   * Ask the Host to read the published price page now.
   *
   * The automatic read is long-spaced, so this is how the page asks for one
   * sooner: the request is a settings write because that document is the one
   * store both halves share. The Host clears the field when the read settles,
   * which is what the page reads as that read being in flight.
   * @returns settlement after the namespace records the request.
   */
  const refreshPrices = async (): Promise<void> => {
    await scope.mutate([{ op: 'set', path: ['officialRequest'], value: Date.now() }])
  }

  const injected = (): BillingInjected => ({
    hooks: {
      billing: {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: listener => scope.subscribe(listener),
      },
      billingGroups: {
        getSnapshot: () => groups.getSnapshot(),
        subscribe: listener => groups.subscribe(listener),
      },
    },
    routeGroups,
    saveRate,
    clearRate,
    refreshPrices,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'billing',
    // After every shipped section: the nav reads general, models, plugins,
    // agent presets, then the rates.
    order: 30,
    label: () => t('section.label'),
    locale: LOCALE_NS,
    inject: injected,
  }, BillingSection))

  // The shipped stats row owns the line these figures belong to, so the row's
  // own trailing hole is the seat: it centres them with the pills they extend.
  ctx.slots.inject('conversation.composer.stats', () => ctx.slots.register({
    name: 'conversation.composer.stats',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injected,
  }, SessionCostMeter))

  // The completed Turn's own action row owns the line these figures belong to,
  // so its trailing figures hole is the seat: the cost pill lands after the
  // shipped Turn-usage and Turn-time pills, inside the same row and the same
  // cluster. A list, not the tail chain above it — the chain elects one entry,
  // so a Turn that also produced files would lose its cost.
  ctx.slots.inject('conversation.chat.turn-stats', () => ctx.slots.register({
    name: 'conversation.chat.turn-stats',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injected,
  }, TurnCostMeter))
}
