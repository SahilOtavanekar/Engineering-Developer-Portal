import {
  createFrontendModule,
  PageLayout,
} from '@backstage/frontend-plugin-api';
import {
  SwappableComponentBlueprint,
  ThemeBlueprint,
} from '@backstage/plugin-app-react';
import { UnifiedThemeProvider } from '@backstage/theme';
import LightIcon from '@material-ui/icons/WbSunny';
import DarkIcon from '@material-ui/icons/Brightness2';
import { createPortalThemes, globalCss } from './portalTheme';
import { PortalPageLayout } from './PortalPageLayout';

const themes = createPortalThemes();

/**
 * Replaces the stock themes rather than adding a third.
 *
 * The ids are `light` and `dark`, matching the built-in ones, so these take
 * their place instead of appearing beside them in Settings — a portal with
 * four themes to choose from is worse than one with two.
 */
const lightTheme = ThemeBlueprint.make({
  name: 'light',
  params: {
    theme: {
      id: 'light',
      title: 'Light',
      variant: 'light',
      icon: <LightIcon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={themes.light}>
          {/* The only global-CSS seam available: `UnifiedThemeProvider` mounts
              no `CssBaseline`, so `MuiCssBaseline` overrides never apply. */}
          <style>{globalCss('light')}</style>
          {children}
        </UnifiedThemeProvider>
      ),
    },
  },
});

const darkTheme = ThemeBlueprint.make({
  name: 'dark',
  params: {
    theme: {
      id: 'dark',
      title: 'Dark',
      variant: 'dark',
      icon: <DarkIcon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={themes.dark}>
          <style>{globalCss('dark')}</style>
          {children}
        </UnifiedThemeProvider>
      ),
    },
  },
});

/**
 * Replaces the page shell every routed page is rendered inside.
 *
 * Not a nicety: the stock `PageLayout` paints its title bar `#fff` with a
 * `#ddd` rule **inline**, which no theme and no stylesheet can reach, so the
 * dark theme carried a white bar across the top of every page. See
 * `PortalPageLayout` for the full account.
 *
 * `SwappableComponentBlueprint` is documented as limited to the app plugin,
 * which is where this module already registers.
 */
const pageLayout = SwappableComponentBlueprint.make({
  name: 'page-layout',
  // The callback form is required, not stylistic: this blueprint infers the
  // component's prop types from the ref it is given, and a plain object
  // literal has nothing to infer from. The compiler says so in as many words.
  params: defineParams =>
    defineParams({
      component: PageLayout,
      loader: () => PortalPageLayout,
    }),
});

/**
 * Portal-wide visual conventions.
 *
 * `ThemeBlueprint` is documented as limited to the app plugin, so this module
 * registers under `app` -- the same pluginId the nav, auth and i18n modules
 * use, and for the same reason.
 *
 * A theme is the only lever that reaches inside Backstage's own pages. The
 * catalog page and the entity pages are third-party components whose markup we
 * do not own; their MUI class keys are what we can reach, and reaching them
 * from one place is also what keeps our own pages consistent with them.
 */
export const themeModule = createFrontendModule({
  pluginId: 'app',
  extensions: [lightTheme, darkTheme, pageLayout],
});
