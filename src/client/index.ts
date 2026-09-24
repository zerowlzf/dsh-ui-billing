/**
 * Billing plugin, browser half: the session and turn cost pills over the
 * shipped chat surfaces, and the Billing configuration page on the Plugins
 * page that owns the rates.
 *
 * All three surfaces read one value — the `ui-billing` configuration entry —
 * and price tokens the provider already reported. Nothing here calls a model
 * or adds a request; unmounting the plugin removes every pill and the page.
 *
 * The apply closure owns every ctx read: the bound scope reaches components as
 * a `useBilling` selector hook through the `hooks` compartment, and the provider
 * directory reaches the configuration page as the `routeGroups` callback. A
 * component therefore receives plain data and callbacks, never the context.
 *
 * The configuration entry and the copy dictionary are distinct facts and are
 * named apart: a single shared identifier binds the form to the dictionary,
 * which reads as an unserved entry and leaves every surface empty.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the configuration form service (ctx.configForms) and the
// shared form contract the pills and the page read.
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
import { TurnCostMeter, TurnCostMeterTail } from './TurnCostMeter.tsx'
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

/** Required services: the slot ledger, copy dictionaries, and the configuration form. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.llm']

/**
 * Register the dictionaries, the configuration page, and the two cost pills.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-billing: copy dictionaries')
  const t = ctx.locale.bind(LOCALE_NS)
  const scope = ctx.configForms.get<BillingSettings>(NS)
  const groups = createSnapshotStore<readonly ProviderRouteGroup[]>([])

  /**
   * Read the provider directory and the settings mirror into route groups.
   *
   * Both reads belong to the apply world: the directory arrives over
   * `ctx.remote.llm`, and the mirror is the shared describe face every
   * configuration surface derives from. A failed read keeps the previous answer.
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

  // The Plugins page lists a plugin's own configuration as a card in its
  // Official group, beside the settings pages the shipping plugins carry, and a
  // card opens the page. It is the seat this plugin's page can be reached from:
  // a row's own page needs the bundle row that declares it, and the shipped web
  // bundle is a built-in profile bundle the page leaves out of its list, so
  // nothing would lead there.
  //
  // The item id is the entry id the Host serves, so the page owner hands the
  // page that entry's form — the same staged-edit contract the page is written
  // against — and the card only appears while the Host serves the entry, the way
  // every other settings page mounts.
  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: NS,
    order: 50,
    label: () => t('item.title'),
    locale: LOCALE_NS,
    inject: injectedPage,
  }, BillingPage))), 'ui-billing: configuration page')

  // The composer's ambient dock owns the line these figures belong to, so the
  // dock's own list is the seat: the shipped stats row sits there too, and the
  // figures join it as one more ambient entry under the composer card. The
  // display order places them after that row, which is the shipped reading of
  // the session; registration order would put this plugin's figures first,
  // because both entries state order 0 and the plugin assembling later holds no
  // tie-break of its own.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'billing',
    order: 1,
    locale: LOCALE_NS,
    inject: injectedPills,
  }, SessionCostMeter))

  // A completed Turn's action row owns the line this reading belongs to: the
  // end-info list seats it after the shipped Turn-usage trigger and before the
  // row's clock, so the figure a Turn's accounting states reads beside the
  // usage figure it belongs with instead of on a line of its own. Sharing the
  // slot's owner share with the tail is what lets one component price either
  // seat: the Turn, its closing sequence, and the file opener.
  ctx.slots.inject('conversation.chat.turnEndInfo', () => ctx.slots.register({
    name: 'conversation.chat.turnEndInfo',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injectedPills,
  }, TurnCostMeter))

  // A Turn interrupted before any finalized text renders no action row at all —
  // no copy, no branch, no usage trigger, no clock — so the row seat has nothing
  // to join and the figure would vanish. The tail seat carries it for that case
  // alone: every Turn an action row already shows leaves this seat empty.
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injectedPills,
  }, TurnCostMeterTail))
}
