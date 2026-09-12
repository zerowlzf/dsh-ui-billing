/**
 * The settings operations one rate-row save produces.
 *
 * The Billing page hands this module what the user typed, field by field and
 * band by band, and the module answers what the namespace should be told. It
 * is pure and lives apart from the plugin body so the rules that decide between
 * writing, clearing, and ignoring a value are stated once, in one place, and
 * can be read without a settings document.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/rate-ops
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { parseRate, RATE_FIELDS, type ModelRate } from '../settings.ts'

/** One band's fields as the user typed them, keyed by field name. */
export type TypedBand = Readonly<Record<string, string>>

/** Trimmed text of one field, absent fields reading as empty. */
function text(fields: TypedBand, field: string): string {
  return (fields[field] ?? '').trim()
}

/**
 * Operations that write one route's rates as the user left them.
 *
 * The page cannot tell an untouched field from a mistyped one by text alone, so
 * this module never guesses: a field is written exactly when it holds a figure,
 * and the document keeps whatever it had otherwise.
 *
 * - Every field of both bands left empty is the page's way of asking for the
 *   row to go, and it is answered before anything is written: a saved row of
 *   zeroes would read as a free route rather than as an unpriced one.
 * - A field holding a figure is written; a field left empty is not, so saving a
 *   row cannot zero the fields the user never touched.
 * - The off-peak fields are a second band. Leaving all three empty asks for
 *   that band to be absent rather than for a band of zeroes, so a stored one is
 *   removed; a typed field writes the band beside its empty siblings.
 * - Text that does not parse is written nowhere. A mistyped figure must not
 *   change the document, and in particular must not delete the row behind it.
 * @param route - the `provider/model` key being saved.
 * @param peak - typed peak-window fields.
 * @param offPeak - typed off-peak-window fields.
 * @param stored - the row the document currently holds for this route, if any.
 * @returns the ordered operations to apply; empty when the save changes nothing.
 */
export function rateOps(
  route: string,
  peak: TypedBand,
  offPeak: TypedBand,
  stored: ModelRate | undefined,
): SettingsPathOpView[] {
  const emptied = RATE_FIELDS.every(field => text(peak, field) === '' && text(offPeak, field) === '')
  if (emptied) return [{ op: 'unset', path: ['models', route] }]

  const ops: SettingsPathOpView[] = []
  const writeBand = (fields: TypedBand, path: readonly string[]): void => {
    for (const field of RATE_FIELDS) {
      const parsed = parseRate(text(fields, field))
      if (parsed === undefined || text(fields, field) === '') continue
      ops.push({ op: 'set', path: [...path, field], value: parsed })
    }
  }

  writeBand(peak, ['models', route])
  const typedOffPeak = RATE_FIELDS.some(field => text(offPeak, field) !== '')
  if (typedOffPeak) writeBand(offPeak, ['models', route, 'offPeak'])
  else if (stored?.offPeak !== undefined) ops.push({ op: 'unset', path: ['models', route, 'offPeak'] })
  return ops
}
