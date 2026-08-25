import { makeStyles } from '@material-ui/core';

/**
 * The Demand AI mark alone, for the collapsed sidebar.
 *
 * The same glyph as {@link LogoFull} without the wordmark: at 28px the words
 * would be unreadable, and a squashed wordmark reads as a rendering fault
 * rather than as a logo.
 */
const useStyles = makeStyles(theme => ({
  svg: {
    width: 'auto',
    height: 28,
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
}));

export const LogoIcon = () => {
  const classes = useStyles();

  return (
    <svg
      className={classes.svg}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 80"
      role="img"
      aria-label="Demand AI"
    >
      <g className={classes.mark}>
        <path d="M40 14c-13 0-24 9-24 21 0 5 2 9 5 13-3 4-5 8-5 13 0 12 11 19 24 19" />
        <path d="M40 14c13 0 24 9 24 21 0 5-2 9-5 13 3 4 5 8 5 13 0 12-11 19-24 19" />
        <path d="M40 10v60" />
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
    </svg>
  );
};
