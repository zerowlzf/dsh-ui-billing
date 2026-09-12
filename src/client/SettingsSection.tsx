// Billing settings page: the DeepSeek account balance the Host reads, the
// published price table it reads, then one card per provider the user actually
// configured. A card is closed by default and shows the models its rates apply
// to, the way the Models page shows a provider; the price fields appear behind
// its edit control, one row per price window. Rates are per million tokens in
// the account's currency, which is the unit the provider bills in.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_CURRENCY, priceWindowAt, RATE_FIELDS, ROUTE_SEPARATOR, splitRouteKey,
  type ModelRate, type PriceSnapshot, type PriceWindow, type RateBand, type RateField,
} from '../settings.ts'
import { OFFICIAL_PROVIDER, type ProviderRouteGroup } from './routes.ts'
import type { BillingInjected } from './face.ts'
import { ageOf, balanceFailureText, formatBalance, priceFailureText, windowKey } from './format.ts'
import { currencyOf } from './CostMeter.tsx'
import { IconCoinOutline16, IconWalletOutline16 } from './icons.tsx'
import { LOCALE_NS, type BillingKey } from './locales.ts'
import { defaultRateOf, effectiveRates } from './official-rates.ts'
import css from './SettingsSection.module.css'

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
 * Props of the Billing settings section: the page slot's runtime share, the
 * plugin's injected face (the namespace and directory reads, the loader, and
 * the two writes), and the page's locale seat. Every ctx read belongs to the
 * plugin's apply closure; this component receives data and callbacks only.
 */
export type BillingSectionProps =
  & PropsRuntime<'settings.section'>
  & InjectFace<BillingInjected>
  & PropsLocale<typeof LOCALE_NS>

/**
 * Render the Billing settings page.
 * @param props - namespace snapshot hook, group hook, locale, the two writes, and the loader.
 * @returns the balance card and one card per configured provider.
 */
export function BillingSection({
  useBilling, useBillingGroups, t, saveRate, clearRate, refreshPrices, routeGroups,
}: BillingSectionProps) {
  const settings = useBilling(snapshot => snapshot.value)
  const [drafts, setDrafts] = useState<Drafts>(() => new Map())
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [failure, setFailure] = useState('')
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState(false)
  // One provider card is open at a time: the page shows what the rates apply to
  // (the models the user configured), and the fields appear on demand.
  const [editing, setEditing] = useState<string | undefined>(undefined)
  // Routes whose second band this page shows although their provider does not
  // bill by window. The data model carries a second band for any route, and this
  // is the control that reaches it, so a provider that starts pricing by window
  // can be priced here before its published table states the second band.
  const [banded, setBanded] = useState<ReadonlySet<string>>(() => new Set())
  const writable = useBilling(snapshot => snapshot.writable)
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

  /** Write one row through the plugin, then settle the row's own draft state. */
  const save = async (route: string): Promise<void> => {
    setStatus('saving')
    setFailure('')
    try {
      await saveRate(route, typedBand(route, 'peak'), typedBand(route, 'offPeak'))
      dropDrafts(route)
      setStatus('saved')
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  /** Remove one row through the plugin, then settle the row's own draft state. */
  const clear = async (route: string): Promise<void> => {
    setStatus('saving')
    setFailure('')
    try {
      await clearRate(route)
      dropDrafts(route)
      setStatus('saved')
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Ask the Host to read the published price page now.
   *
   * The write only records the request; the read it causes is the Host's, and
   * the card shows that read as in flight until the Host clears the field.
   */
  const reread = async (): Promise<void> => {
    setStatus('idle')
    setFailure('')
    try {
      await refreshPrices()
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const addManual = (): void => {
    const typed = manual.trim()
    const at = typed.indexOf(ROUTE_SEPARATOR)
    if (at <= 0 || at === typed.length - 1) {
      setManualError(true)
      return
    }
    setManualError(false)
    setManual('')
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

  return (
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

      {!writable && <div className={css.warn}>{t('section.writable')}</div>}

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
                            disabled={!writable || status === 'saving'}
                            onClick={() => { void clear(route) }}
                          >
                            {t('section.clear')}
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!writable || status === 'saving'}
                            onClick={() => { void save(route) }}
                          >
                            {status === 'saving' ? t('section.saving') : t('section.save')}
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
                      onKeyDown={(event) => { if (event.key === 'Enter') addManual() }}
                    />
                    <Button size="sm" variant="outline" onClick={addManual}>{t('section.add')}</Button>
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
              value={manual}
              placeholder={t('section.addPlaceholder')}
              aria-label={t('section.addRoute')}
              onChange={(event) => { setManual(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') addManual() }}
            />
            <Button size="sm" variant="outline" onClick={addManual}>{t('section.add')}</Button>
          </div>
          {manualError && <div className={css.warn}>{t('section.invalidRoute')}</div>}
        </div>
      </section>

      {status === 'error' && <div className={css.warn}>{t('section.writeFailed', { message: failure })}</div>}
      {status === 'saved' && <div className={css.note}>{t('section.saved')}</div>}
    </div>
  )
}

/** Relative freshness of one Host read. */
function freshness(at: number, t: BillingSectionProps['t']): string {
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
