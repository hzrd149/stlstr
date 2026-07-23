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

test('stlstr loads browse as the home route', async () => {
  const page = await openStlstr('/');

  try {
    assert.equal(await page.title(), 'stlstr');
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Browse objects');
    assert.ok(await frame.$('input[placeholder="Search phone stands, minis, brackets..."]'));
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes create to the create-object napplet', async () => {
  const page = await openStlstr('/create');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Create object');
    await frame.waitForSelector('#object-title');
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes object details to a dedicated napplet', async () => {
  const page = await openStlstr('/objects/testpubkey/test-object');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Object details');
    assert.match(await frame.$eval('main', (node) => node.textContent ?? ''), /Object metadata/);
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr routes object edits to a dedicated napplet', async () => {
  const page = await openStlstr('/objects/testpubkey/test-object/edit');

  try {
    assert.equal(await page.$('main > .card'), null);
    assert.equal(await page.$('main h1'), null);

    const frame = await nappletFrame(page, 'Edit object');
    assert.match(await frame.$eval('main', (node) => node.textContent ?? ''), /ownership checks/);
    assert.equal(await frame.$('h1'), null);
    assert.equal(await frame.$('.card'), null);
  } finally {
    await page.close();
  }
});

test('stlstr shell and active napplet fit mobile viewport', async () => {
  const page = await openStlstr('/', { width: 390, height: 844 });

  try {
    const frame = await nappletFrame(page, 'Browse objects');
    const hostWidth = await page.$eval('main', (node) => node.getBoundingClientRect().width);
    const nappletWidth = await frame.$eval('main', (node) => node.getBoundingClientRect().width);

    assert.ok(hostWidth <= 390, `host should fit mobile viewport, got ${hostWidth}px`);
    assert.ok(nappletWidth <= 390, `napplet should fit mobile viewport, got ${nappletWidth}px`);
  } finally {
    await page.close();
  }
});
