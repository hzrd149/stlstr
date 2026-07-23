import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { MAKERS } from '../../scripts/lib/test-fixtures.mjs';

/**
 * End-to-end coverage for the NAP-INTENT delivery seam: the shell routes, and the handling
 * napplet receives its payload whether the intent came from a napplet or from a deep link.
 * The card-click round trip itself is covered in browse-feed.test.mjs.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

/** Any maker the test relay knows about; the profile is real, so it renders a name. */
const FEATURED_PUBKEY = MAKERS.vera.pubkey;

let browser;

before(async () => {
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
});

after(async () => {
  await browser?.close();
});

async function openStlstr(path = '/') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle0' });
  return page;
}

async function nappletFrame(page, title) {
  const handle = await page.waitForSelector(`iframe[title="${title} napplet"]`);
  const frame = await handle.contentFrame();
  assert.ok(frame, `${title} iframe should be available`);
  return frame;
}

/**
 * Waits until the profile napplet has actually received a maker. `profile-scope` renders
 * only when a pubkey arrived over the intent seam, so it is a precise delivery signal —
 * unlike the status line, which is empty on success.
 */
async function deliveredProfile(page) {
  const frame = await nappletFrame(page, 'Maker profile');
  await frame.waitForSelector('[data-testid="profile-scope"]');
  return frame;
}

test('a deep link delivers the same payload as an in-app intent', async () => {
  // No prior intent: the payload comes only from the URL, which is the refresh path.
  const page = await openStlstr(`/profiles/${FEATURED_PUBKEY}`);

  try {
    // The payload arrived on a cold mount, with no prior intent to carry it.
    const frame = await deliveredProfile(page);

    // A delivered-but-empty payload is the failure this guards: the napplet says so
    // explicitly, and that message must never appear.
    const status = await frame
      .$eval('[data-testid="profile-status"]', (node) => node.textContent ?? '')
      .catch(() => '');
    assert.doesNotMatch(status, /without a maker/i);
  } finally {
    await page.close();
  }
});

test('the browse napplet renders the search payload the shell delivers', async () => {
  const page = await openStlstr('/search?q=phone%20stand');

  try {
    const frame = await nappletFrame(page, 'Search: phone stand');
    const text = await frame.waitForSelector('[data-testid="browse-query"]');

    assert.match(await text.evaluate((node) => node.textContent ?? ''), /phone stand/);
  } finally {
    await page.close();
  }
});

test('the browse napplet renders the tag payload the shell delivers', async () => {
  const page = await openStlstr('/tags/desk');

  try {
    const frame = await nappletFrame(page, '#desk');
    const text = await frame.waitForSelector('[data-testid="browse-tag"]');

    assert.match(await text.evaluate((node) => node.textContent ?? ''), /#desk/);
  } finally {
    await page.close();
  }
});

test('a payload is not delivered to the napplet on the next route', async () => {
  const page = await openStlstr('/tags/desk');

  try {
    await nappletFrame(page, '#desk');

    // Navigate to a plain browse route; its napplet must not inherit the tag.
    await page.click('a[href="/"]');
    const frame = await nappletFrame(page, 'Browse objects');
    await frame.waitForSelector('[data-testid="browse-results"]');

    assert.equal(await frame.$('[data-testid="browse-tag"]'), null);
  } finally {
    await page.close();
  }
});
