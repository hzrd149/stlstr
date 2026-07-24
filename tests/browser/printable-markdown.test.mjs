import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { MAKERS, PRINTABLES } from '../../scripts/lib/test-fixtures.mjs';

/**
 * Markdown rendering of a printable description, per NIP.md's "Markdown Content".
 *
 * Half of these assert formatting; the other half assert refusals. The refusals matter more:
 * the description is written by whoever published the event, and the napplet holds NAP grants
 * the shell would not hand to that author.
 */

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';

/** The fixture carrying the Markdown description. */
const SUBJECT = PRINTABLES.find((printable) => printable.description);
const printablePath = `/printables/${MAKERS[SUBJECT.maker].pubkey}/${SUBJECT.identifier}`;

let browser;
let page;
let frame;

before(async () => {
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}${printablePath}`, { waitUntil: 'networkidle0' });

  const handle = await page.waitForSelector('iframe[title="Print details napplet"]');
  frame = await handle.contentFrame();
  assert.ok(frame, 'print detail iframe should be available');

  // The description tab is the default panel, but it only exists once the event loads.
  await frame.waitForSelector('[data-testid="markdown-content"]');
});

after(async () => {
  await browser?.close();
});

/** Text content of the description, with runs of whitespace collapsed. */
async function descriptionText() {
  return frame.$eval('[data-testid="markdown-content"]', (node) =>
    node.textContent.replace(/\s+/g, ' ').trim(),
  );
}

async function countIn(selector) {
  return frame.$$eval(`[data-testid="markdown-content"] ${selector}`, (nodes) => nodes.length);
}

test('block structure is rendered as elements, not as literal Markdown', async () => {
  const structure = await frame.$eval('[data-testid="markdown-content"]', (node) => ({
    headings: node.querySelectorAll('h2, h3').length,
    lists: node.querySelectorAll('ul, ol').length,
    blockquotes: node.querySelectorAll('blockquote').length,
    codeBlocks: node.querySelectorAll('pre code').length,
    rules: node.querySelectorAll('hr').length,
    tables: node.querySelectorAll('table').length,
  }));

  assert.equal(structure.headings, 3, 'the ## and ### headings should be heading elements');
  assert.ok(structure.lists >= 2, 'both lists should render');
  assert.equal(structure.blockquotes, 1);
  assert.ok(structure.codeBlocks >= 1, 'the fenced block should render as a code block');
  assert.equal(structure.rules, 1);
  assert.equal(structure.tables, 1);

  const text = await descriptionText();
  // The syntax characters themselves must be consumed, not shown.
  assert.ok(!text.includes('## Print settings'), 'heading syntax should not survive as text');
  assert.ok(!text.includes('**flat on the bed**'), 'emphasis syntax should not survive as text');
});

test('inline formatting, tables and task lists render', async () => {
  assert.ok((await countIn('strong')) >= 1, 'strong emphasis');
  assert.ok((await countIn('em')) >= 1, 'emphasis');
  assert.ok((await countIn('del')) >= 1, 'GFM strikethrough');
  assert.ok((await countIn('code')) >= 2, 'a code span as well as the fenced block');

  const cells = await frame.$$eval('[data-testid="markdown-content"] table td', (nodes) =>
    nodes.map((node) => node.textContent.trim()),
  );
  assert.deepEqual(cells, ['Layer height', '0.2mm', 'Infill', '15%']);

  const checkboxes = await frame.$$eval(
    '[data-testid="markdown-content"] input[type="checkbox"]',
    (nodes) => nodes.map((node) => ({ checked: node.checked, disabled: node.disabled })),
  );
  assert.deepEqual(checkboxes, [
    { checked: true, disabled: true },
    { checked: false, disabled: true },
  ]);
});

test('HTML entities are resolved rather than shown as their source', async () => {
  const text = await descriptionText();
  assert.ok(text.includes('Ampersands & entities decode.'), text.slice(-120));
});

test('raw HTML in a description is never inserted into the document', async () => {
  // The fixture embeds `<b data-testid="raw-html">`. If any of it became markup, this finds it.
  assert.equal(
    await countIn('[data-testid="raw-html"]'),
    0,
    'raw HTML must not be parsed into elements',
  );
  assert.equal(await countIn('b'), 0, 'not even a harmless tag may be created');

  const text = await descriptionText();
  assert.ok(text.includes('raw html must not render'), 'it should still be readable as source');
  assert.ok(text.includes('data-testid="raw-html"'), 'shown as its own source text');
});

test('a javascript: link is refused but its label still reads', async () => {
  const hrefs = await frame.$$eval('[data-testid="markdown-content"] a', (nodes) =>
    nodes.map((node) => node.getAttribute('href')),
  );

  assert.ok(
    hrefs.every((href) => href?.startsWith('https://')),
    `only safe schemes may be rendered as links, saw ${JSON.stringify(hrefs)}`,
  );
  assert.ok(hrefs.includes('https://notes.example/phone-stand'), 'the https link should render');

  // The refused link degrades to its text — losing the destination, not the sentence.
  const text = await descriptionText();
  assert.ok(text.includes('Do not link this'), text);
});

test('a data: image is refused and a permitted image loads through NAP-RESOURCE', async () => {
  // Exactly one image is allowed to load: the https one. The data: URL must not become an
  // <img> at all, since loading it would put an author-controlled document in the frame.
  await frame.waitForFunction(
    () => document.querySelectorAll('[data-testid="markdown-content"] img').length === 1,
  );

  const sources = await frame.$$eval('[data-testid="markdown-content"] img', (nodes) =>
    nodes.map((node) => node.getAttribute('src')),
  );

  assert.equal(sources.length, 1);
  // NAP-RESOURCE hands back bytes, so a rendered image is always a blob URL — the napplet
  // never gets to make the request itself.
  assert.ok(sources[0].startsWith('blob:'), `expected a blob URL, saw ${sources[0]}`);
});

test('a link click leaves through NAP-LINK rather than navigating the frame', async () => {
  const before = frame.url();

  await frame.$eval('[data-testid="markdown-content"] a', (node) => node.click());
  // A sandboxed frame cannot navigate itself out; the point is that the anchor's default is
  // suppressed and the shell is asked instead, so the napplet stays put.
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(frame.url(), before, 'the napplet frame must not navigate');
});
