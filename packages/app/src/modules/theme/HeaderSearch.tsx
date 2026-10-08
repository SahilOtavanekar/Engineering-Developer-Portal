import { useEffect } from 'react';
import { makeStyles } from '@material-ui/core/styles';
import SearchIcon from '@material-ui/icons/Search';
import { SearchModal, useSearchModal } from '@backstage/plugin-search';

/**
 * True when a key press belongs to whatever the person is typing in, so the
 * `/` shortcut must leave it alone: a field, a text area, a select, or any
 * contenteditable region.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}

const useStyles = makeStyles(
  theme => ({
    /**
     * A button dressed as a search field. It opens the search window rather
     * than accepting text itself, because the window is where results,
     * filters and "view full results" already live -- a second, inline search
     * would be a second search experience to keep in step with the first.
     */
    box: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      width: 'clamp(12rem, 26vw, 22rem)',
      padding: theme.spacing(0.75, 1.25),
      font: 'inherit',
      fontSize: '0.875rem',
      color: theme.palette.text.secondary,
      background: 'var(--bui-bg-neutral-2)',
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 'var(--portal-radius-sm)',
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'border-color 140ms ease, color 140ms ease',
      '&:hover': {
        color: theme.palette.text.primary,
        borderColor: theme.palette.text.secondary,
      },
      '& svg': { fontSize: 18, flexShrink: 0 },
      // On a phone the title needs the room: the box becomes its icon.
      [theme.breakpoints.down('xs')]: {
        width: 'auto',
        padding: theme.spacing(0.75),
        '& $label, & $key': { display: 'none' },
      },
    },
    label: {
      flexGrow: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    key: {
      fontFamily: 'inherit',
      fontSize: '0.75rem',
      lineHeight: 1,
      padding: theme.spacing(0.25, 0.75),
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 'var(--portal-radius-sm)',
    },
  }),
  { name: 'PortalHeaderSearch' },
);

/**
 * The portal's search, in the page title bar.
 *
 * Moved here from the sidebar on 2026-10-08 at the product owner's direction.
 * It is the same search window the sidebar used to open (`SearchModal`), so
 * results, filters and the full search page at /search are unchanged.
 * Pressing `/` anywhere outside a text field opens it too.
 */
export function HeaderSearch() {
  const classes = useStyles();
  const { state, toggleModal, setOpen } = useSearchModal();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  return (
    <>
      <button
        type="button"
        className={classes.box}
        onClick={toggleModal}
        aria-label="Search the portal"
        aria-haspopup="dialog"
      >
        <SearchIcon aria-hidden />
        <span className={classes.label}>Search the portal</span>
        <kbd className={classes.key} aria-hidden>
          /
        </kbd>
      </button>
      <SearchModal {...state} toggleModal={toggleModal} />
    </>
  );
}
