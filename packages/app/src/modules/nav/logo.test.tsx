import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@material-ui/core';
import { createTheme } from '@material-ui/core/styles';
import type { Theme } from '@material-ui/core';
import { LogoFull } from './LogoFull';
import { LogoIcon } from './LogoIcon';

/**
 * Builds a theme carrying only what the logo actually reads.
 *
 * Deliberately not one of the real Backstage themes: what is worth pinning is
 * that the wordmark takes its colour from `palette.navigation.selectedColor`
 * rather than a hardcoded white. A sentinel proves that; asserting `#FFF` would
 * only re-test Backstage's own palette, and would still pass if the component
 * ignored the theme entirely.
 */
const themeWithNavColor = (selectedColor: string): Theme =>
  createTheme({
    palette: {
      navigation: {
        background: '#171717',
        indicator: '#9BF0E1',
        color: '#b5b5b5',
        selectedColor,
      },
    },
  } as any);

const renderWithTheme = (node: React.ReactNode, selectedColor: string) =>
  render(
    <ThemeProvider theme={themeWithNavColor(selectedColor)}>
      {node}
    </ThemeProvider>,
  );

describe('LogoFull', () => {
  it('renders the wordmark, so the brand name is present when expanded', () => {
    renderWithTheme(<LogoFull />, '#FFFFFF');

    expect(screen.getByText('Demand AI')).toBeInTheDocument();
  });

  it('renders the official artwork rather than a drawn approximation', () => {
    renderWithTheme(<LogoFull />, '#FFFFFF');

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toMatch(/demand-ai-logo/);
  });

  it('sets no width on the artwork, so its aspect ratio cannot be squashed', () => {
    // The regression this exists for: the previous logo was laid out inside a
    // 72px container and came out distorted.
    renderWithTheme(<LogoFull />, '#FFFFFF');

    const img = document.querySelector('img')!;
    expect(img.getAttribute('width')).toBeNull();
    expect(img.style.width).toBe('');
  });

  it('takes the wordmark colour from the theme, not a hardcoded white', () => {
    // Proves the logo is correct on both themes: the light theme's sidebar is
    // #171717 and the dark theme's is #424242, and both supply their own
    // selectedColor for text on it.
    const { unmount } = renderWithTheme(<LogoFull />, 'rgb(1, 2, 3)');
    expect(getComputedStyle(screen.getByText('Demand AI')).color).toBe(
      'rgb(1, 2, 3)',
    );
    unmount();

    renderWithTheme(<LogoFull />, 'rgb(4, 5, 6)');
    expect(getComputedStyle(screen.getByText('Demand AI')).color).toBe(
      'rgb(4, 5, 6)',
    );
  });
});

describe('LogoIcon', () => {
  it('renders the artwork with an accessible name', () => {
    renderWithTheme(<LogoIcon />, '#FFFFFF');

    expect(screen.getByAltText('Demand AI')).toBeInTheDocument();
  });

  it('omits the wordmark, which is the reason it exists', () => {
    // The collapsed drawer is 72px wide; a wordmark squeezed into that reads as
    // a rendering fault.
    renderWithTheme(<LogoIcon />, '#FFFFFF');

    expect(screen.queryByText('Demand AI')).not.toBeInTheDocument();
  });
});
