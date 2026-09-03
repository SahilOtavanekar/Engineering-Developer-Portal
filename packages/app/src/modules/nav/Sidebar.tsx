import {
  Sidebar,
  SidebarDivider,
  SidebarGroup,
  SidebarItem,
  SidebarScrollWrapper,
  SidebarSpace,
} from '@backstage/core-components';
import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { SidebarLogo } from './SidebarLogo';
import MenuIcon from '@material-ui/icons/Menu';
import SearchIcon from '@material-ui/icons/Search';
import { SidebarSearchModal } from '@backstage/plugin-search';
import { UserSettingsSignInAvatar } from '@backstage/plugin-user-settings';

export const SidebarContent = NavContentBlueprint.make({
  params: {
    component: ({ navItems }) => {
      const nav = navItems.withComponent(item => (
        <SidebarItem icon={() => item.icon} to={item.href} text={item.title} />
      ));

      // Skipped items
      nav.take('page:search'); // Using search modal instead
      // The relations graph is wanted on entity pages, but the standalone
      // graph browser is not. Taken and discarded rather than disabled in
      // config: `entity-card:catalog-graph/relations` resolves this page's
      // route ref, and `useRouteRef` throws outright when the route is gone.
      nav.take('page:catalog-graph');

      return (
        // The drawer width is deliberately left at its default 224px.
        //
        // `Sidebar` accepts `sidebarOptions={{ drawerWidthOpen }}`, and it does
        // widen the drawer -- but it provides `SidebarConfigContext` *inside
        // itself*, while `SidebarPage` sits above it and reads the same context
        // to set the content's `padding-left`. `SidebarPage` therefore keeps
        // padding for the default width, and a widened drawer overlaps the page
        // by the difference whenever the sidebar is pinned. The context is not
        // exported, so the padding cannot be made to follow.
        //
        // Widening needs a theme override on `BackstageSidebarPage` to match,
        // which means owning a custom theme. Until then, an item whose title
        // does not fit is truncated rather than overlapping the page.
        <Sidebar>
          <SidebarLogo />
          <SidebarGroup label="Search" icon={<SearchIcon />} to="/search">
            <SidebarSearchModal />
          </SidebarGroup>
          {/* Nor here -- the Search row carries its own rule too, and the
              divider only sat 10px under it as a second line. The one before
              Settings is kept: it follows `SidebarSpace`, so it marks off the
              pinned bottom group across a gap rather than doubling anything. */}
          <SidebarGroup label="Menu" icon={<MenuIcon />}>
            {nav.take('page:catalog')}
            {/* No divider here any more.
                Every nav item carries its own bottom rule from the theme's
                `BackstageSidebarItem` override, so this one only doubled the
                line under Catalog -- which is what made Catalog look boxed
                while Health Dashboard and Productivity ran together. */}
            <SidebarScrollWrapper>
              {nav.rest({ sortBy: 'title' })}
            </SidebarScrollWrapper>
          </SidebarGroup>
          <SidebarSpace />
          <SidebarDivider />
          <SidebarGroup
            label="Settings"
            icon={<UserSettingsSignInAvatar />}
            to="/settings"
          >
            {nav.take('page:user-settings')}
          </SidebarGroup>
        </Sidebar>
      );
    },
  },
});
