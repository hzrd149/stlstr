import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { MAKERS, OBJECTS } from '../../scripts/lib/test-fixtures.mjs';

/**
 * The object detail page: images arrive through NAP-RESOURCE, and the owner-only edit
 * action is gated on NAP-IDENTITY.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

const SUBJECT = OBJECTS[OBJECTS.length - 1];
const OWNER = MAKERS[SUBJECT.maker];
/** A maker who exists but did not publish the object under test. */
const STRANGER = Object.values(MAKERS).find((maker) => maker.pubkey !== OWNER.pubkey);

const objectPath = `/objects/${OWNER.pubkey}/${SUBJECT.identifier}`;

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
 * Installs a fake NIP-07 provider before any page script runs, so the shell's "Browser
 * extension" login has something to talk to. Only `getPublicKey` matters here: NAP-IDENTITY
 * is read-only, so the owner gate never needs a signature.
 */
async function withExtension(page, pubkey) {
  await page.evaluateOnNewDocument((key) => {
    window.nostr = {
      getPublicKey: async () => key,
      signEvent: async (event) => ({ ...event, pubkey: key, id: '', sig: '' }),
      getRelays: async () => ({}),
    };
  }, pubkey);
}

/**
 * A page in its own browser context. Accounts persist to localStorage, so tests that sign
 * in must not share an origin — otherwise one test's account leaks into the next and the
 * shell never offers a Login button again.
 */
async function freshPage() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  return { page, close: () => context.close() };
}

async function openObject(page) {
  await page.goto(`${baseUrl}${objectPath}`, { waitUntil: 'networkidle0' });
  const handle = await page.waitForSelector('iframe[title="Object details napplet"]');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'object detail iframe should be available');
  await frame.waitForSelector('[data-testid="object-title"]');
  return frame;
}

/** Clicks the one button whose visible label is exactly `label`. */
async function clickLabelled(page, selector, label) {
  for (const button of await page.$$(selector)) {
    if ((await button.evaluate((node) => node.textContent?.trim())) === label) {
      await button.click();
      return true;
    }
  }
  return false;
}

/**
 * Signs in through the shell's real login flow, backed by the fake NIP-07 provider.
 *
 * Completion is detected by the "Login" button being replaced with the account button —
 * not by any class, because `.btn-primary.btn-sm` still matches the "Use" button inside the
 * accounts dialog once an account exists.
 */
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

test('the object page renders its title and gallery image', async () => {
  const { page, close } = await freshPage();

  try {
    const frame = await openObject(page);

    assert.equal(
      await frame.$eval('[data-testid="object-title"]', (node) => node.textContent?.trim()),
      SUBJECT.title,
    );

    const image = await frame.waitForSelector('section[aria-label="Object gallery"] img');
    // A blob: URL is the proof it came through resource.bytes, not a bare <img src>.
    assert.match(await image.evaluate((node) => node.src), /^blob:/);
    assert.ok(await image.evaluate((node) => node.naturalWidth > 0), 'the cover should decode');
  } finally {
    await close();
  }
});

test('the edit action stays hidden when nobody is signed in', async () => {
  const { page, close } = await freshPage();

  try {
    const frame = await openObject(page);

    // The gallery having loaded means the page is settled, so an absent button is a
    // decision rather than a race.
    await frame.waitForSelector('section[aria-label="Object gallery"] img');
    assert.equal(await frame.$('[data-testid="edit-object"]'), null);
  } finally {
    await close();
  }
});

test('the edit action stays hidden for a signed-in non-owner', async () => {
  const { page, close } = await freshPage();
  await withExtension(page, STRANGER.pubkey);

  try {
    const frame = await openObject(page);
    await signIn(page);

    // The gallery having loaded means the page is settled, so an absent button is a
    // decision rather than a race.
    await frame.waitForSelector('section[aria-label="Object gallery"] img');
    assert.equal(await frame.$('[data-testid="edit-object"]'), null);
  } finally {
    await close();
  }
});

test('the owner sees the edit action and it opens the editor', async () => {
  const { page, close } = await freshPage();
  await withExtension(page, OWNER.pubkey);

  try {
    const frame = await openObject(page);
    await signIn(page);

    const edit = await frame.waitForSelector('[data-testid="edit-object"]');
    await edit.click();

    await page.waitForFunction(
      (expected) => window.location.pathname === expected,
      {},
      `${objectPath}/edit`,
    );
    await page.waitForSelector('iframe[title="Edit object napplet"]');
  } finally {
    await close();
  }
});
