import { makeStyles } from '@material-ui/core';
import demandAiLogo from '../../assets/demand-ai-logo.png';

/**
 * The Demand AI mark alone, for the collapsed sidebar.
 *
 * The same artwork as {@link LogoFull} without the wordmark: the collapsed
 * drawer is 72px wide, and a wordmark squeezed into that reads as a rendering
 * fault rather than as a logo.
 *
 * See {@link LogoFull} for why the asset is imported rather than referenced by
 * URL, and why the aspect ratio is pinned twice.
 */
const useStyles = makeStyles({
  tile: {
    height: 32,
    width: 'auto',
    flexShrink: 0,
    objectFit: 'contain',
    borderRadius: 6,
    display: 'block',
  },
});

export const LogoIcon = () => {
  const classes = useStyles();

  return <img className={classes.tile} src={demandAiLogo} alt="Demand AI" />;
};
