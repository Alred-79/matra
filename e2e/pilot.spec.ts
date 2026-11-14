/**
 * The pilot build: sealed matching OFF (MATRA_MATCHING=off on the server and in the web build; playwright.pilot.config.ts).
 * A survivor writes, names the person with a phone number and a handle, seals and shares with an attorney, and at no
 * point is she asked about a sealed match or a phone confirmation, nor does the app call a matching route. The server
 * answers 404 matching_disabled on those routes. All data is fictional.
 */
import type { Page } from '@playwright/test';
import {
  ATTORNEY_PASS,
  RUN,
  SURVIVOR_PASS,
  addToStory,
  enough,
  expect,
  fill,
  chip,
  moreDetails,
  nav,
  openTopic,
  registerSurvivor,
  savePage,
  sealFromReview,
  shot,
  signIn,
  signOut,
  storyMap,
  storySafety,
  test,
} from './helpers';

test.describe.configure({ mode: 'serial' });

const ALIAS = `wren-${RUN}`;
const ATTORNEY = 'attorney.nj1';
const ATTORNEY_NAME = 'Demo — Alex Rivera, Esq.';
const NARRATIVE = 'We were at a friend’s place. He would not let me leave the hallway.\n\nI said no, more than once.';
const MATCHING_ROUTE = /\/api\/(matching|escrow|counselor|report-requests|report-releases)(\/|\?|$)/;

/** Every API path this page asks for, from now on. */
function recordApi(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) seen.push(`${r.method()} ${u.pathname}`);
  });
  return seen;
}

test('pilot 1. the server has no sealed matching: every matching route and counselor sign-up answers 404', async ({ request }) => {
  for (const p of ['/api/matching/config', '/api/matching/attestation?nonce=' + 'a'.repeat(64), '/api/escrow', '/api/counselor/groups', '/api/report-requests']) {
    const res = await request.get(p);
    expect([p, res.status()]).toEqual([p, 404]);
    expect(await res.json()).toEqual({ error: 'Sealed matching isn’t part of this service.', code: 'matching_disabled' });
  }
  const reg = await request.post('/api/auth/register', { data: { username: `loc-${RUN}`, role: 'counselor' } });
  expect(reg.status()).toBe(404);
  expect((await reg.json()).code).toBe('matching_disabled');
});

test('pilot 2. she writes, names him with a phone and a handle, seals and shares: no sealed-match question, no phone step, no matching call', async ({ page }) => {
  const api = recordApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Tell it once/ })).toBeVisible();
  // no way into a counselor portal from the welcome page
  await expect(page.getByTestId('attorney-link')).toBeVisible();
  await expect(page.getByTestId('counselor-link')).toHaveCount(0);

  await registerSurvivor(page, ALIAS);
  await expect(page.getByTestId('home-escrow')).toHaveCount(0);
  await nav(page, 'My story');
  await expect(page.locator('.space-root')).toBeVisible({ timeout: 60_000 });
  await storySafety(page, 'Yes');
  await addToStory(page, NARRATIVE);
  await expect(page.getByTestId('vault-status')).toContainText('Saved to your private space', { timeout: 30_000 });

  // The person: a phone number and a handle — exactly what used to bring up the sealed-match choice.
  await openTopic(page, 'person');
  await fill(page, { 'Name, or what you call them': 'R.', 'How you know them': 'coworker' });
  await moreDetails(page);
  await fill(page, {
    'Their phone number': '(201) 555-0199',
    'Their social media name or handle': '@pilot_handle_123',
    'Which app or site?': { select: 'instagram' },
  });
  await expect(page.locator('[data-topic-panel]').getByText(/sealed match/i)).toHaveCount(0);
  await savePage(page);
  // the person topic ends here: no "Yes, seal it", no "how should a counselor reach you"
  await expect(page.getByText('That’s everything here. Thank you.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, seal it' })).toHaveCount(0);
  await expect(page.locator('[data-topic-panel]').getByText(/counselor/i)).toHaveCount(0);
  await page.locator('[data-topic-panel]').getByRole('button', { name: 'Back to your story' }).last().click();
  if (await page.locator('[data-topic-panel]').count()) await enough(page);

  await storyMap(page).getByRole('button', { name: /^Review/ }).click();
  await expect(page.getByRole('region', { name: 'Here is everything you shared' })).toBeVisible();
  await sealFromReview(page);
  await expect(page.getByTestId('phone-step-card')).toHaveCount(0);
  await expect(page.getByText(/sealed match/i)).toHaveCount(0);
  await shot(page, 'pilot-01-sealed', { mobile: false });

  await nav(page, 'Home');
  await expect(page.getByTestId('home-story').getByText('Current sealed version')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('home-escrow')).toHaveCount(0);
  await expect(page.getByText(/sealed match/i)).toHaveCount(0);
  await shot(page, 'pilot-02-home');

  // Share with an attorney: works as before.
  await nav(page, 'Sharing');
  const card = page.locator('li.card', { hasText: ATTORNEY_NAME });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole('button', { name: 'Review and decide' }).click();
  await expect(page.locator('.consent-text')).toContainText(`I, "${ALIAS}", choose to share`);
  await page.getByLabel('I agree to the statement above.').check();
  await page.getByRole('button', { name: `Yes, share with ${ATTORNEY_NAME}` }).click();
  await expect(page.getByRole('heading', { name: `Shared with ${ATTORNEY_NAME}` })).toBeVisible({ timeout: 60_000 });
  await signOut(page);

  // The survivor's whole session never asked for a matching route (a sealed match, a phone check, report requests).
  expect(api.filter((a) => MATCHING_ROUTE.test(a))).toEqual([]);
  expect(api).toEqual(expect.arrayContaining(['POST /api/vault/records', 'POST /api/shares']));
});

test('pilot 3. the attorney opens and verifies what she shared', async ({ page }) => {
  const api = recordApi(page);
  await signIn(page, ATTORNEY, ATTORNEY_PASS, 'attorney');
  await page.getByRole('link', { name: 'Open' }).first().click();
  await expect(page.getByRole('heading', { name: `Client: ${ALIAS}` })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('case-verification').getByText('Verified ✓')).toBeVisible();
  await expect(page.getByTestId('case-checks').locator('[data-check="account"]')).toHaveAttribute('data-tone', 'ok');
  expect(await page.locator('.brief-verbatim-text').allTextContents()).toContain(NARRATIVE);
  await shot(page, 'pilot-03-attorney-case', { mobile: false });
  await signOut(page);
  expect(api.filter((a) => MATCHING_ROUTE.test(a))).toEqual([]);
});
