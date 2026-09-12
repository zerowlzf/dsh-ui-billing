/**
 * Route discovery for the Billing settings page.
 *
 * The page lists the models the user actually configured, so it reads the same
 * facts the Models page joins: the registered provider routes (with their
 * settings address) and the profile stored at that address. Model ids come out
 * of that profile rather than out of a new Host API, because the profile is
 * what the adapter itself resolves; whether a provider is configured at all
 * comes from the user layer of its settings namespace, which is the same
 * question the Models page answers with its credential and profile reads.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/routes
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'

/** One provider row the page renders. */
export interface ProviderRouteGroup {
  /** Provider route id (`deepseek-official`, `bai`, …). */
  readonly provider: string
  /** Display name the provider registered. */
  readonly displayName: string
  /** Model ids read from the provider's own settings profile. */
  readonly models: readonly string[]
  /** Whether the profile exposes models at all; `false` asks the user to add routes by hand. */
  readonly modelsReadable: boolean
  /** Whether this route is the official DeepSeek provider. */
  readonly official: boolean
  /**
   * Whether the user layer configures this provider, or the adapter serves it
   * without configuration. An unconfigured catalogue entry carries no models to
   * price, so the page leaves it out.
   */
  readonly configured: boolean
}

/** Provider route id of the shipped DeepSeek adapter. */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/** Settings namespace the shipped DeepSeek adapter owns. */
const OFFICIAL_SETTINGS_NS = 'llm-deepseek'

/**
 * Read the model ids out of one provider profile value.
 *
 * A provider profile declares its models as an array of objects carrying an
 * `id`; this reads exactly that field and ignores every other model property.
 * @param profile - the value stored at the provider's settings address.
 * @returns model ids in declaration order; an empty list when the profile shape carries none.
 */
export function modelIdsOf(profile: unknown): string[] {
  if (typeof profile !== 'object' || profile === null) return []
  const models = (profile as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as Record<string, unknown>)['id']
    if (typeof id !== 'string' || id.length === 0) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Walk a settings value to one path.
 * @param value - the namespace's resolved value.
 * @param path - settings path from the provider directory entry.
 * @returns the value at that path, or undefined when any segment is absent.
 */
export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** One provider route as the provider directory reports it. */
interface DirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}

/** One settings namespace as the describe mirror reports it. */
interface NamespaceView {
  readonly ns: string
  /** Resolved value across every layer, base and shipped defaults included. */
  readonly value: unknown
  /** The user layer alone, absent when the document configures nothing here. */
  readonly user?: unknown
}

/**
 * Whether the user layer names this provider's profile.
 *
 * A directory entry without a settings address cannot be answered this way and
 * reports `undefined`, which leaves the caller to decide from other evidence.
 * @param entry - directory row carrying the provider's settings address.
 * @param namespaces - namespace views keyed by namespace name.
 * @returns whether the profile exists in the user layer, or undefined when the address is unusable.
 */
function userConfigures(
  entry: DirectoryEntry,
  namespaces: ReadonlyMap<string, NamespaceView>,
): boolean | undefined {
  if (entry.settingsNs === '' || entry.settingsPath.length === 0) return undefined
  const view = namespaces.get(entry.settingsNs)
  if (view === undefined) return undefined
  if (view.user === undefined) return false
  return valueAtPath(view.user, entry.settingsPath) !== undefined
}

/**
 * Join the provider directory with the settings values their profiles live in.
 * @param directory - `llm/listConfigurableProviders()` rows.
 * @param registered - `llm/listProviders()` rows (live routes, name only).
 * @param namespaces - the settings describe mirror's namespace views.
 * @returns one group per provider, directory order first.
 */
export function providerRoutes(
  directory: readonly DirectoryEntry[],
  registered: readonly { readonly id: string; readonly name: string }[],
  namespaces: readonly NamespaceView[],
): ProviderRouteGroup[] {
  const views = new Map(namespaces.map(view => [view.ns, view]))
  const live = new Set(registered.map(provider => provider.id))
  const groups: ProviderRouteGroup[] = []
  const seen = new Set<string>()
  for (const entry of directory) {
    seen.add(entry.provider)
    const view = views.get(entry.settingsNs)
    const profile = view === undefined ? undefined : valueAtPath(view.value, entry.settingsPath)
    const models = modelIdsOf(profile)
    groups.push({
      provider: entry.provider,
      displayName: entry.displayName,
      models,
      modelsReadable: profile !== undefined,
      official: entry.provider === OFFICIAL_PROVIDER || entry.settingsNs === OFFICIAL_SETTINGS_NS,
      // A catalogue row the user never configured carries nothing to price. A
      // live route is configured by definition — the adapter registered it —
      // and a base-layer profile is a deployment choice, so both stay listed.
      configured: userConfigures(entry, views) === true || live.has(entry.provider) || profile !== undefined,
    })
  }
  for (const provider of registered) {
    if (seen.has(provider.id)) continue
    groups.push({
      provider: provider.id,
      displayName: provider.name,
      models: [],
      modelsReadable: false,
      official: provider.id === OFFICIAL_PROVIDER,
      configured: true,
    })
  }
  return groups
}
