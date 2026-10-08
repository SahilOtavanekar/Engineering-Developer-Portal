/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from '@playwright/test';

test('App should render the welcome page', async ({ page }) => {
  await page.goto('/');

  const enterButton = page.getByRole('button', { name: 'Enter' });
  await expect(enterButton).toBeVisible();
  await enterButton.click();

  const nav = page.getByRole('navigation', { name: 'sidebar nav' });
  await expect(
    nav.getByRole('link', { name: 'Catalog', exact: true }),
  ).toBeVisible();

  // Health Dashboard, not the scaffold's "APIs".
  //
  // This assertion was checking for a nav item the portal has never had:
  // `@backstage/plugin-api-docs` is not a dependency and is absent from the
  // package manifest at HEAD too, so the check has been failing since before
  // this test was last looked at. It came from the Backstage scaffold.
  //
  // A page of our own is the more valuable thing to pin anyway. `AppNav`
  // discards a page extension outright -- silently, no warning -- if it lacks a
  // route ref, a title or an icon, and such a page still routes and still
  // renders when visited directly. So it disappearing from the sidebar is a
  // failure mode that nothing else here would catch.
  await expect(
    nav.getByRole('link', { name: 'Health Dashboard', exact: true }),
  ).toBeVisible();
});

test('lands on the Health Dashboard, with the menu in its set order', async ({
  page,
}) => {
  await page.goto('/');
  const enterButton = page.getByRole('button', { name: 'Enter' });
  await expect(enterButton).toBeVisible();
  await enterButton.click();

  // `/` redirects through app-config.yaml's `app/routes` redirects.
  await expect(page).toHaveURL(/\/fleet$/);

  // `Sidebar.tsx` takes these by extension id, and a wrong id fails silently:
  // the page drops back into the alphabetical rest, which would put Catalog
  // first again. Only the rendered order shows that.
  const nav = page.getByRole('navigation', { name: 'sidebar nav' });
  const menu = ['Health Dashboard', 'Catalog', 'Productivity'];
  const tops: number[] = [];
  for (const name of menu) {
    const link = nav.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    tops.push((await link.boundingBox())!.y);
  }
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  // The catalog is back at its standard address.
  await nav.getByRole('link', { name: 'Catalog', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);
});
