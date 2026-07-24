import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { addressOf, MAKERS, PRINTABLES } from '../../scripts/lib/test-fixtures.mjs';

/**
 * The search feed, end to end: printables published to the test relay are read through
 * NAP-OUTBOX, covers are proxied through NAP-RESOURCE, and both click targets on a card
 * dispatch NAP-INTENT.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

/** Fixtures are ordered oldest first, so the last one is the newest card. */
const NEWEST = PRINTABLES[PRINTABLES.length - 1];

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
async function openBrowse(path = '/search', title = 'Search prints') {
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

test('the feed lists recently published printables, newest first', async () => {
  const { page, frame } = await openBrowse();

  try {
    // The dev relay is shared with manual development, so it may hold printables beyond the
    // fixtures. Assert on the fixtures rather than on the whole feed.
    await frame.waitForFunction(
      (expected) => {
        const shown = [...document.querySelectorAll('[data-testid="printable-title"]')].map(
          (node) => node.textContent?.trim() ?? '',
        );
        return expected.every((title) => shown.includes(title));
      },
      {},
      PRINTABLES.map((printable) => printable.title),
    );

    const titles = await textsOf(frame, '[data-testid="printable-title"]');
    const fixtureOrder = titles.filter((title) =>
      PRINTABLES.some((printable) => printable.title === title),
    );
    assert.deepEqual(
      fixtureOrder,
      [...PRINTABLES].reverse().map((printable) => printable.title),
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
    const image = await frame.waitForSelector('[data-testid="printable-result"] img');

    // A blob: URL is the proof it came through resource.bytes rather than a bare <img src>.
    assert.match(await image.evaluate((node) => node.src), /^blob:/);
    assert.ok(await image.evaluate((node) => node.naturalWidth > 0), 'cover should decode');
  } finally {
    await page.close();
  }
});

test('clicking a card opens the printable detail route', async () => {
  const { page, frame } = await openBrowse();

  try {
    const card = await frame.waitForSelector(
      `[data-testid="open-printable"][data-address="${addressOf(NEWEST)}"]`,
    );
    await card.click();

    await page.waitForFunction(
      (expected) => window.location.pathname === expected,
      {},
      `/printables/${MAKERS[NEWEST.maker].pubkey}/${NEWEST.identifier}`,
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
    const expected = PRINTABLES.filter((printable) => printable.topics.includes('workshop'));
    await frame.waitForFunction(
      (titles) => {
        const shown = [...document.querySelectorAll('[data-testid="printable-title"]')].map(
          (node) => node.textContent?.trim() ?? '',
        );
        return titles.every((title) => shown.includes(title));
      },
      {},
      expected.map((printable) => printable.title),
    );

    // Printables that carry the tag are shown; the ones that do not are filtered out.
    const titles = await textsOf(frame, '[data-testid="printable-title"]');
    const excluded = PRINTABLES.filter((printable) => !printable.topics.includes('workshop'));
    for (const printable of excluded) assert.ok(!titles.includes(printable.title), printable.title);
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
      [...document.querySelectorAll('[data-testid="printable-title"]')].some(
        (node) => node.textContent?.trim() === 'Hex Bit Holder',
      ),
    );

    // Every result matched the query; the other fixtures are gone.
    const titles = await textsOf(searched, '[data-testid="printable-title"]');
    for (const printable of PRINTABLES) {
      if (printable.title === 'Hex Bit Holder') continue;
      assert.ok(!titles.includes(printable.title), `${printable.title} should not match "hex bit"`);
    }
  } finally {
    await page.close();
  }
});
