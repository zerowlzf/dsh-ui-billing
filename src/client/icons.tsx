/**
 * Icons owned by the billing surfaces.
 *
 * `ui-primitives` is the shared catalog for controls the whole product uses,
 * and it deliberately carries no money glyph. A billing pill that borrowed the
 * database or gauge glyph would read as a duplicate of the token meters beside
 * it, so these two shapes live with the surface that means them.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/icons
 */

import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Thin-stroke coin: ring, currency stroke, and cut ends.
 * @param props - square edge and layout class.
 * @returns the coin glyph.
 */
export function IconCoinOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6.375" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10 5.6H7.1a1.6 1.6 0 0 0 0 3.2h1.8a1.6 1.6 0 0 1 0 3.2H6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M8.2 4.2v7.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Thin-stroke wallet: rounded case with a card slot on the right edge.
 * @param props - square edge and layout class.
 * @returns the wallet glyph.
 */
export function IconWalletOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.625" y="3.375" width="12.75" height="9.25" rx="2.2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M14.375 6.6h-2.6a1.6 1.6 0 0 0 0 3.2h2.6" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}
