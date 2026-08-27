import {
  Link,
  sidebarConfig,
  useSidebarOpenState,
} from '@backstage/core-components';
import { makeStyles } from '@material-ui/core';
import { LogoFull } from './LogoFull';
import { LogoIcon } from './LogoIcon';

/**
 * The sidebar header: the full logo when the drawer is open, the mark alone when
 * it is collapsed.
 *
 * **Widths follow the drawer rather than being pinned to its closed size.** The
 * scaffolded version set both the row and the link to `drawerWidthClosed`
 * (72px) whatever the drawer was actually doing, so the expanded logo was laid
 * out inside a 72px box and relied on overflowing it to be seen -- which is
 * what squashed the wordmark. `width: '100%'` tracks the drawer through its open
 * and closed states (72px to 224px), so the logo is never wider than the space
 * it has and nothing has to overflow.
 *
 * `marginLeft` matches `sidebarConfig.iconPadding`, so the logo's left edge
 * lines up with the nav icons below it.
 */
const useSidebarLogoStyles = makeStyles({
  root: {
    width: '100%',
    height: 3 * sidebarConfig.logoHeight,
    display: 'flex',
    flexFlow: 'row nowrap',
    alignItems: 'center',
    marginBottom: -14,
  },
  link: {
    marginLeft: sidebarConfig.iconPadding,
    display: 'flex',
    alignItems: 'center',
    // The drawer animates its width; never let the logo drive a scrollbar
    // while it is mid-transition.
    minWidth: 0,
  },
});

export const SidebarLogo = () => {
  const classes = useSidebarLogoStyles();
  const { isOpen } = useSidebarOpenState();

  return (
    <div className={classes.root}>
      <Link to="/" underline="none" className={classes.link} aria-label="Home">
        {isOpen ? <LogoFull /> : <LogoIcon />}
      </Link>
    </div>
  );
};
