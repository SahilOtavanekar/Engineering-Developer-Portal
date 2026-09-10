import {
  createUnifiedTheme,
  palettes,
  type UnifiedTheme,
} from '@backstage/theme';
import { portalTokens, type PortalTokens, type ThemeMode } from './tokens';

/**
 * Shared shape language.
 *
 * One radius and one border, referenced everywhere, because the thing that
 * makes a portal look assembled rather than designed is five components each
 * picking their own.
 *
 * Both now come from `tokens.ts`, because the Material UI layer is only one of
 * three that have to agree on them -- see the table at the top of that file.
 * `tokens.radius.sm` is the value this used to hardcode as `RADIUS = 6`.
 */

/**
 * Table styling, which on the catalog page is the whole page.
 *
 * `CatalogTable` is Backstage's own component built on material-table, and its
 * columns and markup are not reachable from here. What *is* reachable is the
 * MUI class keys underneath it, so this is where the catalog page's density,
 * alignment and header treatment come from.
 *
 * Three deliberate choices:
 *
 * - **Header rows get uppercase, letter-spaced, secondary-coloured labels.**
 *   The stock header is the same weight and colour as the body, so a long
 *   table reads as one undifferentiated block.
 * - **Row separators only, no vertical rules and no zebra striping.** Both add
 *   ink without adding information, and zebra fights the row-hover state that
 *   material-table already provides.
 * - **Denser vertical padding.** The stock 16px is generous for a table nobody
 *   scans; the catalog is 124 rows and the fleet page 96.
 */
function tableComponents(tokens: PortalTokens) {
  const divider = tokens.border.soft;
  const headerText = tokens.fg.muted;
  const { radius } = tokens;

  return {
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${divider}`,
          padding: '10px 16px',
        },
        head: {
          fontSize: '0.6875rem',
          fontWeight: 600,
          textTransform: 'uppercase' as const,
          letterSpacing: '0.06em',
          color: headerText,
          // Header labels are short; wrapping one turns a 40px row into 60px
          // and knocks every other column out of alignment.
          whiteSpace: 'nowrap' as const,
          paddingTop: 12,
          paddingBottom: 12,
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          // The last row's border duplicates the container's own edge.
          '&:last-child td': { borderBottom: 'none' },
          transition: 'background-color 120ms ease',
        },
        // A tinted hover rather than material-table's grey. On a 124-row table
        // this is the primary way a reader keeps their place across eight
        // columns, so it wants to be the accent and not a wash.
        hover: {
          '&:hover': { backgroundColor: `${tokens.accent.subtle} !important` },
        },
      },
    },
    /**
     * The row above the table holding its title and search field.
     *
     * Stock gives it the same 24px block padding as page content, which reads
     * as a gap rather than a header and pushes the first row of a 124-row
     * table further down for no gain.
     */
    BackstageTableToolbar: {
      styleOverrides: {
        root: { padding: '4px 0 12px 0', minHeight: 'unset' },
        title: { paddingLeft: 0 },
      },
    },

    /**
     * The catalog's own toolbar, which is a different component from the one
     * above.
     *
     * `BackstageTableToolbar` does not appear on the catalog page at all --
     * `CatalogTable` renders `CatalogTableToolbar`, registered under
     * `PluginCatalogTableToolbar`. The override above was reaching nothing
     * here; it is kept for the generic `Table` used elsewhere.
     *
     * **The wrap is the fix that matters.** The toolbar is a two-child flex row
     * with `nowrap`, holding the title and the search field. At 390px the row
     * cannot fit both, so the title -- which carries `text-overflow: ellipsis`
     * -- was truncated to "All Componen..." with the search box hard against
     * it. Below the small breakpoint they each take a full line instead.
     *
     * The left padding is dropped to match the table's own 16px cell padding,
     * so the heading sits on the same vertical line as the NAME column rather
     * than 4px inside it.
     */
    PluginCatalogTableToolbar: {
      styleOverrides: {
        root: {
          // Both sides match the table's own 16px cell padding, so the heading
          // lines up with the NAME column and the search field's right edge
          // lines up with the ACTIONS column rather than sitting flush.
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 4,
          paddingBottom: 12,
          minHeight: 'unset',
          gap: 12,
          '@media (max-width: 599.95px)': {
            flexWrap: 'wrap' as const,
            paddingLeft: 12,
            gap: 4,
          },
        },
        // Given the whole line once wrapped, so the ellipsis stops firing on a
        // heading that has plenty of room of its own.
        text: {
          '@media (max-width: 599.95px)': { flexBasis: '100%' },
        },
      },
    },

    /**
     * The filter column down the left of the catalog page.
     *
     * Its group titles were the same size and weight as the options beneath
     * them, so the column read as one long list rather than named groups.
     * Matches the table header treatment, so both sides of the page use the
     * same signal for "this is a label, not data".
     */
    BackstageTableFilters: {
      styleOverrides: {
        header: {
          fontSize: '0.6875rem',
          fontWeight: 600,
          textTransform: 'uppercase' as const,
          letterSpacing: '0.06em',
          color: headerText,
          marginBottom: 4,
        },
      },
    },

    /**
     * Page content padding, responsive.
     *
     * 24px is right on a desktop and wasteful on a phone, where it costs
     * a seventh of the viewport width before any content appears. Only
     * reachable on pages built from `Content` -- the catalog page's own shell
     * is BUI and its padding is not themeable from here.
     */
    BackstageContent: {
      styleOverrides: {
        root: {
          '@media (max-width: 599.95px)': { padding: 12 },
        },
      },
    },

    /**
     * Empty states.
     *
     * Given real breathing room and a constrained measure: the stock state
     * stretches its explanation the full width of the content area, which at
     * 1600px is an unreadable single line.
     */
    BackstageEmptyState: {
      styleOverrides: {
        root: {
          padding: '48px 24px',
          '@media (max-width: 599.95px)': { padding: '32px 16px' },
        },
      },
    },

    /**
     * Tag chips in the catalog's Tags column.
     *
     * Stock chips are 32px pills, which in a 40px table row leaves 4px above
     * and below and makes the row look like it is holding buttons. Shrunk to
     * label size so a tag reads as metadata rather than as something to click.
     *
     * **Now a true pill rather than the 3px square it was.** At 22px tall a
     * full radius is only 11px, so this is a small shape change, but it is the
     * one that separates a tag from a button at a glance -- buttons here are
     * `radius.sm`, and nothing else in the portal is round. The fill is the
     * recessed surface rather than the stock solid grey, so a row of tags reads
     * as inset into the row instead of stacked on top of it.
     */
    MuiChip: {
      styleOverrides: {
        root: {
          height: 22,
          borderRadius: radius.pill,
          fontSize: '0.6875rem',
          margin: '2px 4px 2px 0',
          backgroundColor: tokens.surface[2],
          border: `1px solid ${divider}`,
          color: tokens.fg.secondary,
        },
        label: { paddingLeft: 10, paddingRight: 10 },
        clickable: {
          '&:hover, &:focus': { backgroundColor: tokens.accent.subtle },
        },
        deletable: {
          '&:focus': { backgroundColor: tokens.accent.subtle },
        },
      },
    },

    /**
     * Buttons, de-shouted.
     *
     * Material UI v4 upper-cases every button label. On a page whose own
     * headers are the only upper-case text by design, buttons shouting too
     * removes the distinction -- and "EXPORT" beside "Export source" reads as
     * two different kinds of thing.
     *
     * **Soft, not flat.** Stock Material UI v4 gives a contained button a hard
     * two-layer drop shadow that lifts it well off the page; against a tinted
     * ground with ambient depth everywhere else, that reads as a different
     * design language. Depth comes from the token shadows instead, and hover is
     * a lift rather than a colour jump.
     */
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none' as const,
          borderRadius: radius.sm,
          fontWeight: 600,
          letterSpacing: 0,
          padding: '6px 14px',
          transition:
            'background-color 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
        },
        contained: {
          boxShadow: tokens.shadow.soft,
          '&:hover': { boxShadow: tokens.shadow.card },
          '&:active': { boxShadow: 'none' },
        },
        outlined: {
          borderColor: tokens.border.base,
          '&:hover': {
            borderColor: tokens.border.strong,
            backgroundColor: tokens.accent.subtle,
          },
        },
        text: {
          '&:hover': { backgroundColor: tokens.accent.subtle },
        },
      },
    },

    /**
     * Search fields and the catalog's filter inputs.
     *
     * The stock underline input is the strongest horizontal line on a page
     * whose own rules are hairlines, so it draws the eye to a control that is
     * rarely the point. Replaced with a soft filled field that matches the
     * hand-rolled search input on the fleet page -- those two sit one click
     * apart and looked unrelated.
     */
    MuiInputBase: {
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          backgroundColor: tokens.surface[2],
          border: `1px solid ${divider}`,
          transition: 'border-color 140ms ease, box-shadow 140ms ease',
          '&:hover': { borderColor: tokens.border.base },

          // The focus ring is the accent, so focus reads as brand rather than
          // as the browser's default blue.
          //
          // **Nested under `root`, not a sibling `focused` key.** Material UI
          // raises the specificity of its own internal state classes, so a
          // top-level `focused: {...}` loses to the component's own rule and is
          // rejected outright with a console error rather than silently
          // ignored. `.Mui-focused` is the global state class and is the same
          // name in v4 and v5, so one selector covers the unified theme's two
          // halves.
          '&.Mui-focused': {
            borderColor: tokens.accent.ring,
            boxShadow: `0 0 0 3px ${tokens.accent.subtle}`,
          },
        },

        /**
         * The padding lives on the input, not on the root.
         *
         * Putting it on the root was wrong and visibly so: a `Select` renders
         * its own `.MuiSelect-select` inside the root with padding of its own,
         * so the two stacked and the catalog's Kind and Type fields came out
         * roughly half again as tall as a plain text field. The chevron is
         * positioned against the root's edge rather than the inner padding, so
         * the value slid underneath it -- "Component" was rendering clipped.
         *
         * One layer of padding, on the element that holds the text.
         */
        input: {
          padding: '9px 12px',
          height: 'auto',
        },
      },
    },

    /**
     * Room for the chevron.
     *
     * `MuiSelect` reserves 24px of right padding for its icon by default, which
     * is measured against a field that has no border or padding of its own.
     * With both, the value runs into the icon. 34px clears it.
     */
    MuiSelect: {
      styleOverrides: {
        select: {
          paddingRight: 34,
          '&:focus': { backgroundColor: 'transparent' },
        },
        icon: { right: 8, color: tokens.fg.muted },
      },
    },

    /**
     * Autocomplete-backed filters -- Owner, Lifecycle, Tags on the catalog page.
     *
     * These wrap an input in their own root, so the field would otherwise be
     * bordered twice and padded twice. The inner input keeps the padding; the
     * wrapper contributes nothing but the endAdornment position.
     */
    MuiAutocomplete: {
      styleOverrides: {
        inputRoot: { paddingTop: 0, paddingBottom: 0 },
        endAdornment: { right: 8 },
      },
    },

    /**
     * Kills the underline the filled input above replaces.
     *
     * Both pseudo-elements have to go: `:before` is the resting rule and
     * `:after` is the animated focus rule, and leaving either draws a line
     * across the bottom of the new field.
     */
    MuiInput: {
      styleOverrides: {
        underline: {
          '&:before, &:after': { display: 'none' },
        },
      },
    },

    /**
     * Entity page tabs.
     *
     * Stock tabs are upper-cased and sit on a hard divider. Same reasoning as
     * the buttons: on a page where upper-case marks a label rather than a
     * destination, shouting tabs remove the distinction.
     */
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none' as const,
          fontWeight: 600,
          minWidth: 0,
          letterSpacing: 0,
        },
      },
    },

    /**
     * Entity-page cards.
     *
     * `InfoCard` is what the catalog puts on entity pages, and its header sat
     * at the same weight as its content. Given the same treatment as our own
     * card headers so an entity page does not look assembled from two kits.
     *
     * Note this does **not** reach the Repository activity card: ours is built
     * on BUI's `Card`, which uses CSS-module tokens rather than MUI.
     */
    BackstageInfoCard: {
      styleOverrides: {
        header: { padding: '16px 20px', borderBottom: `1px solid ${divider}` },
        headerTitle: { fontSize: '0.9375rem', fontWeight: 600 },
      },
    },

    /**
     * Sidebar item labels, which were truncating "Health Dashboard".
     *
     * The row is a 224px flex container holding three children:
     *
     * | child            | stock width                        |
     * | ---------------- | ---------------------------------- |
     * | iconContainer    | 72, with -16 margin -> 56 effective |
     * | label            | 110, `flex: 3 1 auto`              |
     * | secondaryAction  | 48 + 8 margin -> 56                |
     *
     * That is 112px committed before the label, leaving it 112 -- so its
     * 110px basis has essentially no free space to grow into, and `flex-grow`
     * never fires. The label was not merely capped; there was nothing to take.
     *
     * **`secondaryAction` is empty on every item here.** It exists for submenu
     * arrows and badges, and the nav renders plain `SidebarItem`s with no
     * children -- so 56px of every row was reserved for nothing. Sizing it to
     * its content collapses it to zero when empty and still sizes correctly if
     * a submenu is ever added, which frees that 56px for the label.
     *
     * Deliberately **not** widening the drawer. `sidebarOptions` widens it but
     * `SidebarPage` reads `drawerWidthOpen` from a context provided *inside*
     * `Sidebar`, so the content padding cannot follow and the drawer overlaps
     * the page when pinned. Taking back space the row was wasting needs no
     * width change, so that failure mode cannot recur.
     */
    BackstageSidebarItem: {
      styleOverrides: {
        /**
         * A hairline under every nav item.
         *
         * Only `Catalog` used to be separated, and not by anything of its own:
         * it sits between two explicit `SidebarDivider`s in `Sidebar.tsx`, so
         * it read as boxed while `Health Dashboard` and `Productivity` ran
         * together underneath. Giving the rule to the item rather than adding
         * more dividers means every nav entry is treated the same and a new
         * page gets it for free.
         *
         * The divider after `Catalog` is removed in `Sidebar.tsx` to match --
         * left in place it would double up with this border.
         */
        /**
         * **Both keys, and `buttonItem` is not redundant.** A nav link renders
         * as an `<a>` and picks up `root` alone, but the Search row renders as
         * a `<button>` and additionally gets `buttonItem`, whose `border: none`
         * beats `root` in the stylesheet. Setting only `root` left exactly one
         * row -- the first -- with no rule under it, which read as "no border
         * above Catalog".
         */
        buttonItem: {
          borderBottom: `1px solid ${tokens.nav.border}`,
          // Squared off, or the rule curves up at both ends.
          //
          // This row is a real `<button>`, so it also picks up the portal's
          // `MuiButton` radius -- and a border-bottom on a rounded box follows
          // the corners. Every other nav row is an `<a>` with no radius, so the
          // line above Catalog was the only one with hooked ends.
          borderRadius: 0,
        },
        root: {
          borderBottom: `1px solid ${tokens.nav.border}`,
          /**
           * Taller than the stock 48px, which is the other half of what the
           * dividers used to provide.
           *
           * `SidebarDivider` carries `margin: theme.spacing(1.2, 0)`, so each
           * one added roughly 20px of air on top of its rule. Replacing the
           * dividers with a per-item border kept the lines but lost that
           * breathing room, and the nav came out noticeably tighter than
           * before. Putting the space back on the item -- rather than as a
           * margin -- keeps each row a single box with its rule on the bottom
           * edge, instead of a rule floating between two rows.
           */
          height: 64,
        },
        secondaryAction: { width: 'auto', minWidth: 0, marginRight: 8 },
        // `overflow: hidden` and the ellipsis are left in place as the safety
        // net for a title longer than even the freed space.
        label: { width: 'auto', minWidth: 0, fontWeight: 500 },
      },
    },

    /**
     * The sidebar surface.
     *
     * `palette.navigation.background` is a translucent token now, which without
     * a blur behind it reads as washed out rather than frosted -- and the
     * palette cannot carry a `backdrop-filter`. Reached through the component's
     * own `drawer` class key rather than through global CSS, because
     * `BackstageSidebar` publishes one.
     *
     * The right-hand hairline replaces the stock hard edge; on a light sidebar
     * against a light page, some separation is needed or the nav dissolves into
     * the content.
     */
    BackstageSidebar: {
      styleOverrides: {
        drawer: {
          backdropFilter: tokens.blur,
          WebkitBackdropFilter: tokens.blur,
          borderRight: `1px solid ${tokens.nav.border}`,
        },
      },
    },

    /**
     * Lets a Grid item shrink below its content.
     *
     * A Grid item is a flex item, so it inherits `min-width: auto` from its
     * content -- and in CSS `min-width` **beats** `max-width`, so the 83.33%
     * cap that `lg={10}` sets is overridden by a wide table and the item grows.
     * The Grid container grows with it and the whole document scrolls
     * sideways, which is what the catalog page was doing.
     *
     * `min-width: 0` only ever *permits* shrinking; it is the standard remedy
     * and it restores the cap. If something elsewhere in the portal now wraps
     * where it used to push out, this is the override to suspect.
     */
    MuiGrid: {
      styleOverrides: {
        item: { minWidth: 0 },
      },
    },

    /**
     * Gives the table somewhere to scroll.
     *
     * **material-table handles no horizontal overflow at all** -- its bundle
     * sets `overflowY` and never `overflowX`. So once the Grid item above is
     * allowed to shrink, a table wider than it would be *clipped* rather than
     * scrolled, and the Tags column would become unreachable. This wrapper is
     * where the scroll has to live.
     *
     * Scoped to `BackstageTable` rather than put on `MuiPaper`, which every
     * dialog and dropdown in the portal also uses.
     */
    BackstageTable: {
      styleOverrides: {
        root: {
          minWidth: 0,
          overflowX: 'auto' as const,

          /**
           * The table's own title, brought into line with everything under it.
           *
           * material-table's toolbar carries `padding: 4px 0px 12px` -- no
           * horizontal padding at all -- so on the project page's Repositories
           * card the word "Repositories" sat **1px from the card's border**
           * while its own `NAME` header text sat at 21px and every other card
           * title in the portal is inset 20px. The title looked detached from
           * the table it belongs to.
           *
           * 20px matches `MuiTableCell`'s left padding, so the title lands on
           * the same vertical line as the first column's heading and its cells.
           *
           * **Scoped to `-root`, and the looser selector double-counted.**
           * `[class*="MTableToolbar"]` matches four elements -- the toolbar,
           * its title, its spacer and its actions -- so every one of them took
           * the 20px and the title ended up inset 41px instead of 21.
           *
           * **Only one table in the portal has this toolbar.** The catalog
           * renders its own "All Components (98)" heading outside the table --
           * measured: no `MTableToolbar` element on that page at all -- and the
           * fleet and productivity tables are hand-rolled HTML that material-UI
           * never touches. So this cannot reach anything else.
           */
          '& [class*="BackstageTableToolbar-root"]': {
            paddingLeft: 20,
            paddingRight: 20,
          },

          /**
           * The Type, Lifecycle and Description columns were hidden here by
           * position, with a rule reading
           * `thead th:nth-child(n + 4):not(:last-child):not(:nth-last-child(2))`
           * and a standing warning that a Backstage upgrade reordering the
           * columns would silently hide the wrong ones.
           *
           * **Gone, because the catalog page now names its columns.**
           * `packages/app/src/modules/catalog` overrides `page:catalog` and
           * passes `columns`, which is the proper fix the old note here called
           * unreachable. Nothing positional is left to break.
           */

          /**
           * Column widths.
           *
           * **material-table writes an inline `width: calc(267.75px)` onto
           * every visible cell**, dividing the table equally between the
           * columns it believes are showing. Measured in the running app, that
           * gave Name, Project and Owner 268px each -- so `Project`, which
           * holds "AM", got the same room as `Name`, which holds
           * `daarwyn-back-office-services` and wrapped onto a second line.
           * Every wrapped row was then twice the height of its neighbours,
           * which is what made the table look ragged.
           *
           * The column count it divides by does not account for the three
           * columns hidden above, and there is no prop to correct it -- so
           * this is fixed here, and `!important` is not decoration: an inline
           * style cannot be overridden any other way.
           *
           * **Deliberately positional but kind-agnostic.** Unlike the hiding
           * rule above, this makes no assumption about which column holds
           * what: Name is always first, Actions always last, Tags always
           * second-to-last (material-table appends actions at
           * `actionsColumnIndex: -1` unconditionally). So it behaves the same
           * on Users and Systems, which have a different column set.
           *
           * With every width back to `auto`, the browser's own table layout
           * sizes each column to its content and shares the slack in
           * proportion -- which is the behaviour material-table was
           * overriding, and it is better than any fixed percentage because it
           * adapts to whatever the estate actually contains.
           */
          // **Every selector here is scoped to `thead`/`tbody`, never a bare
          // `th`/`td`.** The table also has a `tfoot`, and its single cell is
          // the pagination bar -- floated right, `display: block`, `colspan=3`.
          // A bare `& td` reaches it: `width: auto !important` on a floated
          // block collapses it to its shrink-to-fit width, and it is also
          // `:last-child`, so the `width: 1%` rule below hit it as well. The
          // result was a 9px pagination cell with its controls overflowing
          // invisibly -- the bar was in the DOM the whole time, rendering as
          // nothing.
          //
          // **One rule, not two.** These are object keys, so a second
          // `'& th, & td'` block would not merge with this one -- it would
          // replace it, silently dropping the width reset above and taking the
          // equal-split straight back. Anything else that has to reach every
          // cell belongs in here.
          //
          // `white-space` is the second half of the same job. Every column here
          // holds a short bounded value -- a repository name, a project key, a
          // person, a few tags; the three long ones are hidden above. So a wrap
          // is never the table using space well, it is the auto layout breaking
          // "Subham Jain" over two lines to buy a neighbouring column room,
          // which it starts doing around 834px and which leaves some rows 33px
          // and others 54px.
          //
          // The alternative to wrapping is scrolling, and this component
          // already scrolls -- the rule below is what gives it somewhere to do
          // it. A uniform table that scrolls beats a ragged one that does both.
          '& thead th, & tbody td': {
            width: 'auto !important',
            whiteSpace: 'nowrap' as const,
          },

          // Tags hugs its content instead of taking an equal share.
          // `width: 1%` is the standard idiom for "shrink to max-content" in an
          // auto-laid-out table; the freed space goes to Name, Project and
          // Owner, which have something to show.
          //
          // **Scoped to the catalog's own content column, and it has to be.**
          // `BackstageTable` is every core-components `Table` in the portal,
          // not just the catalog's -- so an unscoped `:last-child` rule shrinks
          // whatever column happens to be last in any of them. It did: the
          // Repositories card on a project page rendered Owner at **7px**,
          // which is 1% of its 654px card, and the column read as a heading
          // above nothing. `MuiGrid-grid-lg-10` is `CatalogFilterLayout`'s
          // content column and appears on no other page.
          //
          // **One rule where there were two.** The second targeted
          // `nth-last-child(2)` because Tags sat beside an Actions column;
          // `actions={[]}` removed Actions, so that selector became Owner.
          '[class*="MuiGrid-grid-lg-10"] & thead th:last-child, [class*="MuiGrid-grid-lg-10"] & tbody td:last-child':
            {
              width: '1% !important',
              whiteSpace: 'nowrap' as const,
            },
        },
      },
    },

    /**
     * The card surface, which on the Material UI side of the portal is `Paper`.
     *
     * **This is where the frosted quality comes from on the MUI layer**, and it
     * is deliberately the same recipe the `[data-bg]` rule in `globalCss` gives
     * the Backstage UI layer: translucent surface, hairline border, soft
     * ambient shadow, large radius, backdrop blur. Two kits, one material --
     * which is the whole point, since an entity page shows both at once.
     *
     * The earlier note here said a hairline "keeps the page flat rather than
     * layered". That was right when the page was white on white and depth had
     * nowhere to read; against a tinted ground, a surface that never lifts just
     * looks like a mistake. Depth is back, but ambient rather than dropped.
     *
     * `elevation0` is left alone: Backstage uses it for things that are
     * deliberately not surfaces.
     */
    /**
     * The pagination bar under a table.
     *
     * Given a rule above it and real padding so it reads as the table's footer
     * rather than as something floating under the last row, and the arrows are
     * given the same rounded, bordered, accent-on-hover treatment as every
     * other control in the portal.
     */
    MuiTablePagination: {
      styleOverrides: {
        root: {
          borderTop: `1px solid ${divider}`,
          // The cell is floated right with `width: auto`; the theme's table
          // rules deliberately do not reach it (see `BackstageTable`).
          borderBottom: 'none',
        },
        toolbar: {
          minHeight: 52,
          paddingLeft: 16,
          paddingRight: 8,
        },
        caption: {
          color: tokens.fg.secondary,
          fontSize: '0.8125rem',
          fontVariantNumeric: 'tabular-nums' as const,
        },
        // The rows-per-page select, which sits between the two captions.
        input: { marginLeft: 8, marginRight: 24 },
      },
    },

    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          transition: 'background-color 140ms ease, color 140ms ease',
          '&:hover': {
            backgroundColor: tokens.accent.subtle,
            color: tokens.accent.base,
          },
        },
      },
    },

    MuiPaper: {
      styleOverrides: {
        rounded: { borderRadius: radius.lg },
        elevation1: {
          backgroundColor: tokens.surface[1],
          backdropFilter: tokens.blur,
          WebkitBackdropFilter: tokens.blur,
          border: `1px solid ${divider}`,
          boxShadow: tokens.shadow.card,
        },
        elevation2: {
          backgroundColor: tokens.surface[1],
          backdropFilter: tokens.blur,
          WebkitBackdropFilter: tokens.blur,
          border: `1px solid ${divider}`,
          boxShadow: tokens.shadow.card,
        },
        // Menus, popovers and dialogs. More opaque, because what is behind them
        // is arbitrary page content rather than a known background, and a
        // dropdown you can read the table through is not a dropdown.
        elevation4: {
          backgroundColor: tokens.surface[3],
          backdropFilter: tokens.blur,
          WebkitBackdropFilter: tokens.blur,
          border: `1px solid ${divider}`,
          boxShadow: tokens.shadow.raised,
        },
        elevation8: {
          backgroundColor: tokens.surface[3],
          backdropFilter: tokens.blur,
          WebkitBackdropFilter: tokens.blur,
          border: `1px solid ${divider}`,
          boxShadow: tokens.shadow.raised,
        },
      },
    },
  };
}

/**
 * A system font stack.
 *
 * The stock family is `"Helvetica Neue", Helvetica, Roboto, Arial,
 * sans-serif`, which on Windows resolves to **Arial** -- a notably wide face,
 * and part of why sidebar labels ran out of room sooner than their pixel
 * budget suggested. Putting Segoe UI ahead of it uses the font the operating
 * system already renders everywhere else, so the portal stops looking like a
 * web page pasted into a desktop.
 *
 * A fallback chain rather than a webfont: no network request, no layout shift
 * while a font loads, and nothing to self-host.
 */
const FONT_FAMILY = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(', ');

/**
 * A tighter type scale.
 *
 * The stock scale runs h1 54px down to h6 20px at weight 700 throughout --
 * sizes for a marketing page, on a portal whose densest view is 124 table
 * rows. A 54px page title pushes the content that matters below the fold and
 * leaves h4 through h6 too close together to establish any hierarchy.
 *
 * This roughly halves the top end and keeps consistent ~1.2x steps, so each
 * level is distinguishable from the next. Weight drops from 700 to 600:
 * semibold reads as deliberate where bold at 30px reads as shouting.
 */
const TYPOGRAPHY = {
  htmlFontSize: 16,
  fontFamily: FONT_FAMILY,
  h1: { fontSize: 30, fontWeight: 600, marginBottom: 12 },
  h2: { fontSize: 25, fontWeight: 600, marginBottom: 10 },
  h3: { fontSize: 21, fontWeight: 600, marginBottom: 8 },
  h4: { fontSize: 18, fontWeight: 600, marginBottom: 8 },
  h5: { fontSize: 16, fontWeight: 600, marginBottom: 6 },
  h6: { fontSize: 14, fontWeight: 600, marginBottom: 4 },
};

/**
 * The Material UI palette for one mode.
 *
 * **Built by spreading the stock palette and overriding, not by writing one
 * from scratch.** `BackstagePalette` carries around forty keys -- bursts,
 * banner, gold, pinSidebarButton -- most of which nothing in this portal
 * renders, but any one of them being absent is a runtime `undefined` inside
 * somebody else's component rather than a type error here. Spreading keeps
 * every key present and makes the diff exactly the set of things we mean to
 * change.
 *
 * **`text` is set explicitly, and has to be.** The stock Backstage palettes do
 * not define it, so Material UI derives it from `type` and light mode gets
 * `rgba(0, 0, 0, 0.87)` -- near-black. Every piece of body text in the Material
 * UI half of the portal would keep that and quietly disagree with the navy the
 * Backstage UI half uses.
 */
function buildPalette(tokens: PortalTokens) {
  const base = tokens.mode === 'light' ? palettes.light : palettes.dark;

  return {
    ...base,

    background: {
      ...base.background,
      // `body` paints the real page background from `--bui-bg-app`; this is
      // what Material UI hands to anything asking for the default ground.
      default: tokens.bg.app,
      paper: tokens.surface.solid,
    },

    text: {
      primary: tokens.fg.primary,
      secondary: tokens.fg.secondary,
      disabled: tokens.fg.muted,
      hint: tokens.fg.muted,
    },

    divider: tokens.border.soft,

    primary: { ...base.primary, main: tokens.accent.base },

    /**
     * `light` and `contrastText` are set explicitly, and that is the point.
     *
     * The relations graph on every entity page fills its focused node from
     * `palette.secondary.light` and labels it from `.contrastText` -- neither of
     * which Backstage declares, so Material UI derived them from `main`. On the
     * dark palette `main` is `#FF88B2`, and the entity you are looking at
     * rendered as a bright pink pill among emerald ones. Deriving them here
     * means the graph gets the colour we chose rather than a tint of it.
     */
    secondary: {
      main: tokens.accent.alt,
      light: tokens.accent.alt,
      dark: tokens.accent.alt,
      contrastText: tokens.accent.altOn,
    },

    navigation: {
      ...base.navigation,
      background: tokens.nav.background,
      color: tokens.nav.color,
      selectedColor: tokens.nav.selectedColor,
      indicator: tokens.nav.indicator,
      navItem: { hoverBackground: tokens.nav.hoverBackground },
      submenu: { background: tokens.nav.submenuBackground },
    },

    border: tokens.border.base,
    textContrast: tokens.fg.primary,
    textSubtle: tokens.fg.secondary,
    textVerySubtle: tokens.fg.muted,

    link: tokens.accent.base,
    linkHover: tokens.accent.hover,

    // Statuses come from the same three intents the score bands use, so a
    // pipeline dot and an "At risk" pill cannot end up different reds.
    status: {
      ...base.status,
      ok: tokens.status.positive.bg,
      warning: tokens.status.warning.bg,
      error: tokens.status.negative.bg,
      running: tokens.accent.base,
    },

    errorText: tokens.status.negative.fgSubdued,
    warningText: tokens.status.warning.fgSubdued,
    infoText: tokens.accent.base,

    tabbar: { indicator: tokens.accent.base },

    // The pin control sits on the sidebar, which is now a light surface in
    // light mode -- the stock near-white icon on it was invisible.
    pinSidebarButton: {
      icon: tokens.nav.selectedColor,
      background: tokens.nav.hoverBackground,
    },
  };
}

/** Both variants, built from the same overrides so they cannot drift. */
export function createPortalThemes(): {
  light: UnifiedTheme;
  dark: UnifiedTheme;
} {
  const build = (mode: ThemeMode) => {
    const tokens = portalTokens[mode];
    return createUnifiedTheme({
      palette: buildPalette(tokens),
      fontFamily: FONT_FAMILY,
      typography: TYPOGRAPHY,
      components: tableComponents(tokens),
    });
  };

  return { light: build('light'), dark: build('dark') };
}

/**
 * Global CSS, injected as a `<style>` element by the theme provider.
 *
 * **`MuiCssBaseline` does not work here.** Its `styleOverrides` only reach the
 * page if `<CssBaseline/>` is mounted, and `UnifiedThemeProvider` never mounts
 * one -- it provides the v4 `StylesProvider`/`ThemeProvider` and the v5
 * `StyledEngineProvider`/`ThemeProvider` and nothing else. Two rules were
 * written against it and silently did nothing, which is worth knowing before
 * reaching for it again.
 *
 * A `<style>` rather than MUI's `GlobalStyles`: that would mean adding
 * `@mui/material` as an app dependency, and editing `package.json` while the
 * dev server is watching it truncates the file mid-write.
 *
 * Both rules have to be global because their targets are unreachable any other
 * way -- BUI's header uses CSS-module classes no MUI override can see, and the
 * catalog's filter column has no class of its own. Hence `[class*=]` prefix
 * matching: the real names carry build hashes, e.g.
 * `Header_bui-HeaderTitleStack__f866914784`.
 */
export function globalCss(mode: ThemeMode): string {
  const t = portalTokens[mode];
  const divider = t.border.soft;

  return `
/* ------------------------------------------------------------------------- *
 * Backstage UI tokens.
 *
 * Every Fleet page and card, and the catalog page's outer shell, are built on
 * @backstage/ui, which a Material UI theme cannot reach at all. What it does
 * expose is 152 CSS custom properties, so redefining them here is what carries
 * the design system across to that half of the portal. This block is the
 * single reason those pages change appearance without being edited.
 *
 * TWO THINGS MAKE THIS WORK, AND BOTH ARE EASY TO BREAK:
 *
 * 1. Backstage UI declares its tokens inside '@layer tokens'. Unlayered CSS --
 *    which this is -- beats every layered declaration regardless of
 *    specificity, so none of this needs '!important' and none of it depends on
 *    out-weighing a selector.
 *
 * 2. **The selector must include 'body', not just ':root'.** Custom properties
 *    inherit, so ':root' alone looks sufficient. It is not: Backstage UI's dark
 *    tokens are declared on '[data-theme-mode='dark']', an attribute
 *    'UnifiedThemeProvider' puts on 'document.body' -- and a declaration on the
 *    element itself always beats a value inherited from an ancestor, layer or
 *    no layer. Declaring only on ':root' would therefore work in light mode and
 *    silently do nothing in dark.
 *
 * Only one of the two themes is mounted at a time, each rendering its own
 * '<style>', so there is no need to key these on the mode attribute.
 * ------------------------------------------------------------------------- */
:root,
body {
  /* Page and surfaces. 'body' is painted from --bui-bg-app in @layer base. */
  --bui-bg-app: ${t.bg.app};
  --bui-bg-neutral-1: ${t.surface[1]};
  --bui-bg-neutral-2: ${t.surface[2]};
  --bui-bg-neutral-3: ${t.surface[3]};
  --bui-bg-neutral-4: ${t.surface[4]};

  --bui-border-1: ${t.border.soft};
  --bui-border-2: ${t.border.base};

  --bui-fg-primary: ${t.fg.primary};
  --bui-fg-secondary: ${t.fg.secondary};

  /* One font stack across both kits. Backstage UI ships plain 'system-ui',
     which on Windows resolves to a different face than the Segoe-first chain
     the Material UI half uses -- two subtly different fonts on one page. */
  --bui-font-regular: ${FONT_FAMILY};

  /* Focus. The accent rather than Backstage UI's stock blue, so a focus ring
     reads as brand and matches the Material UI inputs. */
  --bui-ring: ${t.accent.ring};

  /* Shape. --bui-radius-3 is what Card uses; the rest are stepped around it
     so nothing in the kit ends up rounder than the cards. */
  --bui-radius-1: 4px;
  --bui-radius-2: 6px;
  --bui-radius-3: ${t.radius.md}px;
  --bui-radius-4: ${t.radius.lg}px;
  --bui-radius-5: ${t.radius.xl}px;
  --bui-radius-6: 24px;

  /* Intents. These drive the score bands on every Fleet surface, via
     bands.ts -- which is why -fg and -fg-subdued are kept distinct here:
     -fg is text ON the fill, -fg-subdued is coloured text on the page. */
  --bui-positive-bg: ${t.status.positive.bg};
  --bui-positive-bg-subdued: ${t.status.positive.bgSubdued};
  --bui-positive-fg: ${t.status.positive.fg};
  --bui-positive-fg-subdued: ${t.status.positive.fgSubdued};
  --bui-positive-border: ${t.status.positive.border};

  --bui-warning-bg: ${t.status.warning.bg};
  --bui-warning-bg-subdued: ${t.status.warning.bgSubdued};
  --bui-warning-fg: ${t.status.warning.fg};
  --bui-warning-fg-subdued: ${t.status.warning.fgSubdued};
  --bui-warning-border: ${t.status.warning.border};

  --bui-negative-bg: ${t.status.negative.bg};
  --bui-negative-bg-subdued: ${t.status.negative.bgSubdued};
  --bui-negative-fg: ${t.status.negative.fg};
  --bui-negative-fg-subdued: ${t.status.negative.fgSubdued};
  --bui-negative-border: ${t.status.negative.border};

  --bui-fg-positive: ${t.status.positive.fgSubdued};
  --bui-fg-negative: ${t.status.negative.fgSubdued};

  /* Deliberately NOT redefined: the solid-accent pair, the success / warning /
     danger surface triples, and the single legacy shadow token.

     @backstage/ui groups all of them under a "Deprecated tokens" heading in its
     own stylesheet, and this repo's no-deprecated-bui-tokens rule flags each by
     name. Nothing in this portal reads them -- the score bands go through the
     current positive / warning / negative intents above, no component here
     selects a semantic data-bg or uses Backstage UI's own primary Button, and
     the card shadow is set directly on the bui-Card rule below. Pinning values
     to tokens scheduled for removal would buy nothing and break quietly on the
     next upgrade.

     Their literal names are left out on purpose: this whole block is a CSS
     string, so the lint rule reads a comment naming them exactly as it reads a
     declaration using them, and spelling them here would warn three times over
     a note explaining why they are absent. */

  --bui-scrollbar: transparent;
  --bui-scrollbar-thumb: ${t.border.strong};

  /* ------------------------------------------------------------------- *
   * Portal-owned additions.
   *
   * Three tokens the Fleet components referenced for months that DO NOT
   * EXIST in @backstage/ui 0.17 -- checked against the shipped stylesheet,
   * where none of the three appears among the 152 real ones.
   *
   * Where a literal fallback was given, 'var(--bui-border-soft, #e2e7f0)',
   * it silently hardcoded a light-mode colour that never adapted to dark.
   * Where none was, '1px solid var(--bui-border)', the declaration was
   * invalid at computed-value time and border-color fell back to
   * 'currentColor' -- chips outlined in full-strength text.
   *
   * Defining them properly is cheaper than editing every call site, and it
   * fixes both modes at once. The call sites are being migrated to
   * 'plugins/fleet/src/surfaces.ts'; these keep the intervening states
   * correct and cost nothing to leave in place afterwards.
   * ------------------------------------------------------------------- */
  --bui-border: ${t.border.base};
  --bui-border-soft: ${t.border.soft};
  --bui-bg-surface-2: ${t.surface[2]};

  /* ------------------------------------------------------------------- *
   * The --portal-* namespace: tokens Backstage UI has no equivalent of.
   *
   * Kept separate from --bui-* on purpose. Those are redefinitions of
   * somebody else's contract and have to keep their meanings; these are
   * ours, and the prefix is what makes it obvious at a call site which
   * kind is being used and which one an upgrade could take away.
   *
   * **This is how the Fleet plugin reaches the theme at all.**
   * 'plugins/fleet' cannot import from 'packages/app' -- it is a separate
   * workspace package and the dependency would point the wrong way -- so a
   * custom property is the only channel between the theme and a Fleet
   * component's inline styles. See 'plugins/fleet/src/surfaces.ts'.
   * ------------------------------------------------------------------- */
  --portal-accent: ${t.accent.base};
  --portal-accent-hover: ${t.accent.hover};
  --portal-accent-subtle: ${t.accent.subtle};
  --portal-accent-on: ${t.accent.on};

  --portal-surface-solid: ${t.surface.solid};
  --portal-surface-raised: ${t.surface[3]};

  /* The page title bar's own ground.
     'PortalPageLayout' paints itself from this, and without it emitted the
     declaration is invalid at computed-value time -- measured in the running
     app the header resolved to rgba(0, 0, 0, 0), i.e. no ground at all, which
     collapses the sidebar/header/page/card ladder at its second step. */
  --portal-header-bg: ${t.bg.header};

  --portal-shadow-soft: ${t.shadow.soft};
  --portal-shadow-card: ${t.shadow.card};
  --portal-shadow-raised: ${t.shadow.raised};

  --portal-radius-sm: ${t.radius.sm}px;
  --portal-radius-md: ${t.radius.md}px;
  --portal-radius-lg: ${t.radius.lg}px;
  --portal-radius-pill: ${t.radius.pill}px;

  --portal-blur: ${t.blur};
  --portal-fg-muted: ${t.fg.muted};
}

/* The page ground: a flat colour plus three very low-amplitude radial washes.
   'fixed' so the gradient stays put while a long table scrolls under it --
   otherwise it slides away and the bottom of the catalog is flat grey. */
body {
  background-color: ${t.bg.app};
  background-image: ${t.bg.gradient};
  background-attachment: fixed;
  background-repeat: no-repeat;
}

/* ------------------------------------------------------------------------- *
 * The Backstage UI card surface.
 *
 * Card ships with NO border and NO shadow -- it is a bare rounded rectangle
 * whose only distinction from the page is its background. Against a tinted
 * ground that is not enough to read as a surface, so the border, ambient
 * shadow and blur are added here.
 *
 * Deliberately matched to the MuiPaper override above: an entity page shows a
 * Backstage UI card and a Material UI card side by side, and the single
 * clearest sign that a portal was themed rather than designed is those two
 * being made of different material.
 *
 * Prefix matching because the real class carries a content hash --
 * 'Card_bui-Card__d452bb14b2' -- which changes on any @backstage/ui upgrade.
 *
 * **The trailing '__' is load-bearing.** Backstage UI emits five classes from
 * this one stylesheet, and all of them contain the substring 'bui-Card':
 *
 *   Card_bui-Card__<hash>        <- the card itself, the only one wanted here
 *   Card_bui-CardHeader__<hash>
 *   Card_bui-CardBody__<hash>
 *   Card_bui-CardFooter__<hash>
 *   Card_bui-CardTrigger__<hash>
 *
 * So '[class*="bui-Card"]' matched every one of them, and gave the header and
 * the body their own border and corner radius *inside* the card -- boxes
 * within boxes on every card in the portal. The nested rule below stripped
 * their shadow and blur, which hid half the symptom and left the borders.
 * Matching 'bui-Card__' instead stops at the card, because the header's class
 * reads 'bui-CardHeader__'.
 * ------------------------------------------------------------------------- */
[class*="bui-Card__"] {
  border: 1px solid ${divider};
  border-radius: ${t.radius.lg}px;
  box-shadow: ${t.shadow.card};
  backdrop-filter: ${t.blur};
  -webkit-backdrop-filter: ${t.blur};
}

/* A card nested inside a card is already sitting on a blurred surface;
   blurring again costs a second compositing pass to change nothing visible,
   and a second shadow reads as a seam. */
[class*="bui-Card__"] [class*="bui-Card__"] {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
}

/* Horizontal padding only, aligned with BackstageInfoCard's 20px so a
   Backstage UI card and a Material UI card on the same entity page indent
   their content to the same line.

   padding-block is deliberately left alone: Backstage UI coordinates it with
   :has() rules -- a body following a header has its top padding zeroed, and a
   body above a footer its bottom -- and this stylesheet is unlayered, so
   setting it here would win and reopen the gap those rules close. */
[class*="bui-CardHeader__"],
[class*="bui-CardBody__"],
[class*="bui-CardFooter__"] {
  padding-inline: 20px;
}

/* Scrollbars, which on a dashboard are on screen constantly and stock are the
   loudest grey on the page. */
* {
  scrollbar-width: thin;
  scrollbar-color: ${t.border.strong} transparent;
}
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background-color: ${t.border.strong};
  border-radius: ${t.radius.pill}px;
  border: 3px solid transparent;
  background-clip: content-box;
}

/* A visible, branded focus ring on anything keyboard-reachable.

   Both halves matter: :focus-visible supplies the ring for keyboard users,
   and :focus:not(:focus-visible) removes the browser default for mouse users
   so the ring means "you are navigating by keyboard" rather than "you clicked
   something". */
/* Native form controls: the select popup, the scrollbars, the caret.

   'color-scheme' is the whole reason the repository dropdown on the
   productivity page did not match the portal, and it was declared NOWHERE in
   this codebase. It is the only channel by which a page tells the browser it is
   dark, and without it every piece of chrome the browser draws rather than the
   page comes from the OS default: the select popup and its highlight, the
   scrollbar track and thumb, the dropdown arrow, autofill backgrounds, date
   and number spinners. A near-black portal was opening a mid-grey list with the
   Windows accent blue on the selected row.

   Declared on ':root' as well as 'body' because the document scrollbar and the
   canvas hang off the root element, not off body -- the same trap as the token
   block above, in a different guise. Literal rather than token-driven: this
   stylesheet is emitted once per theme, so the mode is known here. */
:root,
body,
select,
textarea,
input {
  color-scheme: ${mode};
}

/* The popup list itself, as far as CSS can reach it.

   **Best-effort and engine-dependent, unlike the rule above.** The option list
   is drawn by the browser, not composited from the page: Blink and Gecko honour
   a background and a colour on 'option', WebKit ignores both. So 'color-scheme'
   is what carries Safari to something reasonable, and these rules are what stop
   Chrome's dark popup reading as neutral grey beside a green-cast portal.
   Neither can restyle the popup's border, shadow or corner radius, and full
   control would mean replacing the control with a listbox -- keyboard
   navigation, ARIA and focus management included.

   **Opaque values only.** The popup is painted over whatever the window manager
   has behind it rather than over the page, so a translucent surface token would
   composite against something unknowable. That rules out surface[3], the
   raised-ground token this would otherwise take. */
option,
optgroup {
  background-color: ${t.surface.solid};
  color: ${t.fg.primary};
}
option:disabled {
  color: ${t.fg.muted};
}
/* The selected row. Chrome overrides this with the system highlight in some
   versions, which is why the rule above has to stand on its own. The pair is
   the already contrast-tested one -- note that in dark mode 'accent.on' is
   near-black, because white on this emerald measures 2.5:1. */
option:checked {
  background-color: ${t.accent.base};
  color: ${t.accent.on};
}

:focus-visible {
  outline: 2px solid ${t.accent.ring};
  outline-offset: 2px;
  border-radius: ${t.radius.sm}px;
}
:focus:not(:focus-visible) { outline: none; }

/* Accessibility fallbacks.

   Translucency is a preference some people switch off at the OS level, and
   honouring that is the difference between a design choice and an imposition.
   Surfaces go solid; nothing else about the layout changes. */
@media (prefers-reduced-transparency: reduce) {
  :root, body {
    --bui-bg-neutral-1: ${t.surface.solid};
    --bui-bg-neutral-3: ${t.surface.solid};
  }
  [class*="bui-Card"] {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}

/* The catalog page's title is blanked through the translation ref, but
   bui-HeaderTitleStack is height:1lh at --bui-font-size-6, so an empty title
   still reserved a full line of a large font between the breadcrumb and the
   table. Scoped by :empty so pages that do have a heading keep it. */
[class*="bui-HeaderTitleStack"]:has([class*="bui-HeaderTitle"]:empty) {
  display: none;
}

/* ...and then collapse the row that stack was sitting in.

   Hiding the stack left its parent behind: bui-HeaderContent is 24px tall with
   12px of block padding, so 48px of entirely empty space sat between the page
   title and the content on every catalog page. Measured, not estimated -- the
   grid started at y=129 where the page header ended at y=61.

   This is duplicate chrome rather than a styling problem. The portal renders
   its own page title through PortalPageLayout now, which is why the catalog's
   is blanked in the first place; the Backstage UI header underneath it has
   nothing left to show.

   Both conditions are required, and the second is the safety catch:
   bui-HeaderContent also carries a controls slot, and hiding the row because
   its title happens to be empty would take any buttons in it too. Only a header
   with an empty title AND nothing in its controls is dead weight.

   Measured rather than assumed, and wrong twice before this. The first attempt
   tested the title stack for :only-child, which never matched because
   bui-HeaderContent has two children -- the stack and a bui-HeaderControls
   beside it. The second tested whether the controls slot had any element
   child, which never matched either: it holds a support-button wrapper that
   renders at 0x0 with nothing inside it, because no support URL is configured.

   So the test is for a non-EMPTY descendant, not for a descendant. An element
   with neither children nor text matches :empty, which is exactly the state
   that unrendered support button is in -- and exactly the state it would leave
   the moment somebody configured one, at which point this rule stops applying
   and the header comes back on its own. */
[class*="bui-HeaderContent"]:has([class*="bui-HeaderTitle"]:empty):not(
    :has([class*="bui-HeaderControls"] *:not(:empty))
  ) {
  display: none;
}

/* The other two thirds of that header.

   Backstage UI's Header is three sibling containers, not one element:
   bui-HeaderTop, bui-HeaderContent and bui-HeaderBottom. Top and Bottom are
   zero-height on the catalog page but Bottom still carries a 20px bottom
   margin, so hiding the middle one alone would leave a fifth of the gap
   behind. Collapsed only when they hold no elements at all, so the tab row and
   toolbar that Bottom exists for are untouched wherever a page has them. */
[class*="bui-HeaderTop"]:not(:has(*)),
[class*="bui-HeaderBottom"]:not(:has(*)) {
  display: none;
}

/* The kind tag above an entity's title -- and it is two problems in one row.

   bui-HeaderTop holds a single tag rendered from 'entity.kind', so a project's
   page opened with the word "System" in 14px grey above "MDLH". Every other
   surface in this portal calls that a Project, and this one could not be made
   to agree: the tag is the raw kind string, not a translated label, so there is
   nothing to rename -- 'entityLabels.systemLabel' reaches the metadata row
   below it and not this.

   Hidden rather than renamed, because on every kind it is redundant as well as
   wrong: the About card states the kind, the breadcrumb states the section, and
   the title states the entity. It was 20px spent contradicting the rest of the
   page.

   Scoped to the tag row, so bui-HeaderTop keeps working anywhere it holds
   something else. */
[class*="bui-HeaderTags"] {
  display: none;
}

/* The project line in an entity header, removed rather than corrected.

   'HierarchyLinks' renders 'ref.name' -- the System's entity name, which
   'toSystemName' lowercases -- and never loads the System, so it cannot reach
   'metadata.title'. Backstage's own code is asymmetric here: the Owner line
   two fields along DOES resolve a title, because it fetches the owner entity,
   while a 'partOf' relation gets the bare ref.

   So the header could only ever say "dds" where the About card beside it and
   the relations graph below both say "DAI Delivery Systems". A previous version
   of this rule upper-cased it to "DDS", which fixed the casing and left the
   page showing one field two ways.

   The About card is the surface that gets this right, so the header's copy
   goes. Targeted by markup, not position: a hierarchy value is a list, so its
   item is the one containing 'dd ul', where an Owner's anchor is a direct child
   of 'dd'. That is what keeps this off Owner.

   Reaching the full name here instead would mean replacing the entity page --
   'EntityLayoutBui' imports the header directly, so nothing smaller gets at
   it -- and that trade was declined: a copied upstream factory to maintain for
   one label. */
[class*="bui-HeaderMetaItem"]:has(dd ul) {
  display: none;
}

/* The favourite (star) control on entity pages.

   Nothing in this portal uses starring. The catalog's Starred filter went with
   'catalog-filter:catalog/list', the star action went with the table's Actions
   column, and no page reads 'starredEntitiesApiRef' -- so the button could set
   a preference that nothing would ever read back.

   'FavoriteEntityButton' is rendered inside 'EntityHeaderBui' and is neither an
   extension nor a swappable component, so CSS is the only route. It cannot be
   done by hiding 'bui-HeaderControls', which also holds the context menu.

   **Matched on the aria-label, which is the only thing that distinguishes it**
   from the menu button beside it -- the substring covers both states, since the
   label toggles between "Add to favorites" and "Remove from favorites". Both
   spellings are listed because the wording comes from
   'catalogReactTranslationRef' and a locale could use either. If a future
   Backstage renames those keys this rule stops matching and the star returns,
   which is the failure mode to expect. */
[class*="bui-HeaderControls"] [aria-label*="favorite" i],
[class*="bui-HeaderControls"] [aria-label*="favourite" i] {
  display: none;
}

/* The owner's avatar and name, which were never actually laid out.

   Backstage UI gives that link 'align-items: center' and 'gap: 8px' -- and
   sets 'display: inline-block', on which **both are inert**. They only take
   effect on a flex or grid container. So the declared 8px never existed: the
   name butted straight against the 24px avatar, and its vertical position came
   from inline baseline metrics rather than from being centred against it.
   Measured: avatar at x=297 w=24, name starting at x=321.

   'inline-flex' rather than 'flex' so the link stays inline inside its 'dd'
   instead of becoming a block and taking the full row width. Nothing else is
   added -- the gap and the centring are BUI's own values, finally applying.

   Scoped to a direct link in a header metadata value, which is the Owner. A
   hierarchy value is a list and is hidden by the rule above. */
[class*="bui-HeaderMetaItem"] dd > [class*="bui-Link"] {
  display: inline-flex;
}

/* The Lifecycle item in an entity header's metadata row.

   Paired with a blanked 'entityLabels.lifecycleLabel' in
   'packages/app/src/modules/i18n/catalog.ts' -- see there for why neither half
   works alone. This matches the item by its label being EMPTY rather than by
   its position, which is what makes it safe on every kind: lifecycle is pushed
   first when present, but a System has none, so its first item is Owner and a
   ':first-child' rule would hide the wrong thing.

   An earlier note claimed this could not be removed at all. It can; the route
   is a translation ref and ':empty', both of which this portal already uses. */
[class*="bui-HeaderMetaItem"]:has(dt [class*="bui-Text"]:empty) {
  display: none;
}

/* Height reclaimed above an entity page's content.

   Measured on a project page: the header ran from y=85 to y=250, and 165px to
   introduce a title and one line of metadata is generous. The tag row above
   accounts for 20 of it; the rest is padding either side of the title and a
   20px margin under a tab row that, on a single-tab page, is already mostly
   air.

   The tab row itself is left alone -- component pages carry several tabs and
   collapsing it would cost navigation to buy whitespace. */
[class*="bui-HeaderContent"] {
  padding-top: 2px;
  padding-bottom: 6px;
}
[class*="bui-HeaderBottom"] {
  margin-bottom: 8px;
}

/* Page gutters, matched across the portal.

   bui-Container adds 20px of its own horizontal padding inside the 24px that
   PortalPageLayout already applies, so every page built on the Backstage UI
   shell -- the catalog, the entity pages -- sat 44px from the edge while the
   fleet and productivity pages sat at 24px. The difference is small enough to
   read as sloppiness rather than intent when you move between them.

   The portal's page shell owns the gutter; this container should only be
   deciding maximum width. Note this corrects the note in CLAUDE.md that the
   catalog page's outer gutters are not themeable: that was true when a Material
   UI theme was the only lever, and stopped being true once we owned the
   Backstage UI layer. */
[class*="bui-Container"] {
  padding-left: 0;
  padding-right: 0;
}

/* The filters sit ABOVE the table, not in a column beside it.

   Two filters remain -- Owner and Tags -- and a two-item column down the left
   of a 1900px page left most of that column empty while squeezing the table
   into 83% of the width.

   **The wrap is the mechanism, and it used to be the hazard.** The note that
   stood here explained that the two grid items are sized by percentage
   flex-basis totalling 100%, so any margin between them overflows the row and
   drops the table underneath the filters. That is now the goal: giving the
   filters the whole row makes the table wrap below them, which is precisely the
   layout wanted. So the old 24px left inset on the table is gone -- there is no
   longer a column to its left to be separated from -- and the gap is a
   margin under the filter card instead.

   Both items need a max-width as well as a flex-basis: MUI pins
   'max-width: 16.666667%' and '83.333333%' on these classes, and a flex-basis
   alone is clamped by it.

   Behind the lg breakpoint because that is the only place the column exists.
   Below 1280px CatalogFilterLayout.Filters renders a button and a drawer
   rather than a grid item, so none of this applies and the drawer is
   untouched. */
@media (min-width: 1280px) {
  [class*="MuiGrid-grid-lg-2"],
  [class*="MuiGrid-grid-lg-10"] {
    flex-basis: 100%;
    max-width: 100%;
  }
  [class*="MuiGrid-grid-lg-10"] {
    padding-left: 0;
  }
}

/* The catalog's filter column, given the table's card treatment. Of the
   filters only UserListPicker renders a Card, so the MuiPaper override had
   bordered exactly one filter and left Kind, Type, Owner and Tags -- bare
   Boxes with no class -- floating. Selected by the grid width that
   CatalogFilterLayout.Filters uses, because nothing identifies the column
   itself. Nothing else in this portal uses lg={2}: our own pages use Flex,
   entity pages use a CSS grid. */
[class*="MuiGrid-grid-lg-2"] {
  align-self: flex-start;
  padding: 8px 14px;
  border: 1px solid ${divider};
  border-radius: ${t.radius.lg}px;
  background: ${t.surface[1]};
  box-shadow: ${t.shadow.card};
  backdrop-filter: ${t.blur};
  -webkit-backdrop-filter: ${t.blur};

  /* A single compact band now that the card spans the page. */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  /* The separation the table's left padding used to provide. */
  margin-bottom: 12px;
}

/* Each filter takes a readable width and no more.

   'flex: 0 1' rather than '1 1': two filters allowed to grow would take half a
   1900px page each, which makes a one-line dropdown read as a form field on a
   sign-up page. They keep their size and sit left, and 'flex-wrap' above means
   a third filter -- or a narrow window -- moves to a second line instead of
   crushing them. The hidden Kind and user-list pickers render null and so are
   not children here at all. */
[class*="MuiGrid-grid-lg-2"] > * {
  flex: 0 1 17rem;
  min-width: 12rem;
}

/* Reclaiming the vertical space the stacked column used to justify.

   Measured before this: a 136px band holding two one-line dropdowns. It came
   from four places, none of them the control itself -- 32px of card padding,
   16px on each picker's own outer Box, another 16px of margin on the Box
   inside it, and a label set ABOVE its control rather than beside it.

   The pickers are laid out for a narrow left-hand column, where stacking a
   label over its input is right. In a horizontal band it is what makes two
   dropdowns 136px tall, so the label element becomes a flex row and the text
   sits alongside. */
[class*="MuiGrid-grid-lg-2"] > [class*="MuiBox-root"] {
  padding: 0;
}
[class*="MuiGrid-grid-lg-2"] [class*="MuiBox-root"] [class*="MuiBox-root"] {
  margin: 0;
}
[class*="MuiGrid-grid-lg-2"] label[class*="MuiTypography-root"] {
  display: flex;
  align-items: center;
  gap: 8px;
  /* A label that wraps would reintroduce the second line this removes. */
  white-space: nowrap;
}
/* The label text and its control are NOT interchangeable flex items, and
   treating them as one rule erased the labels.

   A single 'label > *' selector gave both 'flex: 1 1 auto; min-width: 0'. The
   control wants more width than 17rem leaves, so the text span -- now
   shrinkable to nothing -- collapsed to zero and "Owner" and "Tags" simply
   disappeared, leaving two unlabelled dropdowns.

   The text is sized by its content and never shrinks; only the control flexes.
   'min-width: 0' belongs on the control alone, because a flex item otherwise
   refuses to go below its content's minimum, which for a select with two icons
   is wider than the space available. */
[class*="MuiGrid-grid-lg-2"] label[class*="MuiTypography-root"] > span {
  /* **'position: static' is the other half of removing the 24px offset.** The
     picker's label is absolutely positioned INTO the space that the input's
     'margin-top: 24px' reserves -- the two are a pair. Zeroing the margin
     without releasing the label left it out of flow, overlapping the input and
     hidden behind its background: the band was 64px tall with no visible
     "Owner" or "Tags" at all. Out of flow it also ignored every flex property
     set on it, which is why 'flex: 0 0 auto' alone changed nothing. */
  position: static;
  flex: 0 0 auto;
}
[class*="MuiGrid-grid-lg-2"] label[class*="MuiTypography-root"] > div {
  flex: 1 1 auto;
  min-width: 0;
}

/* **The 24px that made the band 70px tall.** Material UI offsets an input by
   'margin-top: 24px' to leave room for a label sitting ABOVE it -- the
   'InputLabel' shrink position. Measured here: a 46px control inside a 70px
   box. With the label alongside instead, that reservation is empty space, and
   it was the single largest contributor once the padding and margins were out.

   Scoped to the filter band, because everywhere else in the portal the label
   genuinely is above its input and the offset is doing its job. */
[class*="MuiGrid-grid-lg-2"] [class*="MuiInputBase-root"] {
  margin-top: 0;
}

/* The pagination captions: "Rows per page:" and "1-20 of 96".

   Something in the Table stack sets display:none on
   MuiTablePagination-caption, so the row count never showed and the controls
   sat alone at the far right with nothing saying where in 96 rows you were.

   **This rule only became worth writing once 'page:catalog' was overridden.**
   Before that the caption was hidden *and* empty -- material-table's default
   'MTablePagination' renders arrows and never populates it, so un-hiding it
   revealed a 0px box. With 'paginationType: 'stepped''
   ('modules/catalog/index.tsx') material-table fills it from
   'table.pagination.labelDisplayedRows', and there is now text to reveal.

   Unlayered so it beats the JSS rule without depending on injection order,
   which JSS does not guarantee. */
[class*="MuiTablePagination-caption"] {
  display: block;
}

/* The numbered page buttons.

   MTableSteppedPagination renders each page as a MuiButton, so left alone they
   inherit the portal's button sizing -- 6px/14px padding, semibold -- which for
   a single digit is a row of wide slabs. Squared off to a 30px tap target
   instead, with the current page filled in the accent so it reads at a glance
   rather than by font weight alone.

   Targeted here rather than through a MuiButton style override, because that
   would reach every button in the portal; there is no theme key for a
   material-table internal. */
[class*="MTableSteppedPagination"] button[class*="MuiButton-root"] {
  min-width: 30px;
  width: 30px;
  height: 30px;
  padding: 0;
  margin: 0 2px;
  border-radius: ${t.radius.sm}px;
  font-weight: 500;
  color: ${t.fg.secondary};
}

[class*="MTableSteppedPagination"] button[class*="MuiButton-contained"],
[class*="MTableSteppedPagination"] button[class*="Mui-disabled"][class*="MuiButton-root"] {
  background: ${t.accent.subtle};
  color: ${t.accent.base};
  font-weight: 700;
}

/* The inner Card would otherwise double-border inside that one. */
[class*="MuiGrid-grid-lg-2"] [class*="MuiPaper"] {
  border: none;
  box-shadow: none;
  background: transparent;
}

/* The rule above Settings, at the foot of the sidebar.

   Styled here rather than through the theme, which does not work for this one.
   SidebarDivider is a v4 'styled' carrying name: 'BackstageSidebarDivider', so
   a components override looks like the right tool -- but supplying one wiped
   the styled's own rule entirely rather than merging with it, and the element
   fell back to the browser default: a 2px inset grey hr with auto margins,
   which is why it was rendering as a pale line indented from both edges.

   So every property it needs is restated here, unlayered. */
nav [class*="BackstageSidebarDivider"] {
  height: 1px;
  width: 100%;
  border: none;
  margin: 0;
  background: ${t.nav.border};
}

/* The catalog's Owned / Starred filter rows were styled here -- about 80 lines
   relaying out MuiListItem's absolutely positioned secondary action so the
   labels stopped clipping to "Owne" and "Starre".

   **Removed as dead**, not as tidying: that block belonged to
   'UserListPicker', which went with 'catalog-filter:catalog/list'. Proven
   before deleting rather than assumed -- its three selector families were
   counted against the live DOM over seven pages (catalog, component, project,
   fleet, productivity, search, settings) and matched **zero** elements.

   If the Personal filter is ever re-enabled the clipping returns, and the
   remedy is in this file's history: make the row a flex container and pull the
   count out of absolute positioning, rather than trimming the 48px reservation,
   which is a guess about a column whose width is a percentage of the viewport.
*/
`;
}
