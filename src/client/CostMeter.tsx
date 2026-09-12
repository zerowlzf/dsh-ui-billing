// Session billing figures for the shipped composer stats row: one cost pill for
// the session's accumulated spend and one balance pill for the DeepSeek account,
// seated by `conversation.composer.stats` inside the same centred group as the
// turn/step and token pills rather than as a second dock row.
//
// The session cost is accumulated from the `tokenUsage` projection rather than
// folded from the loaded window, because that projection is the whole durable
// log while the window is paged: each observed growth of the running total is
// exactly what one route was billed, so replacing a stretch when the rates or
// the route change cannot lose history.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-remotes/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceSnapshot, PriceWindow } from '../settings.ts'
import { DEFAULT_CURRENCY, pricesByWindow, routeKey } from '../settings.ts'
import type { BillingInjected } from './face.ts'
import { effectiveRates } from './official-rates.ts'
import { LOCALE_NS } from './locales.ts'
import {
  bucketDelta, chargeWindow, isEmptyBuckets, sessionBuckets, sessionCost,
  type RateTable, type SessionCostStep,
} from './cost.ts'
import { ageOf, balanceFailureText, formatAmount, formatBalance, windowKey } from './format.ts'
import { IconCoinOutline16, IconWalletOutline16 } from './icons.tsx'
import { MEASURE_STYLE, useStatDialog, type StatDialogSeat } from './stat-dialog.ts'
import css from './CostMeter.module.css'
import dialogCss from './stat-dialog.module.css'

/**
 * Props of the composer-stats billing figures: the slot's runtime share (the
 * projection seats), the plugin's injected face, and the row's locale seat.
 */
export type SessionCostMeterProps =
  & PropsRuntime<'conversation.composer.stats'>
  & InjectFace<BillingInjected>
  & PropsLocale<typeof LOCALE_NS>

/**
 * Currency a cost is displayed in: the account's, since that is what the spend
 * is compared against, or the configured fallback while no balance is known.
 * @param balance - the newest Host-read balance, or null.
 * @param fallback - currency code the deployment prices in before any read.
 * @returns the currency code to format amounts with.
 */
export function currencyOf(balance: BalanceSnapshot | null, fallback: string): string {
  return balance?.currency ?? fallback
}

/** The route the running total is currently growing under. */
export function activeRoute(selection: ModelSelectionProjection | undefined): string {
  const current = selection?.next ?? selection?.lastUsed
  return current === null || current === undefined ? 'unknown' : routeKey(current.provider, current.model)
}

/**
 * Render the two billing pills.
 * @param props - projection read seat, namespace snapshot hook, and locale.
 * @returns the figures, or null while no rate and no balance are known.
 */
export function SessionCostMeter({ useProjection, useBilling, t }: SessionCostMeterProps) {
  const usage = useProjection('tokenUsage')
  const selection = useProjection('modelSelection')
  // One selector over the namespace snapshot: the component re-renders on the
  // fields it reads and holds no subscription of its own.
  const settings = useBilling(snapshot => snapshot.value)
  // Stored rows, over the newest published table, over the shipped snapshot:
  // the official routes nobody has priced still read a cost out of the box.
  const rates = effectiveRates(settings?.models, settings?.official ?? null)
  const balance = settings?.cache ?? null
  const balanceError = settings?.cacheError ?? null

  // Accumulated stretches, plus the running total they were derived from so a
  // growth can be attributed without re-folding the whole session. A session
  // whose log carries no billed usage yet is a third state: the projection
  // exists but is all zeroes, which is not the same as an unpriced session.
  const [accumulated, setAccumulated] = useState<{
    steps: readonly SessionCostStep[]
    seen: TokenUsageProjection | undefined
    billed: boolean
  }>({ steps: [], seen: undefined, billed: false })

  useEffect(() => {
    setAccumulated((state) => {
      if (usage === undefined) return state.seen === undefined ? state : { steps: [], seen: undefined, billed: false }
      const route = activeRoute(selection)
      // Each stretch is stamped with the moment it was observed, which is the
      // window the provider was pricing at while those tokens were produced.
      const at = Date.now()
      if (state.seen === undefined) {
        // First sight of the running total: it belongs to routes this browser
        // never observed, so one step under the newest known route prices it as
        // well as any split could.
        return isEmptyBuckets(sessionBuckets(usage))
          ? { steps: [], seen: usage, billed: false }
          : { steps: [{ route, at, buckets: sessionBuckets(usage) }], seen: usage, billed: true }
      }
      const delta = bucketDelta(sessionBuckets(state.seen), sessionBuckets(usage))
      if (isEmptyBuckets(delta)) return state
      return { steps: [...state.steps, { route, at, buckets: delta }], seen: usage, billed: true }
    })
  }, [usage, selection])

  const total = useMemo(
    () => sessionCost(accumulated.steps, rates),
    [accumulated.steps, rates],
  )
  const priced = accumulated.steps.some(step => rates[step.route] !== undefined)
  const currency = currencyOf(balance, settings?.currency ?? DEFAULT_CURRENCY)
  // Both dialog seats mount unconditionally: the row renders nothing without
  // data, and a conditional hook call would change the hook order instead.
  const costSeat = useStatDialog()
  const balanceSeat = useStatDialog()

  if (!accumulated.billed && balance === null && balanceError === null) return null

  const costLabel = priced
    ? t('pill.sessionCost', { amount: formatAmount(total, currency) })
    : t('pill.costUnknown')
  const balanceLabel = balance === null
    ? t('pill.balanceUnknown')
    : t('pill.balance', { amount: formatBalance(balance.total, balance.currency) })

  return (
    <span className={css.root} data-composer-billing>
      <Pill
        seat={costSeat}
        icon={<IconCoinOutline16 />}
        label={costLabel}
        spokenLabel={priced
          ? t('pill.spokenSessionCost', { amount: formatAmount(total, currency) })
          : t('pill.spokenCostUnknown')}
        dialogLabel={t('pill.dialog.costTitle')}
        onOpen={() => {
          // One exclusive slot: opening either pill closes the other's seat.
          balanceSeat.setOpen(false)
        }}
      >
        <dl className={dialogCss.details} data-billing-session-cost>
          <dt>{t('pill.dialog.total')}</dt>
          <dd>{priced ? formatAmount(total, currency) : t('value.unavailable')}</dd>
        </dl>
        <RouteRows steps={accumulated.steps} rates={rates} currency={currency} t={t} />
        {!priced && <div className={dialogCss.note}>{t('pill.dialog.noRateHint')}</div>}
      </Pill>
      <Pill
        seat={balanceSeat}
        icon={<IconWalletOutline16 />}
        label={balanceLabel}
        spokenLabel={balance === null
          ? t('pill.spokenBalanceUnknown')
          : t('pill.spokenBalance', { amount: formatBalance(balance.total, balance.currency) })}
        dialogLabel={t('pill.dialog.balanceTitle')}
        onOpen={() => {
          costSeat.setOpen(false)
        }}
      >
        <dl className={dialogCss.details} data-billing-balance>
          <dt>{t('pill.dialog.balance')}</dt>
          <dd>{balance === null ? t('value.unavailable') : formatBalance(balance.total, balance.currency)}</dd>
          {balance !== null && (
            <>
              <dt>{t('pill.dialog.currency')}</dt>
              <dd>{balance.currency}</dd>
              <dt>{t('pill.dialog.available')}</dt>
              <dd>{balance.available ? t('pill.dialog.availableYes') : t('pill.dialog.availableNo')}</dd>
              <dt>{t('pill.dialog.updatedAt')}</dt>
              <dd>{freshness(balance.at, t)}</dd>
            </>
          )}
        </dl>
        {balanceError !== null && (
          <div className={dialogCss.note}>{balanceFailureText(balanceError, t)}</div>
        )}
      </Pill>
    </span>
  )
}

/** One route's aggregate for the cost dialog, within the window it was billed in. */
interface RouteRow {
  readonly route: string
  /** Window the row's tokens were billed in; a route with one price reports `peak`. */
  readonly window: PriceWindow
  readonly tokens: number
  readonly cost: number
  readonly priced: boolean
}

/**
 * Aggregate accumulated stretches per charge for display.
 * @param steps - every billed stretch in accumulation order.
 * @param rates - configured rates by route.
 * @returns one row per route and window, in first-seen order.
 */
export function groupSteps(
  steps: readonly SessionCostStep[],
  rates: RateTable,
): RouteRow[] {
  const byCharge = new Map<string, RouteRow>()
  for (const step of steps) {
    const window = chargeWindow(step.route, step.at, rates)
    const key = `${step.route}\u0000${window}`
    const tokens = step.buckets.uncachedInputTokens + step.buckets.cacheReadTokens
      + step.buckets.cacheWriteTokens + step.buckets.outputTokens
    const rate = rates[step.route]
    const previous = byCharge.get(key)
    byCharge.set(key, {
      route: step.route,
      window,
      tokens: (previous?.tokens ?? 0) + tokens,
      cost: (previous?.cost ?? 0) + (rate === undefined ? 0 : sessionCost([step], rates)),
      priced: (previous?.priced ?? false) || rate !== undefined,
    })
  }
  return [...byCharge.values()]
}

/** One row per route and price window that contributed to the session total. */
function RouteRows({ steps, rates, currency, t }: {
  steps: readonly SessionCostStep[]
  rates: RateTable
  currency: string
  t: SessionCostMeterProps['t']
}) {
  const rows = groupSteps(steps, rates)
  if (rows.length === 0) return null
  return (
    <dl className={dialogCss.details} data-billing-session-routes>
      {rows.map(row => (
        <Fragment key={`${row.route}\u0000${row.window}`}>
          <dt className={dialogCss.route}>
            {row.route}
            {pricesByWindow(rates[row.route]) && (
              <span className={dialogCss.window}>{t(windowKey(row.window))}</span>
            )}
            <span className={css.tokens}>{`${String(row.tokens)} ${t('pill.dialog.tokens')}`}</span>
          </dt>
          <dd>{row.priced ? formatAmount(row.cost, currency) : t('pill.dialog.unpriced')}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * One pill plus its dialog, seated in the anchor its caller owns. The seat
 * carries the open state that outside-pointer and Escape dismissal writes, so
 * both dismissal paths close the panel they belong to; `onOpen` lets the row
 * keep its exclusive slot.
 */
function Pill({ seat, icon, label, spokenLabel, dialogLabel, onOpen, children }: {
  seat: StatDialogSeat
  /** Glyph shown in the pill and its dialog title. */
  icon: ReactNode
  /** Visible pill text, kept to the figure: the row this joins is width-bound. */
  label: string
  /**
   * What the pill means, read out and shown on hover. The visible label is a
   * bare figure, so the accessible name is where "this session" is stated.
   */
  spokenLabel: string
  dialogLabel: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <span ref={seat.rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={seat.open}
        aria-label={spokenLabel}
        title={spokenLabel}
        onClick={() => {
          if (seat.open) {
            seat.setOpen(false)
            return
          }
          seat.setOpen(true)
          onOpen()
        }}
      >
        {icon}
        <span className={css.label}>{label}</span>
      </button>
      {seat.open && createPortal(
        <div
          ref={seat.panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={dialogLabel}
          style={seat.pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              {icon}
              {dialogLabel}
            </span>
            <span className={dialogCss.titleValue}>{label}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** Relative freshness of one Host-read snapshot. */
export function freshness(at: number, t: SessionCostMeterProps['t']): string {
  const age = ageOf(at, Date.now())
  switch (age.kind) {
    case 'justNow': return t('value.justNow')
    case 'minutes': return t('value.minutesAgo', { count: age.count })
    case 'hours': return t('value.hoursAgo', { count: age.count })
    case 'days': return t('value.daysAgo', { count: age.count })
  }
}
