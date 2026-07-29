import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';
/** The fixture relay the harness pinned this run to, which settings must report verbatim. */
const relayUrl = process.env.STLSTR_TEST_RELAY_URL || 'ws://localhost:4869';

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

async function openStlstr(path = '/', viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle0' });
  return page;
}

async function nappletFrame(page, title) {
  const iframeHandle = await page.waitForSelector(`iframe[title="${title} napplet"]`);
  const frame = await iframeHandle.contentFrame();
  assert.ok(frame, `${title} iframe should be available`);
  return frame;
}

test('stlstr loads discovery as the home route', async () => {
  const page = await openStlstr('/');

  try {
    assert.equal(await page.title(), 'STLstr');
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main > h1'), null);
    assert.equal(
      await page.$eval(
        'label[aria-label="Open navigation"]',
        (node) => node.getBoundingClientRect().width,
      ),
      0,
    );
    assert.equal(
      await page.$eval('.drawer-side', (node) => window.getComputedStyle(node).display),
      'none',
    );

    const frame = await nappletFrame(page, 'Discover prints');
    await frame.waitForSelector('[data-testid="discover-home"]');
    assert.ok(await frame.$('input[placeholder^="Search phone stands, gridfinity"]'));
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes create to the printable-create napplet', async () => {
  const page = await openStlstr('/create');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Create print');
    await frame.waitForSelector('#printable-title');
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes printable details to a dedicated napplet', async () => {
  const page = await openStlstr('/printables/testpubkey/test-printable');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Print details');
    // This address names no fixture printable, so the napplet reports that rather than
    // rendering one — which is still the napplet owning the page, not the shell.
    // Wait for the settled message: `printable-status` also carries "Loading print...".
    await frame.waitForFunction(() =>
      document
        .querySelector('[data-testid="printable-status"]')
        ?.textContent?.includes('not been published'),
    );
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes printable edits to a dedicated napplet', async () => {
  const page = await openStlstr('/printables/testpubkey/test-printable/edit');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Edit print');
    // No such printable exists, so the napplet says so rather than opening an editor.
    await frame.waitForFunction(() =>
      document
        .querySelector('[data-testid="edit-status"]')
        ?.textContent?.includes('not been published'),
    );
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr renders settings in the shell and saves changes', async () => {
  const page = await openStlstr('/settings');

  try {
    await page.waitForSelector('main [role="tablist"]');
    assert.match(await page.$eval('main', (node) => node.textContent ?? ''), /Appearance/);
    assert.equal(await page.$('iframe'), null);

    // Theme choices apply immediately and persist.
    await page.click('button[aria-label="Dark"]');
    assert.equal(await page.$eval('html', (node) => node.getAttribute('data-theme')), 'abyss');

    await page.click('button[role="tab"]:nth-child(2)');

    // Local builds pin relays only; media servers remain editable.
    const settingsText = await page.$eval('main', (node) => node.textContent ?? '');
    assert.match(settingsText, /local development build/i);
    assert.ok(settingsText.includes(relayUrl), `settings should list ${relayUrl}`);
    assert.equal(await page.$('input[aria-label="Add an app relay"]'), null);
    assert.notEqual(await page.$('input[aria-label="Add a media server"]'), null);

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('main [role="tablist"]');
    assert.equal(await page.$eval('html', (node) => node.getAttribute('data-theme')), 'abyss');
  } finally {
    // Settings live in localStorage, which is shared with the other tests.
    await page.evaluate(() => localStorage.removeItem('stlstr.settings.v1')).catch(() => {});
    await page.close();
  }
});

test('stlstr shell and active napplet fit mobile viewport', async () => {
  const page = await openStlstr('/', { width: 390, height: 844 });

  try {
    const frame = await nappletFrame(page, 'Discover prints');
    await frame.waitForSelector('[data-testid="discover-home"]');
    assert.notEqual(
      await page.$eval(
        'label[aria-label="Open navigation"]',
        (node) => node.getBoundingClientRect().width,
      ),
      0,
    );
    const hostWidth = await page.$eval('main', (node) => node.getBoundingClientRect().width);
    const nappletWidth = await frame.$eval('main', (node) => node.getBoundingClientRect().width);

    assert.ok(hostWidth <= 390, `host should fit mobile viewport, got ${hostWidth}px`);
    assert.ok(nappletWidth <= 390, `napplet should fit mobile viewport, got ${nappletWidth}px`);
  } finally {
    await page.close();
  }
});
