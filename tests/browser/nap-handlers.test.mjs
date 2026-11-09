import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

/**
 * End-to-end coverage for the shell's NAP service handlers. These drive the real wire
 * protocol from inside a sandboxed napplet iframe: the napplet calls window.napplet.*,
 * the message crosses postMessage, and the shell's service answers it.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';
/** The key `scripts/test-browser.mjs` builds the napplets' sidecar manifests with. */
const devPrivkeyHex =
  process.env.VITE_DEV_PRIVKEY_HEX ||
  '00000000000000000000000000000000000000000000000000000000deadbeef';

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

/**
 * NAP-INTENT catalog id of a built-in napplet in the test build: its sidecar manifest is a
 * named (35129) manifest signed with the dev key, so the id is `nip5d:35129:<pubkey>:<d>`.
 */
function catalogId(dTag) {
  return `nip5d:35129:${getPublicKey(hexToBytes(devPrivkeyHex))}:${dTag}`;
}

/** The intent provenance the shell recorded in router history state for an archetype. */
function recordedIntent(page, archetype) {
  return page.evaluate((key) => window.history.state?.usr?.intents?.[key] ?? null, archetype);
}

test('NAP-INTENT advertises the archetypes the shell can route', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const detail = await frame.evaluate(() => window.napplet.intent.available('printable-detail'));
    assert.equal(detail.available, true);
    assert.equal(detail.hasDefault, true);
    // Candidates are identified by opaque manifest catalog ids, never a bare d tag.
    assert.deepEqual(
      detail.candidates.map((candidate) => candidate.id),
      [catalogId('print-detail')],
    );
    assert.deepEqual(detail.candidates[0].conventions, ['napplet:printable-detail/open']);

    const unknown = await frame.evaluate(() => window.napplet.intent.available('mastodon-toot'));
    assert.equal(unknown.available, false);
    assert.deepEqual(unknown.candidates, []);

    // `make-create` has a route but no napplet, so it is not advertised.
    const makeCreate = await frame.evaluate(() => window.napplet.intent.available('make-create'));
    assert.equal(makeCreate.available, false);

    const handlers = await frame.evaluate(() => window.napplet.intent.handlers());
    assert.deepEqual(handlers.map((entry) => entry.archetype).sort(), [
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
      window.napplet.intent.open('napplet:printable-detail/open', {
        payload: { address: '33500:deadbeef:adjustable-phone-stand' },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.handler, catalogId('print-detail'));
    assert.equal(result.convention, 'napplet:printable-detail/open');

    await page.waitForFunction(
      () => window.location.pathname === '/printables/deadbeef/adjustable-phone-stand',
    );
    await page.waitForSelector('iframe[title="Print details napplet"]');

    // The delivery's sender is attested by the shell from the caller's manifest.
    assert.deepEqual(await recordedIntent(page, 'printable-detail'), {
      action: 'open',
      sender: catalogId('print-search'),
    });
  } finally {
    await page.close();
  }
});

test('NAP-INTENT carries a non-open verb through navigation', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const result = await frame.evaluate(() =>
      window.napplet.intent.invoke('napplet:part-upload/create'),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');

    await page.waitForFunction(() => window.location.pathname === '/parts/upload');
    await page.waitForSelector('iframe[title="Upload parts napplet"]');
    assert.deepEqual(await recordedIntent(page, 'part-upload'), {
      action: 'create',
      sender: catalogId('print-search'),
    });
  } finally {
    await page.close();
  }
});

test('NAP-INTENT delivers a create intent with its remix payload to print-create', async () => {
  const { page, frame } = await openBrowseNapplet();
  const remixOf = `33500:${'a'.repeat(64)}:phone-stand`;

  try {
    const result = await frame.evaluate(
      (address) =>
        window.napplet.intent.invoke('napplet:printable-create/create', {
          payload: { remixOf: address },
        }),
      remixOf,
    );
    assert.equal(result.ok, true);

    await page.waitForFunction(() => window.location.pathname === '/create');
    assert.deepEqual(await recordedIntent(page, 'printable-create'), {
      action: 'create',
      sender: catalogId('print-search'),
    });

    const handle = await page.waitForSelector('iframe[title="Create print napplet"]');
    const create = await handle.contentFrame();
    // Rendered only once the napplet received the delivery through intent.onDelivery.
    await create.waitForSelector('[data-testid="remix-of"]', { timeout: 15_000 });
  } finally {
    await page.close();
  }
});

test('NAP-INTENT honours default and exact handler preferences', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const wrongHandler = await frame.evaluate(() =>
      window.napplet.intent.open('napplet:profile/open', {
        payload: { pubkey: 'deadbeef' },
        handler: 'nip5d:35129:0000000000000000000000000000000000000000000000000000000000000000:x',
      }),
    );
    assert.equal(wrongHandler.ok, false);
    assert.equal(wrongHandler.error, 'invoke rejected');
    assert.equal(new URL(page.url()).pathname, '/search');

    const exact = await frame.evaluate(
      (handler) =>
        window.napplet.intent.open('napplet:profile/open', {
          payload: { pubkey: 'deadbeef' },
          handler,
        }),
      catalogId('user-profile'),
    );
    assert.equal(exact.ok, true);
    assert.equal(exact.handler, catalogId('user-profile'));
    await page.waitForFunction(() => window.location.pathname === '/profiles/deadbeef');
  } finally {
    await page.close();
  }
});

test('NAP-INTENT rejects a request it cannot route', async () => {
  const { page, frame } = await openBrowseNapplet();

  try {
    const noPayload = await frame.evaluate(() =>
      window.napplet.intent.open('napplet:printable-detail/open', { payload: {} }),
    );
    assert.equal(noPayload.ok, false);
    assert.equal(noPayload.error, 'invoke rejected');

    const badFileId = await frame.evaluate(() =>
      window.napplet.intent.open('napplet:part-detail/open', { payload: { fileId: 'nope' } }),
    );
    assert.equal(badFileId.ok, false);
    assert.equal(badFileId.error, 'invoke rejected');

    const unknown = await frame.evaluate(() =>
      window.napplet.intent.open('napplet:mastodon-toot/open'),
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'no handler');

    const unsupported = await frame.evaluate(() =>
      window.napplet.intent.invoke('napplet:profile/edit', { payload: { pubkey: 'deadbeef' } }),
    );
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, 'unsupported convention');

    // A failed intent must not move the shell off the search route.
    assert.equal(new URL(page.url()).pathname, '/search');
  } finally {
    await page.close();
  }
});
