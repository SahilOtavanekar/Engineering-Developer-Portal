import type { CSSProperties } from 'react';

/**
 * The shared visual vocabulary for every hand-rolled surface in the Fleet
 * plugin: table cells, chips, inputs, panels and tags.
 *
 * **Why this file exists.** The fleet and productivity pages are not built from
 * Material UI, so the portal theme's `MuiTableCell` and `MuiChip` overrides do
 * not reach them, and they are only partly built from Backstage UI, so its
 * component styles do not cover them either. What was left was four files each
 * carrying its own copy of `cell`, `headerCell` and `chip` -- and letting those
 * drift is exactly what once made the catalog table and the fleet table look
 * like two different products.
 *
 * **Everything here is a CSS custom property, never a literal.** `plugins/fleet`
 * cannot import from `packages/app`: it is a separate workspace package and the
 * dependency would point the wrong way round. Custom properties are therefore
 * the only channel between the theme and these styles -- and because they are
 * resolved by the browser at paint time rather than baked in at build time,
 * these objects follow a light/dark switch with no React state and no re-render.
 *
 * Two namespaces appear below and the difference matters:
 *
 * - `--bui-*` is Backstage UI's own contract, redefined by the portal theme.
 * - `--portal-*` is ours, for the things Backstage UI has no token for.
 *
 * **Three tokens used here previously did not exist.** `--bui-border`,
 * `--bui-border-soft` and `--bui-bg-surface-2` appear nowhere among the 152
 * properties `@backstage/ui` 0.17 actually ships. Where a literal fallback was
 * supplied it silently hardcoded a light-mode colour that never adapted to
 * dark; where none was, the declaration was invalid at computed-value time and
 * `border-color` fell back to `currentColor` -- chips outlined in
 * full-strength text. Everything below uses real tokens.
 */

/** A hairline. The lightest rule in the system; separates rows. */
export const BORDER_SOFT = '1px solid var(--bui-border-1)';

/** A visible edge. Separates a surface from the page. */
export const BORDER = '1px solid var(--bui-border-2)';

/**
 * Figures line up in a column only if the digits are the same width.
 *
 * Proportional digits make a stack of scores and counts look ragged, which is
 * the cheapest thing to fix on a page that is mostly numbers.
 */
export const NUMERIC: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/**
 * A body cell, at the same 10px/16px density as the theme's `MuiTableCell`.
 *
 * The two tables and the catalog's have to agree on this or the portal reads as
 * assembled from parts.
 */
export const cell: CSSProperties = {
  padding: '10px 16px',
  borderBottom: BORDER_SOFT,
  verticalAlign: 'top',
};

/** A right-aligned body cell, for counts and durations. */
export const numericCell: CSSProperties = {
  ...cell,
  ...NUMERIC,
  textAlign: 'right',
};

/**
 * A cell whose value is short and known, and must never wrap.
 *
 * Auto table layout balances column heights, so it will happily break
 * "Needs attention" or "Makarand Prabhu" across two lines to give a neighbouring
 * column more room. One wrapped cell makes the whole row double height, and a
 * table where some rows are 33px and others 54px reads as broken even though
 * every value in it is correct.
 *
 * Only for columns whose content is bounded -- a status label, a person's name,
 * a relative date. Columns holding genuinely open-ended lists (contributors, a
 * tech stack) keep `cell` and are allowed to wrap, because forcing those to one
 * line either truncates real information or forces the table to scroll.
 */
export const nowrapCell: CSSProperties = {
  ...cell,
  whiteSpace: 'nowrap',
};

/**
 * A cell that keeps to one line and ellipsises whatever does not fit.
 *
 * **Only works under `table-layout: fixed`.** In the automatic layout a cell's
 * minimum width is its content's minimum width, so `white-space: nowrap` makes
 * the column grow rather than the text truncate, and `text-overflow` never
 * fires. Fixed layout takes the widths from the `<colgroup>` and nothing else,
 * which is what finally allows a cell to be smaller than its content.
 *
 * Pair it with a `title` carrying the untruncated value -- an ellipsis that
 * hides information with no way to recover it is worse than a wrapped line.
 */
export const truncatedCell: CSSProperties = {
  ...cell,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * Fixed table layout, and the reason every Fleet table uses it.
 *
 * With the automatic algorithm the browser balances column widths against
 * content, so one long value in one row changes the width of that column for
 * all 96 -- and "Needs attention" or "Makarand Prabhu" gets broken across two
 * lines to buy room for a neighbouring column. The result is a table where some
 * rows are 33px and others 72px, which reads as broken even though every value
 * in it is correct.
 *
 * Fixed layout takes widths from the `<colgroup>` alone. Rows become a uniform
 * height, columns stop moving as the data changes, and -- the reason it is
 * worth the explicit widths -- the browser can lay the table out from the first
 * row instead of measuring all 96, which is the cheaper algorithm at this size.
 *
 * `minWidth` is what keeps it honest on a narrow viewport: below that the
 * percentages would squeeze every column to nothing, so the table stops
 * shrinking and the wrapper scrolls instead.
 */
export const fixedTable = (minWidth: string): CSSProperties => ({
  tableLayout: 'fixed',
  borderCollapse: 'collapse',
  width: '100%',
  minWidth,
});

/**
 * A header cell, matching the portal theme's Material UI table treatment:
 * small, upper-case, letter-spaced and in the muted foreground.
 *
 * The stock header is the same weight and colour as the body, so a long table
 * reads as one undifferentiated block.
 */
export const headerCell: CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  borderBottom: BORDER_SOFT,
  // Header labels are short; wrapping one turns a 40px row into 60px and knocks
  // every other column out of alignment.
  whiteSpace: 'nowrap',
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--portal-fg-muted)',
};

/** A right-aligned header cell, over a `numericCell` column. */
export const numericHeaderCell: CSSProperties = {
  ...headerCell,
  textAlign: 'right',
};

/**
 * The card a table sits in, so it reads as a dashboard surface rather than
 * markup dropped onto the page.
 *
 * **Deliberately opaque, and deliberately not blurred**, where every other
 * surface in the portal is translucent with a backdrop filter. These tables run
 * to 96 and 124 rows; compositing a blurred layer on every scroll frame is
 * precisely where a premium finish turns into a janky one. It resolves to the
 * same colour a translucent card resolves to, so the difference is invisible
 * while the cost is not.
 *
 * `overflow: hidden` is what keeps the first and last rows inside the rounded
 * corners instead of squaring them off.
 */
export const tablePanel: CSSProperties = {
  background: 'var(--portal-surface-solid)',
  border: BORDER_SOFT,
  borderRadius: 'var(--portal-radius-lg)',
  boxShadow: 'var(--portal-shadow-card)',
  overflow: 'hidden',
};

/**
 * The scroll container a wide table needs.
 *
 * **`minWidth: 0` is load-bearing.** A flex child defaults to
 * `min-width: auto`, so an `overflow-x: auto` wrapper grows to its content's
 * minimum instead of scrolling -- the whole page then scrolls sideways, and
 * pinning the sidebar cuts the table off. This has bitten both Fleet tables and
 * the About card's value column.
 */
export const tableScroll: CSSProperties = {
  overflowX: 'auto',
  minWidth: 0,
};

/**
 * A filter chip.
 *
 * A true pill, matching the theme's `MuiChip`, so a filter on a Fleet page and
 * a tag on the catalog page read as the same kind of object.
 */
export const chip = (active: boolean): CSSProperties => ({
  appearance: 'none',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.75rem',
  fontWeight: 500,
  padding: '0.25rem 0.7rem',
  borderRadius: 'var(--portal-radius-pill)',
  border: active ? '1px solid var(--portal-accent)' : BORDER_SOFT,
  background: active
    ? 'var(--portal-accent-subtle)'
    : 'var(--bui-bg-neutral-2)',
  color: active ? 'var(--portal-accent)' : 'var(--bui-fg-secondary)',
  transition: 'background-color 140ms ease, border-color 140ms ease',
  whiteSpace: 'nowrap',
});

/** A search or filter field, matching the theme's `MuiInputBase`. */
export const input: CSSProperties = {
  font: 'inherit',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem 0.5rem 2.1rem',
  border: BORDER_SOFT,
  borderRadius: 'var(--portal-radius-sm)',
  background: 'var(--bui-bg-neutral-2)',
  color: 'inherit',
  width: '100%',
};

/**
 * A native `select`, matching the chips beside it.
 *
 * The browser default ignores the surrounding type scale entirely and looks
 * pasted in.
 */
export const select: CSSProperties = {
  font: 'inherit',
  fontSize: '0.8125rem',
  padding: '0.3rem 0.6rem',
  border: BORDER_SOFT,
  borderRadius: 'var(--portal-radius-sm)',
  background: 'var(--bui-bg-neutral-2)',
  color: 'inherit',
  maxWidth: '20rem',
};

/**
 * A recessed block inside a card: the expanded productivity row, the problems
 * callout, a metric bar's track.
 */
export const recessed: CSSProperties = {
  background: 'var(--bui-bg-neutral-2)',
  borderRadius: 'var(--portal-radius-md)',
};

/**
 * A panel inside a card, for the score headline.
 *
 * Bordered rather than filled: it sits directly on a card that is already a
 * surface, and a second fill there reads as a second card.
 */
export const panel: CSSProperties = {
  border: BORDER_SOFT,
  borderRadius: 'var(--portal-radius-md)',
  padding: '1rem 1.15rem',
};

/**
 * A sub-card: one section inside a card that holds several of them.
 *
 * Filled and hairlined rather than merely divided by a rule, because a rule
 * only says "these two things are different" -- it does not say where a
 * section begins and ends. The Repository activity card holds eight sections,
 * each full of labelled figures, and a reader scanning it for one fact needs
 * the boundary, not just the break.
 *
 * **Recessed, never raised.** It sits on a card that already carries a border
 * and a shadow, and a second shadow inside the first reads as a seam rather
 * than as depth -- the same defect the `bui-Card__` rule in the portal theme
 * exists to prevent. The fill is `recessed`, one step into the surface scale,
 * so a section reads as inset into its card rather than floating on it.
 *
 * **Nothing inside may also be `recessed`.** Two surfaces at the same depth do
 * not compose: the metric bar's track was `--bui-bg-neutral-2`, the very fill
 * `recessed` supplies, so putting the Scorecard on a panel erased all eight
 * tracks and left the bars with nothing to measure against. Tracks and other
 * inner grounds take `--bui-border-2`, which is defined as contrast against
 * whatever it sits on and so survives being nested in either mode.
 */
export const sectionPanel: CSSProperties = {
  ...recessed,
  border: BORDER_SOFT,
  padding: '1rem 1.15rem',
};

/** A metadata tag, matching the catalog's Tags column. */
export const tag: CSSProperties = {
  fontSize: '0.6875rem',
  padding: '0.15rem 0.55rem',
  borderRadius: 'var(--portal-radius-pill)',
  border: BORDER_SOFT,
  background: 'var(--bui-bg-neutral-2)',
  color: 'var(--bui-fg-secondary)',
  whiteSpace: 'nowrap',
};

/**
 * A grid of figures.
 *
 * A grid rather than a wrapping flex row: wrapped flex items align to their own
 * content width, so each row of stats starts in a different place and the card
 * reads as a jumble. A grid puts every label on the same vertical line whatever
 * the value beneath it.
 */
export const statGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))',
  gap: '1rem 1.25rem',
};

/** A field label: small, upper-case, muted. Matches `headerCell`. */
export const sectionLabel: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

/**
 * A section heading, one step above `sectionLabel`.
 *
 * Rendered at `body-small` in the primary colour where a field label is
 * `body-x-small` and muted. Both steps are needed: the Repository activity
 * card nests eight sections, each full of labelled figures, and when the
 * heading and the labels under it shared a variant and a colour the whole card
 * read as one flat list of small grey words.
 *
 * Looser tracking than `sectionLabel` would be too loose here -- 0.06em is
 * tuned for 11px and reads as gappy at 14px, so this pulls it in.
 */
export const sectionHeading: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.045em',
};
