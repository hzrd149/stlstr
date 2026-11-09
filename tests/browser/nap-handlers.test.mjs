import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

/**
 * End-to-end coverage for the shell's NAP service handlers. These drive the real wire
 * protocol from inside a sandboxed napplet iframe: the napplet calls window.napplet.*,
 * the message crosses postMessage, and the shell's service answers it.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

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

/** Opens the search route, which is granted both the resource and intent domains. */
async function openBrowseNapplet(path = '/search', extraDomains = []) {
  const page = await browser.newPage();
  if (extraDomains.length) {
    const manifest = JSON.parse(
      await readFile(
        new URL('../../napplets/print-search/dist/.nip5a-manifest.json', import.meta.url),
        'utf8',
      ),
    );
    const capabilityTag = manifest.tags.some((tag) => tag[0] === 'x' && tag[2] === 'aggregate')
      ? 'requires'
      : 'R';
    const signed = finalizeEvent(
      {
        ...manifest,
        tags: [...manifest.tags, ...extraDomains.map((domain) => [capabilityTag, domain])],
      },
      generateSecretKey(),
    );
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().endsWith('/print-search/.nip5a-manifest.json')) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(signed),
        });
      } else void request.continue();
    });
  }
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle0' });

  const iframeHandle = await page.waitForSelector('iframe[title="Search prints napplet"]');
  const frame = await iframeHandle.contentFrame();
  assert.ok(frame, 'browse napplet iframe should be available');

  // The prelude installs the namespace before napplet scripts run.
  await frame.waitForFunction(() => Boolean(window.napplet?.resource && window.napplet?.intent));
  return { page, frame };
}

/** Calls resource.bytes inside the napplet and reports only clone-safe fields. */
function readResource(frame, url) {
  return frame.evaluate(async (target) => {
    try {
      const blob = await window.napplet.resource.bytes(target);
      return { ok: true, mime: blob.type, size: blob.size };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, url);
}

test('NAP-RESOURCE reports the shell fetch policy', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const info = await frame.evaluate(() => window.napplet.resource.info());
    const schemes = Object.fromEntries(info.schemes.map((entry) => [entry.scheme, entry.enabled]));

    assert.equal(schemes.https, true);
    assert.equal(schemes.http, true);
    assert.equal(schemes.blossom, true);
    assert.equal(info.maxBytes, 10 * 1024 * 1024);
    assert.equal(info.maxUrls, 100);
  } finally {
    await page.close();
  }
});

test('Applesauce common answers anonymous follows through the frame port', async () => {
  const { page, frame } = await openBrowseNapplet();
  try {
    const result = await frame.evaluate(() => window.napplet.common.follows());
    assert.equal(result.ok, false);
    assert.ok(result.error, 'anonymous social actions return a concrete failure');
  } finally {
    await page.close();
  }
});

test('Applesauce lists is available only when declared by the manifest', async () => {
  const ordinary = await openBrowseNapplet();
  try {
    assert.equal(await ordinary.frame.evaluate(() => typeof window.napplet.lists), 'undefined');
  } finally {
    await ordinary.page.close();
  }
  const { page, frame } = await openBrowseNapplet('/search', ['lists']);
  try {
    const { lists: supported } = await frame.evaluate(() => window.napplet.lists.supported());
    assert.ok(supported.length > 0, JSON.stringify(supported));
    assert.ok(supported.some((list) => list.type === 'bookmarks'));
  } finally {
    await page.close();
  }
});

test('the host refuses artifact bytes that do not match the signed manifest', async () => {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().endsWith('/print-search/index.html')) {
        void request.respond({
          status: 200,
          contentType: 'text/html',
          body: '<p>Tampered artifact</p>',
        });
      } else void request.continue();
    });
    await page.goto(`${baseUrl}/search`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() =>
      document.querySelector('[role="alert"]')?.textContent?.includes('Could not load'),
    );
    assert.equal(await page.$('iframe[title="Search prints napplet"]'), null);
  } finally {
    await page.close();
  }
});

test('NAP-RESOURCE proxies bytes and classifies them by sniffing', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    // The dev server sends this as application/json. The napplet must receive the
    // sniffed type instead, because upstream Content-Type is attacker-controlled.
    const result = await readResource(frame, `${baseUrl}/napplets.dev.json`);

    assert.ok(result.ok, `expected bytes, got ${result.error}`);
    assert.ok(result.size > 0, 'proxied response should have bytes');
    assert.equal(result.mime, 'application/octet-stream');
  } finally {
    await page.close();
  }
});

test('NAP-RESOURCE sniffs a real image as image/png', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const result = await readResource(frame, `${baseUrl}/src/assets/hero.png`);

    assert.ok(result.ok, `expected bytes, got ${result.error}`);
    assert.equal(result.mime, 'image/png');
  } finally {
    await page.close();
  }
});

test('NAP-RESOURCE refuses SVG until the shell can rasterize it', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const result = await readResource(frame, `${baseUrl}/favicon.svg`);

    // Refusals raised after the fetch starts collapse to `network-error` on the wire; the
    // shell logs the real reason. Only the refusal itself is observable to the napplet.
    assert.equal(result.ok, false, 'raw SVG must not reach the napplet');
    assert.equal(result.error, 'network-error');
  } finally {
    await page.close();
  }
});

test('NAP-RESOURCE blocks unsupported schemes by policy', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const result = await readResource(frame, 'ftp://example.com/model.stl');

    assert.equal(result.ok, false);
    assert.match(result.error, /blocked-by-policy/);
  } finally {
    await page.close();
  }
});

test('NAP-INTENT advertises the archetypes the shell can route', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const detail = await frame.evaluate(() => window.napplet.intent.available('printable-detail'));
    assert.equal(detail.available, true);
    assert.equal(detail.hasDefault, true);
    assert.deepEqual(
      detail.candidates.map((candidate) => candidate.id),
      ['print-detail'],
    );

    const unknown = await frame.evaluate(() => window.napplet.intent.available('mastodon-toot'));
    assert.equal(unknown.available, false);
    assert.deepEqual(unknown.candidates, []);

    const handlers = await frame.evaluate(() => window.napplet.intent.handlers());
    assert.deepEqual(handlers.map((entry) => entry.archetype).sort(), [
      'make-create',
      'make-detail',
      'part-detail',
      'part-library',
      'part-upload',
      'printable-create',
      'printable-detail',
      'printable-discovery',
      'printable-edit',
      'printable-search',
      'profile',
      'stl-preview',
    ]);
  } finally {
    await page.close();
  }
});

test('NAP-INTENT open navigates the shell to the print route', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const result = await frame.evaluate(() =>
      window.napplet.intent.open('printable-detail', {
        address: '33500:deadbeef:adjustable-phone-stand',
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.handler, 'print-detail');

    await page.waitForFunction(
      () => window.location.pathname === '/printables/deadbeef/adjustable-phone-stand',
    );
    await page.waitForSelector('iframe[title="Print details napplet"]');
  } finally {
    await page.close();
  }
});

test('NAP-INTENT rejects a request it cannot route', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const noPayload = await frame.evaluate(() =>
      window.napplet.intent.open('printable-detail', {}),
    );
    assert.equal(noPayload.ok, false);
    assert.match(noPayload.error, /address/i);

    const unknown = await frame.evaluate(() => window.napplet.intent.open('mastodon-toot', {}));
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /no handler/i);

    // A failed intent must not move the shell off the search route.
    assert.equal(new URL(page.url()).pathname, '/search');
  } finally {
    await page.close();
  }
});
