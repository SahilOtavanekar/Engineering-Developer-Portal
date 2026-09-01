import { test, expect, type Page } from '@playwright/test';

/**
 * The document's non-functional requirement: page load under 2 seconds.
 *
 * "Loaded" here means the page's own content is on screen -- the repository
 * rows, the facts card -- not that the HTML arrived. A shell with spinners in
 * it is not a loaded page to the person waiting for it.
 *
 * **What is asserted, and what is only reported.**
 *
 * Wall-clock timings are *reported, not asserted*. Measured repeatedly on one
 * developer machine, the same build and the same page produced warm medians
 * ranging from 0.9s to 2.8s depending on nothing but what else the machine was
 * doing. A budget assertion on that number would fail on CPU contention rather
 * than on a regression, and a test that fails half the time teaches people to
 * ignore it. The numbers are printed on every run, with the budget alongside,
 * so a human reading the output can see where the page sits.
 *
 * **The requirement therefore cannot be signed off from a developer machine.**
 * It needs one run against a deployed instance. This spec is the instrument
 * for that; the run is still owed.
 *
 * What *is* asserted is request count, which does not move with machine load
 * and is what actually degrades as the estate grows: an N+1 that appears when
 * a page starts issuing one request per repository would be invisible in a
 * timing on 95 repositories and fatal on 10,000.
 *
 * Two timings are reported per page:
 *
 * - **warm**: the browser already holds the JavaScript bundles. Every visit
 *   after the first.
 * - **cold**: the resource cache is emptied first. A first-ever visit, or the
 *   first visit after a deploy, dominated by one-time bundle download.
 *
 * Run against a **production build**, which the backend serves once
 * `packages/app/dist` exists. Against the dev server the same pages are
 * roughly a second slower because it transpiles on demand and ships
 * unminified bundles with source maps:
 *
 *   yarn build:all
 *   yarn workspace backend start
 *   PLAYWRIGHT_URL=http://localhost:7007 yarn test:e2e performance
 */

/** The requirement, as written in the document. Printed, not asserted. */
const BUDGET_MS = 2_000;

/**
 * Repeats past the first load. A single sample is one point on a distribution
 * whose tail is the part users complain about.
 */
const SAMPLES = 5;

async function signIn(page: Page) {
  await page.goto('/');
  const enter = page.getByRole('button', { name: 'Enter' });
  // The sign-in page renders asynchronously; checking visibility without
  // waiting first races it and silently skips the click.
  await expect(enter).toBeVisible();
  await enter.click();
  // A link inside the sidebar, not the sidebar itself: the <nav> reports
  // hidden while collapsed even though its contents are on screen.
  await expect(
    page
      .getByRole('navigation', { name: 'sidebar nav' })
      .getByRole('link', { name: 'Health Dashboard', exact: true }),
  ).toBeVisible();
}

/**
 * Empties the resource cache without touching the session.
 *
 * A fresh browser context would also empty the cache, but it would drop the
 * guest session with it and the measurement would then include signing in.
 */
async function clearResourceCache(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
}

/**
 * Navigates and waits for the given content, returning how long that took and
 * every API path requested along the way.
 *
 * Timed around `goto` plus the content assertion rather than around `goto`
 * alone: `goto` resolves when the document loads, which for a single-page app
 * is before any of the data has arrived.
 */
async function loadPage(
  page: Page,
  path: string,
  ready: () => Promise<unknown>,
): Promise<{ ms: number; apiCalls: string[] }> {
  const apiCalls: string[] = [];
  const record = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
  };

  page.on('request', record);
  const started = Date.now();
  try {
    await page.goto(path);
    await ready();
  } finally {
    page.off('request', record);
  }
  return { ms: Date.now() - started, apiCalls };
}

function summarise(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[sorted.length - 1];
  const verdict = median < BUDGET_MS ? 'within' : 'OVER';
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(14)} ${samples.map(s => `${s}ms`).join(', ')}` +
      `  median ${median}ms ${verdict} the ${BUDGET_MS}ms budget` +
      ` (slowest ${slowest}ms)`,
  );
  return { median, slowest };
}

async function measure(
  page: Page,
  label: string,
  path: string,
  ready: () => Promise<unknown>,
) {
  const cold: number[] = [];
  const warm: number[] = [];
  let apiCalls: string[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    // Each sample starts from a blank page, or the second navigation would be
    // a client-side route change and measure nothing like a page load.
    await clearResourceCache(page);
    await page.goto('about:blank');
    cold.push((await loadPage(page, path, ready)).ms);

    await page.goto('about:blank');
    const run = await loadPage(page, path, ready);
    warm.push(run.ms);
    apiCalls = run.apiCalls;
  }

  summarise(`${label} cold`, cold);
  summarise(`${label} warm`, warm);
  return { apiCalls };
}

/**
 * The first repository row in a table.
 *
 * Matched on the link target rather than on a repository name: which name
 * sorts first differs between the catalog (alphabetical) and the fleet view
 * (worst score first), and both change as the estate does.
 */
function firstRepositoryRow(page: Page) {
  return page
    .locator('table tbody a[href^="/catalog/default/component/"]')
    .first();
}

/** How many times one API path was requested during a single page load. */
function countCalls(apiCalls: string[], match: (path: string) => boolean) {
  return apiCalls.filter(match).length;
}

test.describe.configure({ mode: 'serial' });

test.describe('page load', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('the fleet view asks for the estate once, not once per repository', async () => {
    const { apiCalls } = await measure(page, 'fleet', '/fleet', async () => {
      // A row, not the heading: the heading renders before the data arrives.
      await expect(firstRepositoryRow(page)).toBeVisible();
    });

    // The whole estate arrives in one response and is filtered in the browser.
    // If this ever becomes 95, the page has grown an N+1 and will not survive
    // an estate ten times this size.
    expect(
      countCalls(apiCalls, p => p.startsWith('/api/fleet/repositories')),
    ).toBe(1);
  });

  test('a repository page asks for its facts once', async () => {
    const { apiCalls } = await measure(
      page,
      'entity',
      '/catalog/default/component/oxp-backend',
      async () => {
        // The score, which only appears once the fleet API has answered.
        await expect(page.getByText('Health score')).toBeVisible();
      },
    );

    expect(
      countCalls(apiCalls, p =>
        p.startsWith('/api/fleet/repositories/by-entity'),
      ),
    ).toBe(1);
  });

  test('the catalog loads', async () => {
    // The catalog is mounted at the root here, not at /catalog -- see the
    // `page:catalog` extension config in app-config.yaml.
    await measure(page, 'catalog', '/', async () => {
      await expect(firstRepositoryRow(page)).toBeVisible();
    });
  });
});
