import type { PageLayoutProps } from '@backstage/frontend-plugin-api';
import { makeStyles } from '@material-ui/core/styles';
import { Link } from '@backstage/core-components';

/**
 * The shell every routed page is rendered inside: its title bar, tab row and
 * content area.
 *
 * **This exists because the default implementation cannot be themed at all.**
 * `PageBlueprint` wraps every page in `PageLayout`, whose stock version sets
 * `backgroundColor: '#fff'`, `borderBottom: '1px solid #ddd'` and a tab colour
 * of `#333` as **inline styles**. Inline styles are not reachable by a Material
 * UI theme, by the Backstage UI token layer, or by ordinary CSS -- only by
 * `!important`, one property at a time. So on the dark theme the portal had a
 * white bar across the top of every page and no way to remove it.
 *
 * `PageLayout` is built with `createSwappableComponent`, so replacing it is a
 * first-class operation rather than a workaround: `SwappableComponentBlueprint`
 * takes the component's own `ref` and a loader, and the app renders this
 * instead. Nothing about routing, titles, tabs or plugin header actions
 * changes -- this reimplements the same contract, which is why every prop below
 * is handled rather than only the ones we happen to use today.
 *
 * The one deliberate behavioural difference is `titleLink`: the stock layout
 * accepts it and never renders it, so a page title is dead text even when the
 * plugin has told the layout where it points. Here it becomes a link.
 */
const useStyles = makeStyles(
  theme => ({
    root: {
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      minHeight: 0,
    },

    /**
     * The title bar.
     *
     * Sticky rather than scrolling away: on the fleet and catalog pages the
     * content below it is a long table, and the page title is the only thing
     * saying which of them you are looking at.
     *
     * Translucent with a blur, which is the one place in the portal where a
     * frosted surface is doing real work rather than decoration -- content
     * passes underneath it continuously.
     */
    header: {
      position: 'sticky',
      top: 0,
      zIndex: 2,
      flexShrink: 0,
      // NOT `palette.navigation.background`, which is what this was: the title
      // bar and the sidebar were the same token, so no amount of colouring
      // either could make them contrast. `--portal-header-bg` is its own
      // ground. A custom property rather than a palette key because
      // `palette.navigation` is contractually the keys `core-components`'
      // sidebar reads, and this is not one of them.
      backgroundColor: 'var(--portal-header-bg)',
      borderBottom: `1px solid ${theme.palette.divider}`,
      backdropFilter: 'blur(14px) saturate(1.4)',
      WebkitBackdropFilter: 'blur(14px) saturate(1.4)',
    },
    titleRow: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: theme.spacing(2, 3, 1.75),
      // The gutters halve on a phone, matching `BackstageContent`. 24px each
      // side costs a seventh of a narrow viewport before any content appears.
      [theme.breakpoints.down('xs')]: {
        padding: theme.spacing(1.5, 1.5, 1.25),
        gap: theme.spacing(1),
      },
    },
    icon: {
      display: 'flex',
      alignItems: 'center',
      color: theme.palette.text.secondary,
      // Icons arrive from a dozen plugins at whatever size they were authored;
      // pinning it here is what stops the header jumping between pages.
      '& > *': { fontSize: 20 },
    },
    title: {
      ...theme.typography.h4,
      margin: 0,
      color: theme.palette.text.primary,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    titleLink: {
      color: 'inherit',
      minWidth: 0,
      '&:hover': { textDecoration: 'none' },
    },
    actions: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      // Never let a long title squeeze the actions to nothing.
      flexShrink: 0,
    },

    tabs: {
      display: 'flex',
      gap: theme.spacing(0.5),
      padding: theme.spacing(0, 3),
      // Entity pages carry more tabs than fit a laptop; scroll the row rather
      // than wrapping it into a second line that shifts the content down.
      overflowX: 'auto',
      scrollbarWidth: 'none',
      '&::-webkit-scrollbar': { display: 'none' },
      [theme.breakpoints.down('xs')]: { padding: theme.spacing(0, 1.5) },
    },
    tab: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(0.75),
      padding: theme.spacing(1, 1.5),
      whiteSpace: 'nowrap',
      fontSize: '0.875rem',
      fontWeight: 500,
      color: theme.palette.text.secondary,
      borderBottom: '2px solid transparent',
      transition: 'color 140ms ease, border-color 140ms ease',
      '&:hover': {
        color: theme.palette.text.primary,
        textDecoration: 'none',
        borderBottomColor: theme.palette.divider,
      },
      '& svg': { fontSize: 18 },
    },

    content: {
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      minHeight: 0,
      padding: theme.spacing(3),
      [theme.breakpoints.down('xs')]: { padding: theme.spacing(1.5) },
    },
  }),
  { name: 'PortalPageLayout' },
);

export function PortalPageLayout(props: PageLayoutProps) {
  const { title, icon, noHeader, titleLink, headerActions, tabs, children } =
    props;
  const classes = useStyles();

  const hasTabs = Boolean(tabs && tabs.length > 0);
  const showHeader = !noHeader && Boolean(title || hasTabs);

  return (
    <div data-component="page-layout" className={classes.root}>
      {showHeader && (
        <header className={classes.header}>
          {title && (
            <div className={classes.titleRow}>
              {icon && <span className={classes.icon}>{icon}</span>}
              {titleLink ? (
                <Link
                  to={titleLink}
                  className={classes.titleLink}
                  underline="none"
                >
                  <h1 className={classes.title}>{title}</h1>
                </Link>
              ) : (
                <h1 className={classes.title}>{title}</h1>
              )}
              {headerActions && headerActions.length > 0 && (
                <div className={classes.actions}>{headerActions}</div>
              )}
            </div>
          )}

          {hasTabs && (
            <nav className={classes.tabs}>
              {tabs!.map(tab => (
                <Link
                  key={tab.id}
                  to={tab.href}
                  className={classes.tab}
                  underline="none"
                >
                  {tab.icon}
                  {tab.label}
                </Link>
              ))}
            </nav>
          )}
        </header>
      )}

      <div className={classes.content}>{children}</div>
    </div>
  );
}
