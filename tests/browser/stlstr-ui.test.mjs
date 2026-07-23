import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';

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

async function openStlstr(viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  return page;
}

async function counterFrame(page) {
  const iframeHandle = await page.waitForSelector('iframe[title="Counter napplet"]');
  const frame = await iframeHandle.contentFrame();
  assert.ok(frame, 'counter iframe should be available');
  await frame.waitForSelector('#counter-title');
  return frame;
}

test('stlstr loads the counter napplet in the real Vite app', async () => {
  const page = await openStlstr();

  try {
    assert.equal(await page.title(), 'stlstr');
    assert.match(
      await page
        .locator('body')
        .map((body) => body.innerText)
        .wait(),
      /Kehto host dev mode/,
    );

    const frame = await counterFrame(page);
    assert.equal(await frame.$eval('#counter-title', (node) => node.textContent), 'Counter');
    assert.equal(await frame.$eval('.count', (node) => node.textContent?.trim()), '0');

    await frame.waitForFunction(() => !document.querySelector('button.primary')?.disabled);
    await frame.click('button.primary');
    await frame.waitForFunction(
      () => document.querySelector('.count')?.textContent?.trim() === '1',
    );
    assert.match(
      await frame.$eval('.status', (node) => node.textContent ?? ''),
      /Saved with NAP-STORAGE/,
    );
  } finally {
    await page.close();
  }
});

test('stlstr and napplet render at mobile viewport size', async () => {
  const page = await openStlstr({ width: 390, height: 844 });

  try {
    const frame = await counterFrame(page);
    const hostWidth = await page.$eval('main', (node) => node.getBoundingClientRect().width);
    const nappletWidth = await frame.$eval('.card', (node) => node.getBoundingClientRect().width);

    assert.ok(hostWidth <= 390, `host should fit mobile viewport, got ${hostWidth}px`);
    assert.ok(nappletWidth <= 390, `napplet should fit mobile viewport, got ${nappletWidth}px`);
  } finally {
    await page.close();
  }
});
