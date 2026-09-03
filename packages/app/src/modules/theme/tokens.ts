/**
 * The portal's design tokens: the single source of truth for colour, depth,
 * shape and rhythm, in both modes.
 *
 * **Why a file rather than values inline in the theme.** Three separate
 * rendering layers have to agree on these, and none of them can read the
 * others' configuration:
 *
 * | layer            | where it appears                                 | how it is reached |
 * | ---------------- | ------------------------------------------------ | ----------------- |
 * | Material UI v4   | catalog table, entity shells, sidebar, buttons    | `createUnifiedTheme` component overrides |
 * | Backstage UI     | every Fleet page and card, the catalog page shell | `--bui-*` custom properties |
 * | hand-rolled HTML | the two Fleet tables, chips, inputs, sparklines    | inline `style` objects |
 *
 * A colour written into only one of them is a colour the other two drift away
 * from. Everything below is consumed by all three, from here.
 *
 * **Token names deliberately mirror Backstage UI's own.** `@backstage/ui`
 * already ships 152 custom properties covering almost exactly the vocabulary we
 * need -- backgrounds, neutral surface steps, borders, foregrounds, radii,
 * spacing, shadow, focus ring, and positive/warning/negative triples. Adopting
 * its names means the mapping in `globalCss` is one-to-one and there is no
 * translation table to keep in step.
 *
 * **No raw colour belongs outside this file.** If a component needs one, it
 * takes a token; if no token fits, the answer is a new token rather than a
 * literal.
 */

/** Light or dark. Both are authored together so neither can be forgotten. */
export type ThemeMode = 'light' | 'dark';

/**
 * One intent's four colours.
 *
 * The distinction between `fg` and `fgSubdued` is the one already got wrong
 * once in this codebase, and written down in `bands.ts`:
 *
 * - `bg` is a saturated fill.
 * - `fg` is the text colour **for use on that fill** -- near-black or
 *   near-white, not a colour in its own right.
 * - `fgSubdued` is coloured text readable against the ordinary page background.
 * - `border` is a hairline for a tinted callout.
 *
 * Using `fg` as a standalone text colour paints everything black and white.
 */
export interface StatusTokens {
  bg: string;
  /**
   * A quiet tint of the same hue, for a fill that should read as a status
   * without shouting.
   *
   * BUI publishes `--bui-<intent>-bg-subdued`, but this theme overrides only
   * `bg`, `fg`, `fg-subdued` and `border` -- so anything using the subdued
   * background fell through to BUI's own palette, which is a different hue
   * family (mint `#96f0b6` against this theme's emerald `#12864a`). Declaring
   * it here keeps the quiet fill and the loud one recognisably the same colour.
   *
   * Paired with `fgSubdued` for text, and the contrast test covers that pair.
   */
  bgSubdued: string;
  fg: string;
  fgSubdued: string;
  border: string;
}

export interface PortalTokens {
  mode: ThemeMode;

  /**
   * The page itself.
   *
   * `app` is a flat colour and is what `body` is painted with, so it is the
   * fallback whenever the gradient cannot render. `gradient` layers over it:
   * three very low-amplitude radial washes, which is what stops a large empty
   * page reading as a flat slab without introducing a colour that anything has
   * to stay legible against.
   */
  bg: {
    app: string;
    gradient: string;
    /**
     * The page title bar, which is NOT the sidebar.
     *
     * It used to be: `PortalPageLayout` painted itself from
     * `palette.navigation.background`, so the two could not be told apart by
     * construction, however the sidebar was coloured. They are separate grounds
     * now, one step apart, and the sidebar is free to carry the brand.
     *
     * Reaches the layout as `--portal-header-bg` rather than through the
     * Material UI palette: `palette.navigation` is documented below as being
     * exactly the keys the sidebar reads, and a key nothing in
     * `core-components` looks for does not belong in it.
     */
    header: string;
  };

  /**
   * Surface steps, in nesting order.
   *
   * These map onto `--bui-bg-neutral-1..4`, which Backstage UI resolves through
   * a `data-bg` attribute and increments automatically as surfaces nest. So the
   * numbering is not arbitrary: `1` is a card on the page, `2` is a recessed
   * panel inside a card, `3` is something raised above both -- a menu or
   * popover, which needs more opacity because it has arbitrary content behind
   * it.
   *
   * They are translucent, which is where the frosted quality comes from: the
   * background gradient modulates through them instead of every card being the
   * same dead white.
   */
  surface: {
    1: string;
    2: string;
    3: string;
    4: string;
    /**
     * The same material, fully opaque.
     *
     * For surfaces on a scrolling hot path -- the 96-row fleet table, the
     * catalog's 124 -- where compositing a translucent layer every frame is
     * where "premium" turns into "janky". Reads as the same colour, costs
     * nothing.
     */
    solid: string;
  };

  border: {
    soft: string;
    base: string;
    strong: string;
  };

  fg: {
    primary: string;
    secondary: string;
    muted: string;
  };

  /**
   * Depth, in three steps.
   *
   * Wide and very low-alpha rather than the tight dark drop shadow Material UI
   * ships: the design language is soft ambient depth, and a hard shadow at this
   * radius reads as a cut-out. Dark mode gets tighter, weaker shadows -- a large
   * soft shadow over a dark ground is a smudge, not a lift.
   */
  shadow: {
    soft: string;
    card: string;
    raised: string;
  };

  /** Pixels, shared across both modes -- shape does not vary with mode. */
  radius: {
    sm: number;
    md: number;
    lg: number;
    xl: number;
    pill: number;
  };

  /**
   * The blur behind a translucent surface.
   *
   * Applied only to surfaces that do not scroll their own content. See
   * `surface.solid` for why.
   */
  blur: string;

  accent: {
    base: string;
    hover: string;
    /** A tint of the accent, for selected rows and hover states. */
    subtle: string;
    /** Text on top of `base`. */
    on: string;
    /** The focus ring. Deliberately the accent, so focus reads as brand. */
    ring: string;
    /**
     * A second accent, for the one place a thing must read as "not the
     * accent" -- Material UI's `palette.secondary`.
     *
     * The relations graph on every entity page fills its focused node from
     * `palette.secondary.light` and labels it from `.contrastText`. Backstage's
     * dark palette sets `secondary.main` to **#FF88B2**, so that node rendered
     * bright pink against an emerald page; the light palette declares no
     * secondary at all and inherited Material UI's default pink. Indigo instead
     * -- the hue already in the page's own background wash -- so the focused
     * node still stands apart from the emerald ones without leaving the scheme.
     */
    alt: string;
    /** Text on top of `alt`. */
    altOn: string;
  };

  status: {
    positive: StatusTokens;
    warning: StatusTokens;
    negative: StatusTokens;
  };

  /**
   * The sidebar.
   *
   * These are exactly the keys `@backstage/core-components`' sidebar reads from
   * `palette.navigation` -- checked against its source rather than assumed,
   * because a missing one falls back to the stock near-black and the nav then
   * looks like a different product from the page beside it.
   *
   * **`selectedColor` is also the logo wordmark's colour.** `LogoFull` takes it
   * from the theme rather than hardcoding white, which is what lets the sidebar
   * be light here without the brand name disappearing.
   */
  nav: {
    background: string;
    color: string;
    selectedColor: string;
    indicator: string;
    hoverBackground: string;
    submenuBackground: string;
    /** A hairline between sidebar and page, rather than the stock hard edge. */
    border: string;
  };
}

/**
 * Shape, shared.
 *
 * Large rounded corners without becoming a lozenge: 14px on a card is generous
 * at card scale and still square enough that a pill chip beside it reads as the
 * same family rather than the same shape.
 */
const RADIUS = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * The accent, in light mode.
 *
 * A green-teal: the same hue family as the logo tile's `#12665E`, which it sits
 * beside without clashing, but pulled towards the emerald the dark reference
 * uses so the two modes share one brand colour rather than reading as two
 * products. Darker than the dark mode's `#19b982` because it has to carry as
 * text on a near-white page -- it measures 5.8:1 there, where the emerald
 * itself would be 2.2:1 and illegible.
 */
const BRAND = '#0c6b4a';

export const lightTokens: PortalTokens = {
  mode: 'light',

  bg: {
    // A pale tint of the brand, not white and no longer blue-gray. Besides the
    // brief's explicit "avoid a plain harsh white application background", it
    // is what makes a near-white card visible as a surface at all: against
    // #fff a white card has to be drawn with a border to exist.
    //
    // **Darker than the #eef2f7 it replaces, and it had to be.** The three
    // page grounds were measured before this change and the ladder was
    // *inverted*: the sidebar composited to #f9fafc, LIGHTER than the page and
    // within two units of a card, which is why it dissolved into the content
    // rather than reading as a region. Sidebar 200, header 223, page 232, card
    // 250 on the red channel -- monotonic, four distinct steps.
    app: '#e8eeea',
    header: '#dfe8e3',
    gradient: [
      // 0.42, not the 0.85 this was. A near-opaque white radial anchored at
      // 12% -12% put roughly 49% white behind the header and 38% behind the top
      // of the sidebar -- the exact corner where the grounds have to be
      // distinguishable, and enough to wash out any token change made here.
      'radial-gradient(1100px 620px at 12% -12%, rgba(255, 255, 255, 0.42), transparent 62%)',
      'radial-gradient(900px 520px at 98% -6%, rgba(12, 107, 74, 0.07), transparent 58%)',
      'radial-gradient(1000px 700px at 50% 118%, rgba(148, 176, 206, 0.16), transparent 65%)',
    ].join(', '),
  },

  surface: {
    1: 'rgba(255, 255, 255, 0.78)',
    2: 'rgba(214, 224, 236, 0.35)',
    3: 'rgba(255, 255, 255, 0.92)',
    4: 'rgba(214, 224, 236, 0.55)',
    solid: '#fbfcfe',
  },

  border: {
    soft: 'rgba(20, 40, 66, 0.06)',
    base: 'rgba(20, 40, 66, 0.11)',
    strong: 'rgba(20, 40, 66, 0.2)',
  },

  fg: {
    // Dark navy, not black: the design language is blue-gray throughout, and
    // pure black against a tinted ground reads as a foreign element.
    primary: '#152232',
    secondary: '#556579',
    // Darkened from #59697d, which measured 4.487:1 on the new page header --
    // under AA by 0.013, and found by `tokens.test.ts` rather than by eye.
    //
    // The alternative was to lighten the header instead, and it was the worse
    // trade: it would have cut the header-to-page step from 9 units to 6 to buy
    // back 0.13 of contrast, undoing the separation this change exists to
    // create. Darkening the palest text improves every ground at once -- page
    // 4.77 to 4.92, card 5.41 to 5.58 -- and costs the ladder nothing.
    muted: '#57677a',
  },

  shadow: {
    soft: '0 1px 2px rgba(16, 32, 55, 0.04)',
    card: '0 1px 3px rgba(16, 32, 55, 0.05), 0 10px 26px -14px rgba(16, 32, 55, 0.16)',
    raised:
      '0 4px 12px rgba(16, 32, 55, 0.1), 0 24px 48px -18px rgba(16, 32, 55, 0.24)',
  },

  radius: RADIUS,

  blur: 'blur(14px) saturate(1.4)',

  accent: {
    base: BRAND,
    hover: '#095239',
    subtle: 'rgba(12, 107, 74, 0.1)',
    on: '#ffffff',
    ring: BRAND,
    alt: '#5b57d8',
    altOn: '#ffffff',
  },

  status: {
    positive: {
      bg: '#12864a',
      bgSubdued: '#dff0e6',
      fg: '#ffffff',
      fgSubdued: '#0e6d3c',
      border: 'rgba(18, 134, 74, 0.28)',
    },
    warning: {
      bg: '#c2740a',
      // Dark text on amber, where positive and negative take white.
      //
      // Not an inconsistency: white on this fill is 3.6:1 and fails AA, and no
      // amber light enough to be read as amber will carry white text. Darkening
      // the fill until it does turns it brown, which stops reading as a warning
      // at a glance. Dark-on-amber is the standard resolution and measures
      // 4.6:1. The contrast test is what found this.
      fg: '#2b1a00',
      bgSubdued: '#fbeeda',
      fgSubdued: '#96590a',
      border: 'rgba(194, 116, 10, 0.28)',
    },
    negative: {
      bg: '#c4183c',
      bgSubdued: '#fbe2e7',
      fg: '#ffffff',
      fgSubdued: '#a81334',
      border: 'rgba(196, 24, 60, 0.28)',
    },
  },

  nav: {
    // A light sidebar, and now a green one. Still the biggest departure from
    // stock Backstage's near-black #171717 and still what most stops the portal
    // looking like a default install -- but a tint of the brand rather than
    // white, which distinguishes the sidebar by hue as well as by value. White
    // at 0.62 composited to #f9fafc, lighter than its own page.
    //
    // 0.92 rather than opaque: it keeps the frosted edge the drawer's blur is
    // there to produce, while being near enough to opaque that the gradient
    // behind it can no longer lighten the top of the column away from the
    // bottom.
    background: 'rgba(197, 219, 212, 0.92)',
    // Darkened from #556579, which is not a preference: on the green ground it
    // measures 4.17:1 and fails AA outright. This is 4.94:1. Green-cast to sit
    // in the sidebar's own family rather than reading as blue text on green.
    color: '#42574f',
    // Green-cast too, and this one is also the logo wordmark -- `LogoFull`
    // takes `selectedColor` rather than hardcoding a colour, which is what
    // lets the mark work on both sidebars. 10.8:1.
    selectedColor: '#0c2a20',
    indicator: BRAND,
    // Doubled. At 0.08 a brand-tinted hover was invisible against a ground
    // that is now itself brand-tinted -- the hover had nothing to be a tint of.
    hoverBackground: 'rgba(12, 107, 74, 0.16)',
    submenuBackground: 'rgba(252, 255, 253, 0.95)',
    // Deliberately several times stronger than `border.base`. This is the rule
    // between nav items, and at hairline weight the sidebar read as one
    // undivided column -- the stock `SidebarDivider` it replaces was a flat
    // #383838, i.e. genuinely dark, and that separation is the point. Green-cast
    // and slightly softer than the navy it replaces, because it now has a
    // mid-tone ground to carry against rather than a near-white one.
    border: 'rgba(10, 58, 43, 0.34)',
  },
};

export const darkTokens: PortalTokens = {
  mode: 'dark',

  bg: {
    // Near-black with a blue cast, rather than the mid-slate #333 Backstage
    // ships. Taken from the reference design, and the depth is what does the
    // work: at this value a lifted card reads as a surface on its own without
    // needing a border to prove it, which is what the previous #0e131c was too
    // close to its own cards to manage.
    app: '#090f0d',
    // **Lighter than the page here, where light mode's is darker, and that is
    // the convention rather than an inconsistency.** Dark mode raises an
    // elevated surface towards the light -- `surface[3]` and `fg.muted` below
    // are both written against that same fact. There is also nowhere else to
    // go: the sidebar takes the darkest ground and the page is already within a
    // few units of black, so a header darker still would be indistinguishable
    // from both. The sidebar stays the most separated element either way, which
    // is what the ladder is for.
    header: '#0d1714',
    gradient: [
      // The indigo bloom off the top-right corner is the single most
      // recognisable thing about the reference. Kept well under 20% alpha: it
      // has to survive behind a 96-row table without tinting the text.
      'radial-gradient(1200px 700px at 88% -12%, rgba(99, 102, 241, 0.16), transparent 60%)',
      'radial-gradient(900px 520px at 12% -8%, rgba(25, 185, 130, 0.08), transparent 58%)',
      'radial-gradient(1000px 700px at 50% 116%, rgba(56, 78, 120, 0.1), transparent 65%)',
    ].join(', '),
  },

  surface: {
    // Composites to about #111823 over the page -- the card value read off the
    // reference. The alphas are chosen for that result rather than picked
    // directly, because what the eye sees is the blend, not the token.
    1: 'rgba(20, 28, 40, 0.72)',
    2: 'rgba(4, 7, 12, 0.5)',
    3: 'rgba(28, 38, 53, 0.94)',
    4: 'rgba(4, 7, 12, 0.7)',
    solid: '#111823',
  },

  border: {
    soft: 'rgba(148, 178, 214, 0.08)',
    base: 'rgba(148, 178, 214, 0.14)',
    strong: 'rgba(148, 178, 214, 0.26)',
  },

  fg: {
    primary: '#e6edf5',
    secondary: '#9aa8ba',
    // Kept above the popover surface, which is the lightest ground in this mode
    // and therefore the one that binds -- dark mode raises elevated surfaces
    // towards the light, so the dimmest text has less room here than the page
    // background suggests. An earlier #8496ac measured 4.4:1 and failed.
    muted: '#8fa0b4',
  },

  shadow: {
    // Deeper than the light mode's, and tighter. Against a near-black ground a
    // wide soft shadow is a smudge rather than a lift, so the separation has to
    // come from the surface being lighter than the page instead.
    soft: '0 1px 2px rgba(0, 0, 0, 0.4)',
    card: '0 1px 3px rgba(0, 0, 0, 0.45), 0 8px 20px -14px rgba(0, 0, 0, 0.7)',
    raised:
      '0 4px 12px rgba(0, 0, 0, 0.55), 0 18px 36px -18px rgba(0, 0, 0, 0.75)',
  },

  radius: RADIUS,

  blur: 'blur(14px) saturate(1.3)',

  accent: {
    // Emerald, from the reference, replacing the lightened brand teal.
    //
    // It stays in the brand's hue family -- the logo tile's #12665E is a
    // green-teal and sits happily beside this -- while being the far stronger
    // signal at this background value, which is why the reference uses it for
    // the primary button, the active nav item and its indicator all at once.
    base: '#19b982',
    hover: '#2ed49a',
    subtle: 'rgba(25, 185, 130, 0.14)',
    // **Dark text on the fill, where the reference uses white.** White on this
    // green measures 2.5:1 and fails AA outright; no emerald light enough to
    // still read as emerald will carry white text. The contrast test caught it.
    on: '#04231a',
    ring: '#19b982',
    alt: '#8b8cf0',
    altOn: '#0d0f2b',
  },

  status: {
    positive: {
      // Pulled towards the accent's hue so a healthy score and the primary
      // action are recognisably the same green rather than two near-misses.
      bg: '#1a9e63',
      bgSubdued: '#0d2b1e',
      fg: '#04240f',
      fgSubdued: '#4fd18a',
      border: 'rgba(26, 158, 99, 0.34)',
    },
    warning: {
      bg: '#d98c14',
      bgSubdued: '#2e2109',
      fg: '#2a1a00',
      fgSubdued: '#f0b45a',
      border: 'rgba(217, 140, 20, 0.34)',
    },
    negative: {
      bg: '#e04561',
      bgSubdued: '#2f1219',
      fg: '#2c0410',
      fgSubdued: '#f5808f',
      border: 'rgba(224, 69, 97, 0.34)',
    },
  },

  nav: {
    // The darkest ground in the mode, and green-cast to match the light
    // theme's sidebar -- a green sidebar in one mode and a blue one in the
    // other would read as two products. Deeper than the page rather than
    // level with it: at 0.8 over the old page this composited to #0b1019,
    // within one unit of the page itself.
    background: 'rgba(5, 11, 9, 0.88)',
    color: '#93a8a0',
    selectedColor: '#e4efe9',
    indicator: '#19b982',
    hoverBackground: 'rgba(25, 185, 130, 0.14)',
    submenuBackground: 'rgba(13, 23, 20, 0.96)',
    // Lighter than the light theme's is dark, for the same reason: it has to
    // carry against a near-black sidebar rather than a near-white one.
    border: 'rgba(150, 205, 186, 0.3)',
  },
};

/** Both modes, keyed the way `createPortalThemes` and `globalCss` want them. */
export const portalTokens: Record<ThemeMode, PortalTokens> = {
  light: lightTokens,
  dark: darkTokens,
};
