import { makeStyles } from '@material-ui/core';

/**
 * The Demand AI wordmark, for the expanded sidebar.
 *
 * Drawn as SVG rather than referencing a raster file so it stays sharp at any
 * sidebar width and inherits the theme's foreground colour instead of carrying
 * a baked-in background. The official artwork sits on a teal block; a block
 * would read as a patch stuck onto the sidebar, so the mark is drawn on
 * transparent and the teal is kept as the accent on the circuit traces.
 *
 * To use the official asset instead: drop it at
 * `packages/app/public/demand-ai-logo.svg` and replace this component's body
 * with `<img src="/demand-ai-logo.svg" className={classes.svg} alt="Demand AI" />`.
 */
const useStyles = makeStyles(theme => ({
  svg: {
    width: 'auto',
    height: 30,
  },
  mark: {
    fill: 'none',
    stroke: theme.palette.type === 'dark' ? '#ffffff' : '#14615C',
    strokeWidth: 5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  },
  node: {
    fill: '#2FBFAE',
  },
  word: {
    fill: theme.palette.type === 'dark' ? '#ffffff' : '#14615C',
  },
}));

export const LogoFull = () => {
  const classes = useStyles();

  return (
    <svg
      className={classes.svg}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 300 80"
      role="img"
      aria-label="Demand AI"
    >
      {/* Brain outline, split by a vertical spine as in the original mark. */}
      <g className={classes.mark}>
        <path d="M40 14c-13 0-24 9-24 21 0 5 2 9 5 13-3 4-5 8-5 13 0 12 11 19 24 19" />
        <path d="M40 14c13 0 24 9 24 21 0 5-2 9-5 13 3 4 5 8 5 13 0 12-11 19-24 19" />
        <path d="M40 10v60" />
        {/* Circuit traces branching off the spine. */}
        <path d="M40 26h-11v-8" />
        <path d="M40 40h-14v10" />
        <path d="M40 56h-10v6" />
        <path d="M40 32h12v-9" />
        <path d="M40 48h13v9" />
      </g>
      <g className={classes.node}>
        <circle cx="29" cy="16" r="3.5" />
        <circle cx="26" cy="52" r="3.5" />
        <circle cx="30" cy="64" r="3.5" />
        <circle cx="52" cy="21" r="3.5" />
        <circle cx="53" cy="59" r="3.5" />
        <circle cx="40" cy="72" r="3.5" />
      </g>
      <text
        className={classes.word}
        x="84"
        y="53"
        fontFamily="Archivo, Helvetica Neue, Arial, sans-serif"
        fontSize="34"
        fontWeight="700"
        letterSpacing="1.5"
      >
        DEMAND AI
      </text>
    </svg>
  );
};
