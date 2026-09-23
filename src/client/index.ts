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
// Type-only: pulls the conversation composer slot family this plugin's session
// figures are seated on ('conversation.composer.dock').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the chat contract the per-Turn pill is seated on
// ('conversation.chat.turnTail' and its owner share).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the Plugins page's SlotMap merge (the 'plugins.row.config'
// entry this package's own configuration page registers into).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NS, type BillingSettings } from '../settings.ts'
import type { BillingPageInjected, BillingPillsInjected } from './face.ts'
import { LOCALE_NS, en, zh, type BillingKey } from './locales.ts'
import { providerRoutes, type ProviderRouteGroup } from './routes.ts'
import { SessionCostMeter } from './CostMeter.tsx'
import { TurnCostMeter } from './TurnCostMeter.tsx'
import { BillingPage } from './BillingPage.tsx'

export type { BillingPageProps } from './BillingPage.tsx'
export type { SessionCostMeterProps } from './CostMeter.tsx'
export type { TurnCostMeterProps } from './TurnCostMeter.tsx'
export type { BillingPageInjected, BillingPillsInjected } from './face.ts'
export type { BillingKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Billing pill, dialog, and configuration-page copy. */
    billing: BillingKey
  }
}

/**
 * The `plugins.row.config` key of this package's own row.
 *
 * The key is `<package name>#<row id>`, and this package keeps its row id equal
 * to {@link NS}: the Host serves the configuration entry under the row id, so
 * the page owner resolves exactly this entry's form, and a document written
 * before the move to Profile configuration is imported into the same id.
 */
export const BILLING_ROW_CONFIG_KEY = `@deepseek-ai/dsh-client-ui-billing#${NS}`

/** Required services: the slot ledger, copy dictionaries, and the configuration form. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.llm']

/**
 * Register the dictionaries, the settings page, and the two cost pills.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-billing: copy dictionaries')
  const scope = ctx.configForms.get<BillingSettings>(NS)
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
    const describe = ctx.configForms.describe()
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

  const injectedPills = (): BillingPillsInjected => ({
    hooks: {
      billing: {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: listener => scope.subscribe(listener),
      },
    },
  })

  const injectedPage = (): BillingPageInjected => ({
    hooks: {
      billingGroups: {
        getSnapshot: () => groups.getSnapshot(),
        subscribe: listener => groups.subscribe(listener),
      },
    },
    routeGroups,
  })

  // The Plugins page hosts a plugin's configuration, so the rates page is this
  // package's own row entry rather than a Settings section: a plugin page
  // registers into its bundle row while the Host serves the entry, and the page
  // owner hands the page that entry's form. The page is the custom-page case the
  // configuration contract documents — its rows are one rate field per route and
  // price window, a shape the shared scalar field kit does not express — so it
  // reads `form.state` and writes through `form.mutate`.
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: BILLING_ROW_CONFIG_KEY,
    locale: LOCALE_NS,
    inject: injectedPage,
  }, BillingPage))

  // The composer's ambient dock owns the line these figures belong to, so the
  // dock's own list is the seat: the shipped stats row sits there too, and the
  // figures join it as one more ambient entry under the composer card.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injectedPills,
  }, SessionCostMeter))

  // A completed Turn's tail is the seat: it is the list of feature
  // contributions before that Turn's action row, and its owner share already
  // carries the Turn, the closing sequence, and the file opener this pill
  // prices and opens. The shipped Turn-usage and Turn-time triggers sit in the
  // action row below, so the cost reading stays a tail contribution rather than
  // a second action.
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injectedPills,
  }, TurnCostMeter))
}
