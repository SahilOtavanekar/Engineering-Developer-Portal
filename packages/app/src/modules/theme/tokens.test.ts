import {
  darkTokens,
  lightTokens,
  portalTokens,
  type PortalTokens,
} from './tokens';

/**
 * Contrast, computed rather than eyeballed.
 *
 * The reference design this theme follows uses very low-contrast grey text in
 * places. Copying that would be the easiest way to ship something that looks
 * right in a screenshot and is unreadable on a laptop in daylight, so the
 * ratios are asserted here instead of trusted.
 *
 * **Translucent surfaces have to be composited first.** Every card colour in
 * `tokens.ts` is an `rgba`, so the colour text actually sits on is the surface
 * blended over whatever is behind it -- and for a nested panel that is two
 * blends deep. Asserting against the raw token would measure a colour that is
 * never on screen.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parse(colour: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    // eslint-disable-next-line no-bitwise
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgba =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
      colour.trim(),
    );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  throw new Error(`Not a colour this test can read: ${colour}`);
}

/** `parse`, as a predicate, so a failure can be reported as a list. */
function tryParse(colour: string): boolean {
  try {
    parse(colour);
    return true;
  } catch {
    return false;
  }
}

/** Source-over compositing: what the eye sees when `top` sits on `bottom`. */
function over(top: string, bottom: Rgba): Rgba {
  const t = parse(top);
  return {
    r: t.r * t.a + bottom.r * (1 - t.a),
    g: t.g * t.a + bottom.g * (1 - t.a),
    b: t.b * t.a + bottom.b * (1 - t.a),
    a: 1,
  };
}

/** Relative luminance, WCAG 2.1 definition. */
function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: Rgba): number {
  const a = luminance(over(foreground, background));
  const b = luminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for body text. Every pair below carries text at some size. */
const AA = 4.5;

/**
 * Every text-on-background pair the portal actually renders, per mode.
 *
 * Surfaces are stacked the way the DOM stacks them, so `surface 2` is measured
 * as a recessed panel inside a card on the page -- which is where it is used
 * (the expanded productivity row, the metric bar track, the problems callout).
 */
function pairs(tokens: PortalTokens) {
  const app = parse(tokens.bg.app);
  const surface1 = over(tokens.surface[1], app);
  const surface2 = over(tokens.surface[2], surface1);
  const surface3 = over(tokens.surface[3], app);
  const solid = parse(tokens.surface.solid);
  const nav = over(tokens.nav.background, app);

  const grounds: Array<[string, Rgba]> = [
    ['page', app],
    // The page title bar. Its own ground since it stopped sharing the
    // sidebar's, and opaque -- the blur behind it changes what is seen through
    // it, not the alpha it is composited at.
    ['page header', parse(tokens.bg.header)],
    ['card', surface1],
    ['recessed panel in a card', surface2],
    ['popover', surface3],
    ['solid table surface', solid],
  ];

  const cases: Array<[string, string, Rgba]> = [];

  for (const [where, ground] of grounds) {
    cases.push([`primary text on ${where}`, tokens.fg.primary, ground]);
    cases.push([`secondary text on ${where}`, tokens.fg.secondary, ground]);
    cases.push([`muted text on ${where}`, tokens.fg.muted, ground]);
    cases.push([`accent link on ${where}`, tokens.accent.base, ground]);

    for (const intent of ['positive', 'warning', 'negative'] as const) {
      cases.push([
        `${intent} subdued text on ${where}`,
        tokens.status[intent].fgSubdued,
        ground,
      ]);
    }
  }

  // Text on a saturated fill: the band pills and the accent button.
  cases.push([
    'text on the accent fill',
    tokens.accent.on,
    parse(tokens.accent.base),
  ]);
  // The relations graph's focused node: a filled pill with a label on it.
  cases.push([
    'text on the alt fill',
    tokens.accent.altOn,
    parse(tokens.accent.alt),
  ]);
  for (const intent of ['positive', 'warning', 'negative'] as const) {
    cases.push([
      `text on the ${intent} fill`,
      tokens.status[intent].fg,
      parse(tokens.status[intent].bg),
    ]);
    // The quiet fill: the band bar and the status pill both use the subdued
    // background with subdued text on it, which is a different pair from
    // either of the two above and so needs its own case.
    cases.push([
      `subdued text on the ${intent} subdued fill`,
      tokens.status[intent].fgSubdued,
      parse(tokens.status[intent].bgSubdued),
    ]);
  }

  // The header renders exactly two of the foregrounds above -- the title in
  // `fg.primary`, the page icon and the inactive tabs in `fg.secondary`. It is
  // in `grounds` rather than given bespoke cases so that it is also checked
  // against the ones it does not use yet: the next thing put in a title bar
  // should not be the thing that discovers the ground is too dark for it.
  //
  // `fg.muted` on the light header is the tightest pair in the set at 4.76:1,
  // and it is what caps how dark that ground may go. An earlier #dae3de
  // measured 4.28 and failed here.

  // The sidebar, which is a translucent surface over the page like any other.
  cases.push(['inactive nav label', tokens.nav.color, nav]);
  cases.push([
    'selected nav label and the logo wordmark',
    tokens.nav.selectedColor,
    nav,
  ]);

  return cases;
}

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
])('%s tokens', (_mode, tokens) => {
  it.each(pairs(tokens))('%s clears WCAG AA', (_label, foreground, ground) => {
    expect(contrast(foreground, ground)).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * Shape and structure, which must not vary between modes.
 *
 * The parity check is the one that earns its keep over time: adding a token to
 * one mode and forgetting the other produces `undefined` in a CSS custom
 * property, which does not throw -- it silently falls back to whatever
 * Backstage UI shipped, in one mode only, and is then found by a person rather
 * than by a test.
 */
describe('token structure', () => {
  function shape(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return typeof value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, inner]) => [key, shape(inner)])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  }

  it('declares exactly the same tokens in both modes', () => {
    const { mode: _light, ...light } = lightTokens;
    const { mode: _dark, ...dark } = darkTokens;

    expect(shape(dark)).toEqual(shape(light));
  });

  it('shares one radius scale, so shape does not change with the theme', () => {
    expect(darkTokens.radius).toEqual(lightTokens.radius);
  });

  it('is keyed by the mode each set declares', () => {
    expect(portalTokens.light.mode).toBe('light');
    expect(portalTokens.dark.mode).toBe('dark');
  });

  it('leaves no colour un-parseable, so globalCss cannot emit nonsense', () => {
    // Collected first and asserted once, rather than asserting inside the
    // walk: a conditional `expect` passes vacuously if the traversal ever
    // stops finding anything, so a broken walker would look like a clean run.
    const colours: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        // Gradients, shadows and blurs are compound values, not colours.
        if (/^(#|rgba?\()/.test(value.trim())) colours.push(value);
        return;
      }
      if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };

    walk(lightTokens);
    walk(darkTokens);

    expect(colours.length).toBeGreaterThan(30);
    expect(colours.filter(c => !tryParse(c))).toEqual([]);
  });
});
