// One trigger-anchored stat dialog seat for the billing pills: open state,
// viewport-clamped placement above the trigger, outside-pointer and Escape
// dismissal. The matching panel skin is stat-dialog.module.css.

import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Viewport margin the placement clamp keeps. */
const PANEL_MARGIN = 12

/** Distance between the trigger's edge and the panel. */
const PANEL_GAP = 8

/** Unplaced portal panel: hidden but laid out, so the clamp measures real dimensions. */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Open state, refs, and clamped placement for one billing dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/**
 * One trigger-anchored dialog seat.
 * @param side - which trigger edge the panel hangs from; defaults to above.
 * @returns the seat; spread `pos ?? MEASURE_STYLE` onto the portaled panel.
 */
export function useStatDialog(side: 'top' | 'bottom' = 'top'): StatDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side,
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])
  return { open, setOpen, rootRef, panelRef, pos }
}
