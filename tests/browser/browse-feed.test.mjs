import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { addressOf, MAKERS, OBJECTS } from '../../scripts/lib/test-fixtures.mjs';

/**
 * The home feed, end to end: objects published to the test relay are read through
 * NAP-OUTBOX, covers are proxied through NAP-RESOURCE, and both click targets on a card
 * dispatch NAP-INTENT.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

/** Fixtures are ordered oldest first, so the last one is the newest card. */
const NEWEST = OBJECTS[OBJECTS.length - 1];

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

/** The shell titles the frame after the intent, so each browse route has its own title. */
async function openBrowse(path = '/', title = 'Browse prints') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle0' });

  const handle = await page.waitForSelector(`iframe[title="${title} napplet"]`);
  const frame = await handle.contentFrame();
  assert.ok(frame, 'browse napplet iframe should be available');

  await frame.waitForSelector('[data-testid="browse-results"]');
  return { page, frame };
}

function textsOf(frame, selector) {
  return frame.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
}

test('the feed lists recently published objects, newest first', async () => {
  const { page, frame } = await openBrowse();

  try {
    // The dev relay is shared with manual development, so it may hold objects beyond the
    // fixtures. Assert on the fixtures rather than on the whole feed.
    await frame.waitForFunction(
      (expected) => {
        const shown = [...document.querySelectorAll('[data-testid="object-title"]')].map(
          (node) => node.textContent?.trim() ?? '',
        );
        return expected.every((title) => shown.includes(title));
      },
      {},
      OBJECTS.map((object) => object.title),
    );

    const titles = await textsOf(frame, '[data-testid="object-title"]');
    const fixtureOrder = titles.filter((title) => OBJECTS.some((object) => object.title === title));
    assert.deepEqual(
      fixtureOrder,
      [...OBJECTS].reverse().map((object) => object.title),
    );
  } finally {
    await page.close();
  }
});

test('cards render maker names rather than raw pubkeys', async () => {
  const { page, frame } = await openBrowse();

  try {
    // Names resolve on a second query, so the first paint says "Unknown maker".
    await frame.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-testid="open-maker"]')].some((node) =>
          node.textContent?.includes(name),
        ),
      {},
      MAKERS[NEWEST.maker].name,
    );

    const body = await frame.$eval('main', (node) => node.textContent ?? '');
    assert.doesNotMatch(body, /[0-9a-f]{32}/i, 'no hex identifier should reach the page');
  } finally {
    await page.close();
  }
});

test('a cover image is proxied through NAP-RESOURCE', async () => {
  const { page, frame } = await openBrowse();

  try {
    const image = await frame.waitForSelector('[data-testid="object-result"] img');

    // A blob: URL is the proof it came through resource.bytes rather than a bare <img src>.
    assert.match(await image.evaluate((node) => node.src), /^blob:/);
    assert.ok(await image.evaluate((node) => node.naturalWidth > 0), 'cover should decode');
  } finally {
    await page.close();
  }
});

test('clicking a card opens the object detail route', async () => {
  const { page, frame } = await openBrowse();

  try {
    const card = await frame.waitForSelector(
      `[data-testid="open-object"][data-address="${addressOf(NEWEST)}"]`,
    );
    await card.click();

    await page.waitForFunction(
      (expected) => window.location.pathname === expected,
      {},
      `/objects/${MAKERS[NEWEST.maker].pubkey}/${NEWEST.identifier}`,
    );
    await page.waitForSelector('iframe[title="Print details napplet"]');
  } finally {
    await page.close();
  }
});

test('clicking a maker opens their profile route', async () => {
  const { page, frame } = await openBrowse();

  try {
    const pubkey = MAKERS[NEWEST.maker].pubkey;
    const maker = await frame.waitForSelector(
      `[data-testid="open-maker"][data-pubkey="${pubkey}"]`,
    );
    await maker.click();

    await page.waitForFunction(
      (expected) => window.location.pathname === expected,
      {},
      `/profiles/${pubkey}`,
    );

    // The profile napplet received the maker over the intent seam and loaded their kind:0.
    const handle = await page.waitForSelector('iframe[title="Maker profile napplet"]');
    const profile = await handle.contentFrame();
    await profile.waitForSelector('[data-testid="profile-scope"]');
    await profile.waitForFunction(
      (name) =>
        document.querySelector('[data-testid="profile-name"]')?.textContent?.trim() === name,
      {},
      MAKERS[NEWEST.maker].name,
    );
  } finally {
    await page.close();
  }
});

test('a tag route narrows the feed to that topic', async () => {
  const { page, frame } = await openBrowse('/tags/workshop', '#workshop');

  try {
    const expected = OBJECTS.filter((object) => object.topics.includes('workshop'));
    await frame.waitForFunction(
      (titles) => {
        const shown = [...document.querySelectorAll('[data-testid="object-title"]')].map(
          (node) => node.textContent?.trim() ?? '',
        );
        return titles.every((title) => shown.includes(title));
      },
      {},
      expected.map((object) => object.title),
    );

    // Objects that carry the tag are shown; the ones that do not are filtered out.
    const titles = await textsOf(frame, '[data-testid="object-title"]');
    const excluded = OBJECTS.filter((object) => !object.topics.includes('workshop'));
    for (const object of excluded) assert.ok(!titles.includes(object.title), object.title);
  } finally {
    await page.close();
  }
});

test('searching routes through the shell and filters the feed', async () => {
  const { page, frame } = await openBrowse();

  try {
    await frame.type('input[aria-label="Search prints"]', 'hex bit');
    await frame.click('button.btn-primary');

    // The search is a shell route, so it is linkable and survives a refresh.
    await page.waitForFunction(() => window.location.pathname === '/search');

    const handle = await page.waitForSelector('iframe[title="Search: hex bit napplet"]');
    const searched = await handle.contentFrame();
    await searched.waitForSelector('[data-testid="browse-results"]');
    await searched.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="object-title"]')].some(
        (node) => node.textContent?.trim() === 'Hex Bit Holder',
      ),
    );

    // Every result matched the query; the other fixtures are gone.
    const titles = await textsOf(searched, '[data-testid="object-title"]');
    for (const object of OBJECTS) {
      if (object.title === 'Hex Bit Holder') continue;
      assert.ok(!titles.includes(object.title), `${object.title} should not match "hex bit"`);
    }
  } finally {
    await page.close();
  }
});
