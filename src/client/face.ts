/**
 * The plugin's injected business face, named apart from the client entry so a
 * component can type against it without importing the module that imports the
 * component: only types cross this edge, and the module graph stays acyclic.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/face
 */

import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BillingSettings } from '../settings.ts'
import type { ProviderRouteGroup } from './routes.ts'

/**
 * The two cost pills' injected face: the read they bind.
 *
 * The pills show figures the Host already wrote into the entry, so they take
 * nothing but that read. Keeping each surface's face to what it uses is what
 * lets the page below declare no selector hook it never reads.
 */
export interface BillingPillsInjected {
  /** Reactive sources are bound by the renderer into `use<Name>` selector hooks. */
  hooks: {
    /** The `ui-billing` namespace form snapshot. */
    billing: { getSnapshot: () => ConfigFormSnapshot<BillingSettings>; subscribe: (fn: () => void) => () => void }
  }
}

/**
 * The configuration page's injected face: the directory it lists.
 *
 * The rates are not this half's to write — the Plugins page owns the row
 * entry's form and hands it to the page — so the page's face carries only the
 * read the page cannot perform itself: the provider directory, which arrives
 * over `ctx.remote.llm` inside the apply closure.
 */
export interface BillingPageInjected {
  /** Reactive sources are bound by the renderer into `use<Name>` selector hooks. */
  hooks: {
    /** The provider groups the plugin loaded. */
    billingGroups: {
      getSnapshot: () => readonly ProviderRouteGroup[]
      subscribe: (fn: () => void) => () => void
    }
  }
  /**
   * Ask the plugin to reload the provider directory.
   * @returns settlement after the load publishes, whatever it found.
   */
  routeGroups: () => Promise<void>
}
