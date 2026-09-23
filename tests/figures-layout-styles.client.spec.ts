/**
 * The billing figures' layout as CSS text. jsdom has no layout, so these read
 * the declarations that seat the composer figures on the shipped reading tier
 * after the stats row, keep the Turn pill on the geometry of the action row it
 * introduces, hide it behind that row's own reveal gate, and give both dialogs
 * the shipped stat-dialog surface.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8')

/** One rule's declarations, comments stripped so prose cannot satisfy a rule. */
function declarationsFrom(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('composer figures layout', () => {
  it('reads the stats row’s tier and stands in the dock as one centered ambient entry', () => {
    // The dock states no type tier of its own, so an entry that inherits from it
    // renders at the page's body size — visibly larger than the shipped pills
    // beside it. The declaration is the one ui-chat's own row carries.
    const css = read('CostMeter.module.css')
    expect(declarationsFrom(css, '.root')).toEqual(expect.arrayContaining([
      'font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      'line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      'display: flex',
      'justify-content: center',
      'gap: 12px',
      'max-width: 100%',
      'box-sizing: border-box',
    ]))
    // The pills take the tier from the group rather than restating it.
    expect(declarationsFrom(css, '.pill')).toEqual(expect.arrayContaining([
      'font: inherit',
      'line-height: inherit',
    ]))
  })
})

describe('turn pill layout', () => {
  it('wears the geometry and tier of the shipped usage and time triggers', () => {
    // The pill introduces the action row holding the shipped Turn-usage and
    // Turn-time triggers: the same 28px pill, 6px/8px padding, rounding, and
    // one-pixel-under-secondary reading, so the three read as one cluster.
    const css = read('TurnCostMeter.module.css')
    expect(declarationsFrom(css, '.trigger')).toEqual(expect.arrayContaining([
      'height: calc(28px + var(--dsh-content-font-delta, 0px))',
      'padding: 6px 8px',
      'border-radius: 28px',
      'font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      'min-width: 0',
      'white-space: nowrap',
    ]))
    expect(declarationsFrom(css, '.trigger svg')).toEqual(expect.arrayContaining([
      'width: calc(15px + var(--dsh-content-font-delta, 0px))',
      'height: calc(15px + var(--dsh-content-font-delta, 0px))',
    ]))
    expect(declarationsFrom(css, '.label')).toEqual(expect.arrayContaining([
      'min-width: 0',
      'overflow: hidden',
      'text-overflow: ellipsis',
    ]))
  })

  it('follows the action row’s reveal gate on the attribute the tail carries', () => {
    // A tail contribution introduces the row below it, so a row revealed on
    // hover only must not leave this pill standing alone above an invisible row.
    // Absence of the attribute — a turn with no closing message — keeps it
    // resident, which is the case the tail seat exists for.
    const css = read('TurnCostMeter.module.css')
    const hover = /@media \(hover: hover\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(hover).toMatch(/\[data-actions-reveal='hover'\] \.root \{[^}]*opacity: 0/)
    expect(hover).toMatch(/\[data-actions-reveal='hover'\]:hover \.root,[\s\S]*?opacity: 1/)
    expect(hover).toMatch(/\[data-actions-reveal='hover'\]:focus-within \.root/)
    // A device without hover keeps every reading visible, and the pill never
    // disappears from the layout it shares with the row.
    expect(hover).not.toContain('display: none')
  })
})

describe('billing dialog surface', () => {
  it('wears the shipped stat-dialog skin, backdrop included', () => {
    const css = read('stat-dialog.module.css')
    expect(declarationsFrom(css, '.panel')).toEqual(expect.arrayContaining([
      'position: fixed',
      'z-index: 1100',
      'border-radius: 12px',
      'background: var(--dsw-specific-menu)',
      'backdrop-filter: var(--dsw-menu-backdrop-filter)',
      'box-shadow: var(--dsw-elevation-prominent)',
      'font-size: 12px',
      'line-height: 18px',
    ]))
  })
})
