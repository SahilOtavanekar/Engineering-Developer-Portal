import { makeStyles } from '@material-ui/core';
import demandAiLogo from '../../assets/demand-ai-logo.png';

/**
 * The Demand AI logo for the expanded sidebar: the brand tile plus the
 * wordmark.
 *
 * The official artwork (`src/assets/demand-ai-logo.png`, 137x124) is the mark
 * only -- it carries no wordmark -- so the name is set as text beside it. That
 * is also what keeps it legible: text renders at the device's pixel density and
 * follows the theme, where a raster wordmark would neither.
 *
 * **The asset is imported, not referenced by URL.** `index.html` templates its
 * asset paths through `<%= publicPath %>`, so a hardcoded `/demand-ai-logo.png`
 * would break the moment the portal is served from anywhere but the domain
 * root. Importing hands the path to the bundler, which also fingerprints it for
 * cache-busting. To replace the artwork, overwrite that file -- not anything in
 * `public/`.
 *
 * **Aspect ratio is pinned two ways.** `height` with `width: auto` on an `img`
 * preserves the intrinsic ratio, and `objectFit: 'contain'` means that even if
 * an ancestor forces a width on it the image letterboxes instead of stretching.
 * The previous hand-drawn SVG had neither guard and was squashed by the 72px
 * container it sat in.
 *
 * **Theme handling.** The tile is a fully opaque `#12665E` rectangle, so it is
 * readable against any backdrop and needs no theme treatment. The wordmark does
 * not, so it takes `palette.navigation.selectedColor` rather than a hardcoded
 * white -- correct on the light theme's `#171717` sidebar and the dark theme's
 * `#424242`, and still correct if either is ever restyled.
 */
const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    flexFlow: 'row nowrap',
    alignItems: 'center',
    gap: 10,
  },
  tile: {
    height: 32,
    width: 'auto',
    // Never let a parent's width squeeze or stretch the artwork.
    flexShrink: 0,
    objectFit: 'contain',
    borderRadius: 6,
    display: 'block',
  },
  word: {
    color: theme.palette.navigation.selectedColor,
    fontFamily: theme.typography.fontFamily,
    fontSize: 19,
    fontWeight: 700,
    letterSpacing: 0.4,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
}));

export const LogoFull = () => {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <img className={classes.tile} src={demandAiLogo} alt="" aria-hidden />
      <span className={classes.word}>Demand AI</span>
    </div>
  );
};
