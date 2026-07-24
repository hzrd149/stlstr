import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { MAKERS, PRINTABLES } from '../../scripts/lib/test-fixtures.mjs';

/**
 * NAP-IDENTITY end to end: a napplet asks the shell who the user is, and the shell answers
 * from the signer and from its own event store. Driven through the real wire protocol from
 * inside a sandboxed iframe.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

const SUBJECT = PRINTABLES[PRINTABLES.length - 1];
const USER = MAKERS[SUBJECT.maker];
/** printable-detail declares `identity`, so its route is granted the domain. */
const printablePath = `/printables/${USER.pubkey}/${SUBJECT.identifier}`;

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

/**
 * A page in its own browser context. Accounts persist to localStorage, so tests that sign
 * in must not share an origin with tests that expect a signed-out shell.
 */
async function freshPage() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  return { page, close: () => context.close() };
}

/** Installs a fake NIP-07 provider before any page script runs. */
async function withExtension(page, pubkey) {
  await page.evaluateOnNewDocument((key) => {
    window.nostr = {
      getPublicKey: async () => key,
      signEvent: async (event) => ({ ...event, pubkey: key, id: '', sig: '' }),
      getRelays: async () => ({}),
    };
  }, pubkey);
}

async function openNapplet(page) {
  await page.goto(`${baseUrl}${printablePath}`, { waitUntil: 'networkidle0' });
  const handle = await page.waitForSelector('iframe[title="Print details napplet"]');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'print detail iframe should be available');
  await frame.waitForFunction(() => Boolean(window.napplet?.identity));
  return frame;
}

async function clickLabelled(page, selector, label) {
  for (const button of await page.$$(selector)) {
    if ((await button.evaluate((node) => node.textContent?.trim())) === label) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function signIn(page) {
  assert.ok(await clickLabelled(page, 'button', 'Login'), 'the shell should offer a Login button');
  assert.ok(
    await clickLabelled(page, 'dialog.modal button', 'Browser extension'),
    'the login dialog should offer browser-extension login',
  );
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((n) => n.textContent?.trim() === 'Login'),
  );
}

test('a signed-out shell reports no identity rather than failing', async () => {
  const { page, close } = await freshPage();

  try {
    const frame = await openNapplet(page);

    const result = await frame.evaluate(async () => ({
      pubkey: await window.napplet.identity.getPublicKey(),
      profile: await window.napplet.identity.getProfile(),
    }));

    // An empty pubkey is the spec's "no signer connected" — napplets must not have to
    // distinguish that from an error.
    assert.equal(result.pubkey, '');
    assert.equal(result.profile, null);
  } finally {
    await close();
  }
});

test('a napplet reads the signed-in pubkey and profile through NAP-IDENTITY', async () => {
  const { page, close } = await freshPage();
  await withExtension(page, USER.pubkey);

  try {
    const frame = await openNapplet(page);
    await signIn(page);

    await frame.waitForFunction(
      async (expected) => (await window.napplet.identity.getPublicKey()) === expected,
      {},
      USER.pubkey,
    );

    // The profile comes from the shell's own event store, not the signer: a NIP-07
    // extension has no getProfile, and the shell has already loaded this kind:0.
    const profile = await frame.evaluate(() => window.napplet.identity.getProfile());
    assert.equal(profile.name, USER.name);
    assert.equal(profile.displayName, USER.name);
  } finally {
    await close();
  }
});

test('identity.onChanged fires when the user signs in', async () => {
  const { page, close } = await freshPage();
  await withExtension(page, USER.pubkey);

  try {
    const frame = await openNapplet(page);

    // Subscribe before logging in; the push is what keeps a napplet from holding the
    // answer it got at mount forever.
    await frame.evaluate(() => {
      window.__identityPushes = [];
      window.napplet.identity.onChanged((pubkey) => window.__identityPushes.push(pubkey));
    });

    await signIn(page);

    await frame.waitForFunction(
      (expected) => window.__identityPushes.includes(expected),
      {},
      USER.pubkey,
    );
  } finally {
    await close();
  }
});

test('a napplet cannot reach window.nostr even when an extension injects it', async () => {
  const { page, close } = await freshPage();
  // The extension injects into every frame, srcdoc frames included — this is exactly the
  // case the shell's seal exists for.
  await withExtension(page, USER.pubkey);

  try {
    const frame = await openNapplet(page);
    await signIn(page);

    const reached = await frame.evaluate(() => {
      const seen = window.nostr;
      let called = 'threw';
      try {
        called = typeof seen?.getPublicKey === 'function' ? 'callable' : 'absent';
      } catch {
        called = 'threw';
      }
      // A napplet must not be able to install its own signer either.
      window.nostr = { getPublicKey: async () => 'attacker' };
      return {
        seen: seen === undefined ? 'undefined' : typeof seen,
        called,
        after: typeof window.nostr,
      };
    });

    assert.equal(reached.seen, 'undefined', 'window.nostr must not be reachable in a napplet');
    assert.equal(reached.called, 'absent');
    assert.equal(reached.after, 'undefined', 'the seal must survive an assignment');

    // The shell itself still uses the extension — the seal is frame-scoped, not global.
    assert.equal(await page.evaluate(() => typeof window.nostr?.getPublicKey), 'function');
  } finally {
    await close();
  }
});
