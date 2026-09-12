// Turn-cost pill inside a completed turn's own action row: the stat pill after
// the shipped Turn-usage and Turn-time triggers, labelled with what the turn
// cost and click-opening the per-route breakdown.
//
// The turn's token accounting comes from the turn-tail payload, which is the
// same evidence the Turn-usage dialog shows and the only per-turn total the
// session log can prove; the loaded window supplies each attempt's route, so a
// turn that switched models is priced per attempt. A turn interrupted before
// any finalized text still owns its accounting and still renders the row, so
// this pill prices whatever the row's own evidence holds.

import { Fragment } from 'react'
import { createPortal } from 'react-dom'
import type { ChatConversationViewNode, TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_CURRENCY, pricesByWindow, routeKey, type BillingSettings, type ModelRate } from '../settings.ts'
import type { BillingInjected } from './face.ts'
import { LOCALE_NS } from './locales.ts'
import { effectiveRates } from './official-rates.ts'
import { turnCost, turnRouteUsage, turnRoutes, type TurnAttempt, type TurnRouteUsage } from './cost.ts'
import { formatAmount, windowKey } from './format.ts'
import { IconCoinOutline16 } from './icons.tsx'
import { currencyOf } from './CostMeter.tsx'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './TurnCostMeter.module.css'
import dialogCss from './stat-dialog.module.css'

/**
 * Props of the per-Turn cost pill: the hole's runtime share (the completed
 * Turn's own `turn`, `seq`, and `openFile`, plus the session seats), the
 * plugin's injected face, and the pill's locale seat.
 *
 * The owner share arrives spread onto the entry, not nested under an `owner`
 * key, so `turn` is a direct prop: it is the Turn's Location, and the number
 * this pill prices is `turn.turn`.
 */
export type TurnCostMeterProps =
  & PropsRuntime<'conversation.chat.turn-stats'>
  & InjectFace<BillingInjected>
  & PropsLocale<typeof LOCALE_NS>

/** Read one finite number out of a provider-reported usage payload. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Read the loaded attempts of one turn, with the moment each settled.
 *
 * The settle time is what places an attempt in a price window: it is the only
 * instant the durable log states for an attempt, and the tokens were spent
 * during the request that ended there.
 * @param nodes - the loaded Chat nodes.
 * @param turn - the turn to collect.
 * @returns one entry per assistant attempt that reported usage, a route, and a time.
 */
export function attemptsOf(nodes: readonly ChatConversationViewNode[], turn: number): TurnAttempt[] {
  const attempts: TurnAttempt[] = []
  for (const node of nodes) {
    // The assistant renderer kind, which is one row per settled or interrupted
    // Assistant step: the per-attempt accounting a turn is billed for.
    if (node.kind !== 'assistant-step') continue
    const data = node.data as {
      readonly turn?: unknown
      readonly finalNode?: {
        readonly usage?: unknown
        readonly time?: unknown
        readonly provenance?: { readonly provider?: unknown; readonly model?: unknown }
      }
    }
    if (data.turn !== turn) continue
    const finalNode = data.finalNode
    const usage = finalNode?.usage
    if (typeof usage !== 'object' || usage === null) continue
    const provider = finalNode?.provenance?.provider
    const model = finalNode?.provenance?.model
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    const at = finalNode?.time
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    attempts.push({
      route: routeKey(provider, model),
      at,
      buckets: {
        uncachedInputTokens: count(Reflect.get(usage, 'inputTokens')),
        outputTokens: count(Reflect.get(usage, 'outputTokens')),
        cacheReadTokens: count(Reflect.get(usage, 'cacheReadTokens')),
        cacheWriteTokens: count(Reflect.get(usage, 'cacheWriteTokens')),
      },
    })
  }
  return attempts
}

/** Price one already-resolved charge row. */
function rowCost(row: TurnRouteUsage, rates: NonNullable<BillingSettings['models']>): number {
  return turnCost([row], rates).total
}

/** One route's rates for the window it was charged in, for the dialog's footnote. */
function rateText(row: TurnRouteUsage, rate: ModelRate | undefined, t: TurnCostMeterProps['t']): string {
  if (rate === undefined) return `${row.route}: ${t('pill.dialog.unpriced')}`
  const band = row.window === 'offPeak' && rate.offPeak !== undefined ? rate.offPeak : rate
  const figures = [band.cacheHit, band.cacheMiss, band.output].map(value => String(value)).join(' / ')
  return pricesByWindow(rate)
    ? `${row.route} · ${t(windowKey(row.window))}: ${figures}`
    : `${row.route}: ${figures}`
}

/**
 * Render the turn-cost pill.
 * @param props - the completed turn (spread from the row's owner share), Chat selector, namespace scope, and locale.
 * @returns the pill and its dialog, or null while the turn carries no accounting.
 */
export function TurnCostMeter({ turn: location, useChat, useBilling, t }: TurnCostMeterProps) {
  // The node store, not the legacy compatibility slice: the turn-tail payload
  // lives only in the materialized Chat nodes, and it is the one per-turn total
  // the durable log proves. The session projection is deliberately not a
  // fallback — it is a session-wide running total, so reading it here would
  // print the whole session as this one turn's cost.
  const nodes = useChat(snapshot => snapshot.nodes.values())
  const settings = useBilling(snapshot => snapshot.value)
  const seat = useStatDialog()
  const turn = location.turn
  let usage: TurnTailChatData['tokenUsage']
  let closedAt = 0
  for (const node of nodes) {
    if (node.kind !== 'turn-tail') continue
    const data = node.data as Partial<TurnTailChatData>
    if (data.turn !== turn) continue
    usage = data.tokenUsage
    closedAt = typeof data.time === 'number' ? data.time : 0
    break
  }
  // A turn whose accounting is incomplete — its events paged out, an attempt
  // that never settled — carries no figure here, exactly as its own Turn-usage
  // pill carries none.
  if (usage === undefined) return null

  const rates = effectiveRates(settings?.models, settings?.official ?? null)
  const attempts = attemptsOf(nodes, turn)
  const rows = turnRouteUsage(usage, attempts, rates, closedAt)
  const cost = turnCost(rows, rates)
  // A turn whose accounting names several routes and whose attempts are no
  // longer loaded cannot be split: the figure is withheld and the dialog names
  // the routes it could not attribute. It is the only reason for a priced row
  // to be absent, so the routes are read only then.
  const named = rows.length === 0 ? turnRoutes(usage) : []
  const currency = currencyOf(settings?.cache ?? null, settings?.currency ?? DEFAULT_CURRENCY)
  const priced = cost.priced.length > 0
  const label = priced
    ? t('turn.cost', { amount: formatAmount(cost.total, currency) })
    : t('turn.costUnknown')

  return (
    <span ref={seat.rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={seat.open}
        aria-label={label}
        onClick={() => { seat.setOpen(!seat.open) }}
      >
        <IconCoinOutline16 />
        <span className={css.label}>{label}</span>
      </button>
      {seat.open && createPortal(
        <div
          ref={seat.panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('turn.title')}
          style={seat.pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconCoinOutline16 />
              {t('turn.title')}
            </span>
            <span className={dialogCss.titleValue}>
              {priced ? formatAmount(cost.total, currency) : t('value.unavailable')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-billing-turn-routes>
            {rows.map(row => (
              <Fragment key={`${row.route}\u0000${row.window}`}>
                <dt className={dialogCss.route}>
                  {row.route}
                  {pricesByWindow(rates[row.route]) && (
                    <span className={dialogCss.window}>{t(windowKey(row.window))}</span>
                  )}
                </dt>
                <dd>
                  {rates[row.route] === undefined
                    ? t('pill.dialog.unpriced')
                    : formatAmount(rowCost(row, rates), currency)}
                </dd>
              </Fragment>
            ))}
          </dl>
          {rows.length > 0 && (
            <div className={dialogCss.note}>
              {rows.map(row => rateText(row, rates[row.route], t)).join(' · ')}
            </div>
          )}
          {/* One reason per dialog, so a withheld figure always says why. */}
          {named.length > 0 && (
            <div className={dialogCss.note}>
              {t('turn.unattributed', { routes: named.join(t('pill.dialog.routeSeparator')) })}
            </div>
          )}
          {rows.length === 0 && named.length === 0 && (
            <div className={dialogCss.note}>{t('turn.unevidenced')}</div>
          )}
          {cost.unpriced.length > 0 && <div className={dialogCss.note}>{t('turn.unpriced')}</div>}
        </div>,
        document.body,
      )}
    </span>
  )
}
