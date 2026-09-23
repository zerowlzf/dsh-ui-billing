// Billing configuration page on the Plugins page: the DeepSeek account balance
// the Host reads, the published price table it reads, then one card per provider
// the user actually configured. A card is closed by default and shows the models its rates apply
// to, the way the Models page shows a provider; the price fields appear behind
// its edit control, one row per price window. Rates are per million tokens in
// the account's currency, which is the unit the provider bills in.
//
// The page is a custom configuration page: the Plugins page owns this entry's
// form and hands it over as `form`, so an edit is staged here and one save
// writes every staged write through `form.mutate`. The shared scalar field kit
// cannot express this page's rows — one rate field per route and price window,
// over a map keyed by `provider/model` — which is the custom-page case the
// configuration contract documents.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, SettingsForm, type SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_CURRENCY, parseRate, priceWindowAt, RATE_FIELDS, ROUTE_SEPARATOR, splitRouteKey,
  type BillingSettings, type ModelRate, type PriceSnapshot, type PriceWindow,
  type RateBand, type RateField,
} from '../settings.ts'
import { OFFICIAL_PROVIDER, type ProviderRouteGroup } from './routes.ts'
import type { BillingPageInjected } from './face.ts'
import { ageOf, balanceFailureText, formatBalance, priceFailureText, windowKey } from './format.ts'
import { currencyOf } from './CostMeter.tsx'
import { rateOps } from './rate-ops.ts'
import { IconCoinOutline16, IconWalletOutline16 } from './icons.tsx'
import { LOCALE_NS, type BillingKey } from './locales.ts'
import { defaultRateOf, effectiveRates } from './official-rates.ts'
import css from './BillingPage.module.css'

/** One editable rate field. */
type Field = RateField

/** Dictionary key of one field's label. */
const FIELD_KEYS: Readonly<Record<Field, BillingKey>> = {
  cacheHit: 'section.rateHit',
  cacheMiss: 'section.rateMiss',
  output: 'section.rateOutput',
}

/** Both price windows, in the order the fields are rendered. */
const BANDS: readonly PriceWindow[] = ['peak', 'offPeak']

/**
 * How long a price read the page asked for keeps reading as in flight.
 *
 * The Host clears the request when its read settles, and a read is bounded by
 * the plugin's own request deadline; a request older than this belongs to a Host
 * that never got to it — it was replaced while the read was pending — so the
 * control is offered again rather than staying disabled forever.
 */
const REQUEST_STALE_MS = 60_000

/** Draft text keyed `provider/model\u0000window\u0000field`. */
type Drafts = ReadonlyMap<string, string>

/** Compose the draft key for one field of one window. */
function draftKey(route: string, band: PriceWindow, field: Field): string {
  return `${route}\u0000${band}\u0000${field}`
}

/** One window's rates out of a stored or published row. */
function bandOf(rate: ModelRate | undefined, band: PriceWindow): RateBand | undefined {
  if (rate === undefined) return undefined
  return band === 'peak' ? rate : rate.offPeak
}

/** One field's stored value, as display text. */
function rateText(band: RateBand | undefined, field: Field): string {
  if (band === undefined) return ''
  const value = band[field]
  return value === 0 ? '0' : String(value)
}

/**
 * The published figure one field shows as its placeholder.
 *
 * The off-peak fields of a route whose published price states one band stay
 * empty: an empty band means the route charges that window's price at every
 * hour, which is what a provider with a single price does.
 */
function defaultText(route: string, band: PriceWindow, field: Field, published: PriceSnapshot | null): string {
  return rateText(bandOf(defaultRateOf(route, published), band), field)
}

/**
 * Props of the Billing configuration page: the page slot's runtime share (the
 * view the owner asks for and the entry's own form), the plugin's injected face
 * (the directory read and its loader), and the page's locale seat. Every ctx
 * read belongs to the plugin's apply closure; this component receives data and
 * callbacks only, and the rates it edits travel back through `form.mutate`.
 */
export type BillingPageProps =
  & PropsRuntime<'plugins.row.config'>
  & InjectFace<BillingPageInjected>
  & PropsLocale<typeof LOCALE_NS>

/**
 * Render the Billing configuration page: its one-liner, or the balance card and
 * one card per configured provider.
 * @param props - the view asked for, the entry's form, the group hook, the locale, and the loader.
 * @returns the one-liner, or the page.
 */
export function BillingPage({
  view, form, useBillingGroups, t, routeGroups,
}: BillingPageProps) {
  const snapshot = form?.state
  // The entry's own section; this page is what knows its shape.
  const settings = snapshot?.value as BillingSettings | undefined
  const [drafts, setDrafts] = useState<Drafts>(() => new Map())
  // Routes staged for removal: a stored row goes away on save, not on the click.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  // Two inputs name a route by hand — one inside an open provider card, one on
  // the page's own entry card — and each keeps its own typed text and its own
  // error: one shared state would mirror every keystroke into the other input.
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState(false)
  const [manualEntry, setManualEntry] = useState('')
  const [manualEntryError, setManualEntryError] = useState(false)
  // One provider card is open at a time: the page shows what the rates apply to
  // (the models the user configured), and the fields appear on demand.
  const [editing, setEditing] = useState<string | undefined>(undefined)
  // Routes whose second band this page shows although their provider does not
  // bill by window. The data model carries a second band for any route, and this
  // is the control that reaches it, so a provider that starts pricing by window
  // can be priced here before its published table states the second band.
  const [banded, setBanded] = useState<ReadonlySet<string>>(() => new Set())
  const writable = snapshot?.writable ?? false
  const rates = settings?.models ?? {}
  const published = settings?.official ?? null
  // What a route is actually billed at: the stored row, or the published price
  // it falls back to. The page edits the first and shows the second as the
  // field's placeholder.
  const priced = effectiveRates(settings?.models, published)
  const balance = settings?.cache ?? null
  const requestedAt = settings?.officialRequest ?? null
  // The Host clears the request with the read's own settlement, so a request the
  // page made reads as that read being in flight until then.
  const pending = requestedAt !== null && Date.now() - requestedAt < REQUEST_STALE_MS
  const loaded = useBillingGroups(groups => groups)
  // The window in force as this page renders, named so the two rows of fields
  // are read against the figure the provider is charging right now.
  const window: PriceWindow = priceWindowAt(Date.now())
  // Routes typed on this page that no directory declares and no stored row
  // covers yet, by provider. They keep their card (and their row) open until a
  // save turns them into stored rates.
  const [drafted, setDrafted] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())

  // The plugin owns the reads and the invalidations that refresh them; this
  // effect only asks for one load, so opening the page never waits on a
  // directory read the plugin already started at mount.
  useEffect(() => { void routeGroups() }, [routeGroups])

  // Every provider card the page shows: the ones the user configured (or that
  // the adapter serves without configuration), plus any provider a stored rate
  // row or a route typed here names, so a route whose provider went away stays
  // editable and clearable. A catalogue row nobody configured carries nothing to
  // price and is left out. A configured provider with no readable model list
  // still gets its card — that is where its routes are added by hand.
  const cards = useMemo(() => {
    const storedRoutes = Object.keys(rates)
    const byProvider = new Map<string, string[]>()
    for (const group of loaded) {
      const covered = storedRoutes.filter(key =>
        key.startsWith(`${group.provider}${ROUTE_SEPARATOR}`))
      const typed = drafted.get(group.provider) ?? []
      if (!group.configured && covered.length === 0 && typed.length === 0) continue
      const models = [...group.models, ...typed]
      for (const key of covered) {
        const model = key.slice(group.provider.length + 1)
        if (!models.includes(model)) models.push(model)
      }
      byProvider.set(group.provider, models)
    }
    for (const [provider, models] of drafted) {
      if (byProvider.has(provider)) continue
      byProvider.set(provider, [...models])
    }
    for (const key of storedRoutes) {
      const route = splitRouteKey(key)
      if (route === undefined || byProvider.has(route.provider)) continue
      byProvider.set(route.provider, [route.model])
    }
    return [...byProvider]
  }, [loaded, drafted, rates])

  const nameOf = (provider: string): string =>
    loaded.find(group => group.provider === provider)?.displayName ?? provider

  /** Providers this page shows, in card order: the directory's, then typed ones. */
  const groupOf = (provider: string): ProviderRouteGroup | undefined =>
    loaded.find(group => group.provider === provider)
    ?? (drafted.has(provider)
      ? { provider, displayName: provider, models: [], modelsReadable: true, official: false, configured: true }
      : undefined)

  const valueOf = (route: string, band: PriceWindow, field: Field): string =>
    drafts.get(draftKey(route, band, field)) ?? rateText(bandOf(rates[route], band), field)

  /** The typed values of one window, field by field. */
  const typedBand = (route: string, band: PriceWindow): Record<string, string> => {
    const typed: Record<string, string> = {}
    for (const field of RATE_FIELDS) typed[field] = valueOf(route, band, field)
    return typed
  }

  /** Drop one route's drafts, both windows at once. */
  const dropDrafts = (route: string): void => {
    setDrafts((current) => {
      const next = new Map(current)
      for (const band of BANDS) {
        for (const field of RATE_FIELDS) next.delete(draftKey(route, band, field))
      }
      return next
    })
  }

  /**
   * Write every staged edit through the entry's form.
   *
   * A save is the page's only write, as the configuration contract requires:
   * every staged row removal goes first, then every route whose fields were
   * edited, each field converted by the same operation builder the plugin's own
   * write used. Nothing is staged once the Host accepts, so the page re-seeds
   * from the accepted value.
   */
  const save = async (): Promise<void> => {
    /* v8 ignore next -- the shell renders no save control for a page it handed no form, so this guard only keeps the handler total. */
    if (form === undefined) return
    const ops: SettingsPathOpView[] = []
    for (const route of removed) ops.push({ op: 'unset', path: ['models', route] })
    for (const route of stagedRoutes()) {
      ops.push(...rateOps(route, typedBand(route, 'peak'), typedBand(route, 'offPeak'), rates[route]))
    }
    /* v8 ignore next -- the shell saves only a staged, valid edit, and both staged shapes produce an operation. */
    if (ops.length === 0) return
    setSaving(true)
    setFailed(false)
    try {
      const accepted = await form.mutate([...ops], form.state.revision)
      if (accepted) discard()
      else setFailed(true)
    } catch {
      // A transport failure rejects rather than answering; the drafts stay so
      // the user can save again.
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  /** Drop every staged edit. */
  const discard = (): void => {
    setDrafts(new Map())
    setRemoved(new Set())
  }

  /**
   * Remove one stored row: staged, so the page's save writes it with everything else.
   * @param route - the `provider/model` key to remove.
   */
  const clear = (route: string): void => {
    dropDrafts(route)
    setRemoved(current => new Set(current).add(route))
  }

  /** Routes with at least one staged field. */
  const stagedRoutes = (): ReadonlySet<string> => {
    const routes = new Set<string>()
    for (const key of drafts.keys()) {
      /* v8 ignore next -- a draft key is composed from a route and two more segments, so its first segment is always present. */
      routes.add(key.split('\u0000')[0] ?? '')
    }
    return routes
  }

  /** Whether a staged draft holds text this page cannot store. */
  const invalid = [...drafts.values()].some(text => text.trim() !== '' && parseRate(text) === undefined)

  const shell: SettingsFormShell = {
    available: form !== undefined,
    writable,
    dirty: drafts.size > 0 || removed.size > 0,
    invalid,
    saving,
    failed,
  }

  const labels: SettingsFormLabels = {
    unavailable: t('form.unavailable'),
    readOnly: t('section.writable'),
    saveFailed: t('form.saveFailed'),
    save: t('section.save'),
    saving: t('section.saving'),
  }

  /**
   * Ask the Host to read the published price page now.
   *
   * The request is the one write this page makes outside its save, because it
   * is a command rather than a field: the Host clears the field with that
   * read's own settlement, and the card shows the read in flight until then.
   */
  const reread = async (): Promise<void> => {
    /* v8 ignore next -- the card offers no read control while the entry is unserved, so this guard only keeps the handler total. */
    if (form === undefined) return
    setFailed(false)
    try {
      const accepted = await form.mutate(
        [{ op: 'set', path: ['officialRequest'], value: Date.now() }], form.state.revision,
      )
      // A refused write answers rather than rejecting, and it says so here: a
      // request that never reached the Host would otherwise look asked-for.
      if (!accepted) setFailed(true)
    } catch {
      setFailed(true)
    }
  }

  /**
   * Add the route typed into one of the page's two inputs.
   * @param source - the input that submitted: an open provider card's, or the page's own.
   */
  const addManual = (source: 'card' | 'entry'): void => {
    const typed = (source === 'card' ? manual : manualEntry).trim()
    const at = typed.indexOf(ROUTE_SEPARATOR)
    if (at <= 0 || at === typed.length - 1) {
      if (source === 'card') setManualError(true)
      else setManualEntryError(true)
      return
    }
    if (source === 'card') setManualError(false)
    else setManualEntryError(false)
    if (source === 'card') setManual('')
    else setManualEntry('')
    // The typed route joins the page's own model list for the provider it names,
    // so its row exists to be priced before anything is stored; the card then
    // stays while its price is unsaved.
    const provider = typed.slice(0, at)
    const model = typed.slice(at + 1)
    setDrafted((current) => {
      const models = current.get(provider) ?? []
      if (models.includes(model)) return current
      const next = new Map(current)
      next.set(provider, [...models, model])
      return next
    })
    setEditing(provider)
  }

  /**
   * One window's three fields.
   *
   * `windowName` is the localized window the fields belong to, and it is left
   * undefined for a provider that prices one figure at every hour: those rows
   * carry no window to name, and labelling them would promise a second band
   * this provider does not bill.
   */
  const fieldRow = (route: string, band: PriceWindow, windowName: string | undefined): ReactNode => (
    <div className={css.fields}>
      {RATE_FIELDS.map((field) => {
        const name = t(FIELD_KEYS[field])
        return (
          <label key={field} className={css.field}>
            <span className={css.fieldLabel}>{name}</span>
            <input
              className={css.input}
              type="text"
              inputMode="decimal"
              value={valueOf(route, band, field)}
              placeholder={band === 'offPeak'
                ? defaultText(route, band, field, published) || t('section.offPeakPlaceholder')
                : defaultText(route, band, field, published)}
              disabled={!writable}
              aria-label={windowName === undefined ? `${route} ${name}` : `${route} ${windowName} ${name}`}
              onChange={(event) => {
                const text = event.currentTarget.value
                setDrafts((current) => {
                  const next = new Map(current)
                  next.set(draftKey(route, band, field), text)
                  return next
                })
              }}
            />
          </label>
        )
      })}
    </div>
  )

  if (view === 'summary') return t('section.summary')

  return (
    <SettingsForm labels={labels} state={shell} onSave={() => { void save() }} onDiscard={discard}>
      <div className={css.page}>
        <p className={css.intro}>{t('section.intro')}</p>
        <section className={css.card} data-billing-balance-card>
          <header className={css.cardHead}>
            <span className={css.cardTitle}>
              <IconWalletOutline16 />
              {t('section.balanceTitle')}
            </span>
            <span className={css.cardValue}>
              {balance === null
                ? t('section.notRead')
                : formatBalance(balance.total, balance.currency)}
            </span>
          </header>
          <div className={css.cardMeta}>
            {balance !== null && (
              <span>{t('section.readAt', { time: freshness(balance.at, t) })}</span>
            )}
            {balance !== null && !balance.available && (
              <span className={css.warn}>{t('pill.dialog.availableNo')}</span>
            )}
            <span>{currencyOf(balance, settings?.currency ?? DEFAULT_CURRENCY)}</span>
          </div>
          {settings?.cacheError != null && (
            <div className={css.warn}>{balanceFailureText(settings.cacheError, t)}</div>
          )}
        </section>

        <section className={css.card} data-billing-official-card>
          <header className={css.cardHead}>
            <span className={css.cardTitle}>
              <IconCoinOutline16 />
              {t('section.officialTitle')}
            </span>
            <span className={css.cardEnd}>
              <span className={css.cardValue}>
                {published === null
                  ? t('section.notRead')
                  : t('section.modelCount', { count: Object.keys(published.models).length })}
              </span>
              {/* The automatic read is long-spaced, so the page asks for one when
                someone wants the figures now. */}
              <Button
                size="sm"
                variant="outline"
                disabled={!writable || pending}
                onClick={() => { void reread() }}
              >
                {pending ? t('section.reading') : t('section.readNow')}
              </Button>
            </span>
          </header>
          <div className={css.cardMeta}>
            {published !== null && (
              <span>{t('section.readAt', { time: freshness(published.at, t) })}</span>
            )}
            {published !== null && (
              <span>{t('section.officialSource', { source: sourceHost(published.source) })}</span>
            )}
          </div>
          {published === null && <div className={css.note}>{t('section.officialEmpty')}</div>}
          {settings?.officialError != null && (
            <div className={css.warn}>{priceFailureText(settings.officialError, t)}</div>
          )}
        </section>

        <section className={css.rates} data-billing-rates>
          <h3 className={css.sectionTitle}>{t('section.providers')}</h3>
          {cards.length === 0 && <p className={css.empty}>{t('section.providersEmpty')}</p>}
          {cards.map(([provider, models]) => {
            const group = groupOf(provider)
            const open = editing === provider
            // Only the official provider bills by time of day, so only its cards
            // carry a second band of fields.
            const byWindow = group?.official === true || provider === OFFICIAL_PROVIDER
            const pricedCount = models.filter(model =>
              priced[`${provider}${ROUTE_SEPARATOR}${model}`] !== undefined).length
            return (
              <div key={provider} className={css.card}>
                <header className={css.cardHead}>
                  <span className={css.cardTitle}>
                    {group === undefined ? provider : nameOf(provider)}
                    {group?.official === true && <span className={css.badge}>{t('section.officialBadge')}</span>}
                    {/* The summary is what the closed card carries: which models
                      the rates apply to, and how many of them are priced. */}
                    <span className={css.cardMeta}>
                      {group !== undefined && !group.modelsReadable
                        ? t('section.providerPathUnknown')
                        : t('section.modelCount', { count: models.length })}
                      {pricedCount > 0 && (
                        <span className={css.pricedBadge}>{t('section.pricedCount', { count: pricedCount })}</span>
                      )}
                    </span>
                  </span>
                  <span className={css.actions}>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={open}
                      aria-label={t(open ? 'section.collapseProvider' : 'section.editProvider', { provider })}
                      onClick={() => { setEditing(open ? undefined : provider) }}
                    >
                      {t(open ? 'section.collapse' : 'section.edit')}
                    </Button>
                  </span>
                </header>
                {open && (
                  <div className={css.models} data-billing-provider-models={provider}>
                    {/* The window rule belongs to the provider that bills by it,
                      so it is stated on that card rather than above every one. */}
                    {byWindow && (
                      <p className={css.note}>{t('section.windowNote', { window: t(windowKey(window)) })}</p>
                    )}
                    {models.map((model) => {
                      const route = `${provider}${ROUTE_SEPARATOR}${model}`
                      const onDefault = rates[route] === undefined && defaultRateOf(route, published) !== undefined
                      // Only a provider that bills by time of day carries two
                      // bands by default; another route gains them once it
                      // actually holds a second band, or on request.
                      const shown = byWindow
                      || banded.has(route)
                      || rates[route]?.offPeak !== undefined
                      || defaultRateOf(route, published)?.offPeak !== undefined
                      return (
                        <div key={route} className={css.row} data-billing-rate-row={route}>
                          <span className={css.modelName} title={model}>
                            {model}
                            {/* The row is billed at the published price until the
                              user stores one; the fields show it as a placeholder. */}
                            {onDefault && (
                              <span className={css.badge} title={t('section.defaultRateHint')}>
                                {t('section.defaultRate')}
                              </span>
                            )}
                          </span>
                          {shown
                            ? BANDS.map(band => (
                              <div key={band} className={css.band} data-billing-band={band}>
                                <span className={css.bandLabel}>{t(windowKey(band))}</span>
                                {fieldRow(route, band, t(windowKey(band)))}
                              </div>
                            ))
                            : (
                              <div className={css.singleBand}>
                                {fieldRow(route, 'peak', undefined)}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!writable}
                                  aria-label={t('section.revealOffPeakFor', { route })}
                                  onClick={() => {
                                    setBanded(current => new Set(current).add(route))
                                  }}
                                >
                                  {t('section.revealOffPeak')}
                                </Button>
                              </div>
                            )}
                          <div className={css.actions}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!writable || removed.has(route)}
                              onClick={() => { clear(route) }}
                            >
                              {t('section.clear')}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                    {models.length === 0 && <p className={css.empty}>{t('section.modelsEmpty')}</p>}
                    <div className={css.addRow}>
                      <input
                        className={css.input}
                        type="text"
                        value={manual}
                        placeholder={t('section.addPlaceholder')}
                        aria-label={t('section.addRouteTo', { provider })}
                        onChange={(event) => { setManual(event.currentTarget.value) }}
                        onKeyDown={(event) => { if (event.key === 'Enter') addManual('card') }}
                      />
                      <Button size="sm" variant="outline" onClick={() => { addManual('card') }}>{t('section.add')}</Button>
                    </div>
                    {manualError && <div className={css.warn}>{t('section.invalidRoute')}</div>}
                  </div>
                )}
              </div>
            )
          })}
          {/* The page's own entry point for a route no directory declares: it
            opens the provider it names, whose card then holds the row. */}
          <div className={css.card}>
            <header className={css.cardHead}>
              <span className={css.cardTitle}>{t('section.addRoute')}</span>
            </header>
            <div className={css.addRow}>
              <input
                className={css.input}
                type="text"
                value={manualEntry}
                placeholder={t('section.addPlaceholder')}
                aria-label={t('section.addRoute')}
                onChange={(event) => { setManualEntry(event.currentTarget.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') addManual('entry') }}
              />
              <Button size="sm" variant="outline" onClick={() => { addManual('entry') }}>{t('section.add')}</Button>
            </div>
            {manualEntryError && <div className={css.warn}>{t('section.invalidRoute')}</div>}
          </div>
        </section>

      </div>
    </SettingsForm>
  )
}

/** Relative freshness of one Host read. */
function freshness(at: number, t: BillingPageProps['t']): string {
  const age = ageOf(at, Date.now())
  switch (age.kind) {
    case 'justNow': return t('value.justNow')
    case 'minutes': return t('value.minutesAgo', { count: age.count })
    case 'hours': return t('value.hoursAgo', { count: age.count })
    case 'days': return t('value.daysAgo', { count: age.count })
  }
}

/**
 * Host of one read's source URL.
 * @param source - the URL the Host recorded for its read.
 * @returns the host, or the recorded value when it is not a URL the page can parse.
 */
function sourceHost(source: string): string {
  try {
    return new URL(source).host
  } catch {
    // An operator may configure a source without a scheme; showing it as
    // recorded still names where the figures came from.
    return source
  }
}
