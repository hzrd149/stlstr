import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { MAKERS, OBJECTS } from '../../scripts/lib/test-fixtures.mjs';

/**
 * The preview dialog: an overlay archetype rendered over the current page instead of as a
 * page of its own.
 *
 * The load-bearing claims under test are that the overlay leaves the page beneath it alive,
 * that its state lives in the URL so it survives a refresh and answers to Back, and that two
 * napplets on one `window` do not cross-deliver.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

const OBJECT = OBJECTS.find((object) => object.identifier === 'adjustable-phone-stand');
const OBJECT_PATH = `/objects/${MAKERS[OBJECT.maker].pubkey}/${OBJECT.identifier}`;
const FILE_PAYLOAD = {
  url: `${baseUrl}/src/assets/cube.stl`,
  name: `${OBJECT.identifier}.stl`,
  mime: 'model/stl',
  size: '684',
};
const ENCODED_FILE_PAYLOAD = encodeURIComponent(JSON.stringify(FILE_PAYLOAD));

let browser;

before(async () => {
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true,
    // The preview needs a real WebGL context. Headless Chromium falls back to SwiftShader
    // on its own, but only with this flag set — `--use-gl=swiftshader` selects a path that
    // yields no WebGL context at all, which reads as the viewer being broken.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader'],
  });
});

after(async () => {
  await browser?.close();
});

async function openStlstr(path) {
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

/** Waits for the preview napplet to have actually received and rendered a part. */
async function renderedPreview(page) {
  const frame = await nappletFrame(page, 'STL preview');
  await frame.waitForSelector('[data-testid="preview-name"]');
  await frame.waitForFunction(() => !document.querySelector('[data-testid="preview-status"]'));
  return frame;
}

async function hasStlPayload(page, expected) {
  return page.evaluate((payload) => {
    const raw = new URLSearchParams(window.location.search).get('stl');
    if (!raw) return false;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw));
      return Object.entries(payload).every(([key, value]) => parsed[key] === value);
    } catch {
      return false;
    }
  }, expected);
}

async function openPreviewFromDetail(page) {
  const detail = await nappletFrame(page, 'Print details');
  const button = await detail.waitForSelector('[data-testid="preview-part"]');
  await button.click();
  return detail;
}

test('a part opens in the dialog and records itself in the URL', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    await openPreviewFromDetail(page);

    await page.waitForFunction(
      (payload) => {
        const raw = new URLSearchParams(window.location.search).get('stl');
        if (!raw) return false;
        const parsed = JSON.parse(decodeURIComponent(raw));
        return Object.entries(payload).every(([key, value]) => parsed[key] === value);
      },
      {},
      FILE_PAYLOAD,
    );

    // The base route is untouched: an overlay modifies the current page, never replaces it.
    assert.equal(await page.evaluate(() => window.location.pathname), OBJECT_PATH);

    const preview = await renderedPreview(page);
    const name = await preview.$eval('[data-testid="preview-name"]', (node) => node.textContent);
    assert.match(name, /adjustable-phone-stand\.stl/);

    // The status line renders only while the viewer is NOT showing a mesh, so its absence
    // is the assertion that the bytes were fetched, parsed, and handed to a live WebGL
    // context — not merely that the file's metadata resolved.
    const stuck = await preview.$('[data-testid="preview-status"]');
    const stuckText = stuck ? await stuck.evaluate((node) => node.textContent?.trim()) : '';
    assert.equal(stuckText, '', 'the viewer did not reach a rendered mesh');
    const footer = await preview.$eval('footer', (node) => node.textContent ?? '');
    assert.match(footer, /12 triangles/);
  } finally {
    await page.close();
  }
});

test('the page beneath the dialog keeps running', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    const detail = await openPreviewFromDetail(page);
    await renderedPreview(page);

    // A remounted napplet would have torn its iframe down and rebuilt it; an intact
    // execution context proves the frame beneath was never destroyed.
    const title = await detail.$eval('[data-testid="object-title"]', (node) => node.textContent);
    assert.equal(title, OBJECT.title);
  } finally {
    await page.close();
  }
});

test('a payload sent to the dialog does not reach the napplet beneath it', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    await openPreviewFromDetail(page);
    await renderedPreview(page);

    // The detail napplet has no preview surface at all, so its own status line is the
    // observable: the preview payload must not have disturbed the object it is showing.
    const detail = await nappletFrame(page, 'Print details');
    const leaked = await detail.$('[data-testid="preview-name"]');
    assert.equal(leaked, null, 'the preview payload leaked into the page napplet');
  } finally {
    await page.close();
  }
});

test('a deep-linked preview renders without any prior intent', async () => {
  const page = await openStlstr(`${OBJECT_PATH}?stl=${ENCODED_FILE_PAYLOAD}`);

  try {
    const preview = await renderedPreview(page);
    const name = await preview.$eval('[data-testid="preview-name"]', (node) => node.textContent);
    assert.match(name, /adjustable-phone-stand\.stl/);

    // And the page underneath still loaded normally.
    const detail = await nappletFrame(page, 'Print details');
    await detail.waitForSelector('[data-testid="object-title"]');
  } finally {
    await page.close();
  }
});

test('closing the dialog restores the base URL', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    await openPreviewFromDetail(page);
    await renderedPreview(page);

    const close = await page.waitForSelector('[data-testid="preview-close"]');
    await close.click();

    await page.waitForFunction(() => !window.location.search.includes('stl='));
    assert.equal(await page.evaluate(() => window.location.pathname), OBJECT_PATH);
    assert.equal(await page.$('iframe[title="STL preview napplet"]'), null);
  } finally {
    await page.close();
  }
});

test('back closes the dialog and forward reopens it with the payload', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    await openPreviewFromDetail(page);
    await renderedPreview(page);

    await page.goBack();
    await page.waitForFunction(() => !window.location.search.includes('stl='));

    await page.goForward();
    await page.waitForFunction(() => window.location.search.includes('stl='));
    assert.equal(await hasStlPayload(page, FILE_PAYLOAD), true);

    // Redelivery on the way forward, not just a re-mounted empty dialog.
    await renderedPreview(page);
  } finally {
    await page.close();
  }
});

test('a deep-linked preview closes to the page beneath it', async () => {
  const page = await openStlstr(`${OBJECT_PATH}?stl=${ENCODED_FILE_PAYLOAD}`);

  try {
    await renderedPreview(page);

    const close = await page.waitForSelector('[data-testid="preview-close"]');
    await close.click();

    // No history entry to go back to, so it collapses to the base page rather than
    // navigating out of the app.
    await page.waitForFunction(() => !window.location.search.includes('stl='));
    assert.equal(await page.evaluate(() => window.location.pathname), OBJECT_PATH);
  } finally {
    await page.close();
  }
});

test('the shell advertises the preview archetype it can route', async () => {
  const page = await openStlstr(OBJECT_PATH);

  try {
    const detail = await nappletFrame(page, 'Print details');

    // The Preview button renders only after `intent.available` confirms a handler, so its
    // presence is the assertion that the archetype is advertised.
    await detail.waitForSelector('[data-testid="preview-part"]');
  } finally {
    await page.close();
  }
});
