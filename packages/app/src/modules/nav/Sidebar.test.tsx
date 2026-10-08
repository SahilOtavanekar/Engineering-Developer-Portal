import { render } from '@testing-library/react';
import { MENU_ORDER, takeMenuItems } from './Sidebar';

/**
 * A stand-in for the nav collection with the same take/rest semantics: `take`
 * removes and returns an item, or returns nothing for an id it does not hold.
 */
function fakeNav(ids: string[]) {
  const remaining = [...ids];
  return {
    take(id: string) {
      const index = remaining.indexOf(id);
      if (index < 0) return undefined;
      remaining.splice(index, 1);
      return <span data-testid="item">{id}</span>;
    },
    rest: () => [...remaining],
  };
}

const rendered = (nav: ReturnType<typeof fakeNav>) =>
  Array.from(
    render(<>{takeMenuItems(nav)}</>).container.querySelectorAll(
      '[data-testid="item"]',
    ),
  ).map(node => node.textContent);

describe('takeMenuItems', () => {
  it('puts the Health Dashboard first, then the catalog, then Productivity', () => {
    expect(MENU_ORDER).toEqual([
      'page:fleet',
      'page:catalog',
      'page:fleet/productivity',
    ]);
  });

  it('orders the menu explicitly, not alphabetically', () => {
    // Discovered in alphabetical order by title, as `nav.rest` would give
    // them: Catalog, Health Dashboard, Productivity.
    const nav = fakeNav([
      'page:catalog',
      'page:fleet',
      'page:fleet/productivity',
    ]);
    expect(rendered(nav)).toEqual([
      'page:fleet',
      'page:catalog',
      'page:fleet/productivity',
    ]);
  });

  it('leaves every other page for the rest of the menu', () => {
    const nav = fakeNav(['page:catalog', 'page:fleet', 'page:other']);
    rendered(nav);
    expect(nav.rest()).toEqual(['page:other']);
  });

  it('skips a page that is not installed rather than failing', () => {
    const nav = fakeNav(['page:catalog']);
    expect(rendered(nav)).toEqual(['page:catalog']);
  });
});
