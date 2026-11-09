import assert from 'node:assert/strict';
import { test } from 'node:test';
import puppeteer from 'puppeteer';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { seedTestRelay } from '../../scripts/lib/test-relay.mjs';

const baseUrl = process.env.STLSTR_TEST_BASE_URL || 'http://127.0.0.1:5174';
const relayUrl = process.env.STLSTR_TEST_RELAY_URL || 'ws://localhost:4869';

test('napplet choices sync between accounts on separate devices and reset on relays', async () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const pointer = { kind: 35129, pubkey, identifier: 'test-handler', relays: [relayUrl] };
  const override = {
    naddr: nip19.naddrEncode(pointer),
    pubkey,
    identifier: pointer.identifier,
    dTag: pointer.identifier,
    title: 'Test handler',
    relays: [relayUrl],
  };
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const pages = [];
  let refuseSigning = false;
  try {
    await seedTestRelay({
      relayUrl,
      events: [
        finalizeEvent(
          {
            kind: 35129,
            content: 'Test printable creation handler.',
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['d', pointer.identifier],
              ['z', 'printable-create'],
              ['title', 'Test handler'],
              ['x', 'a'.repeat(64)],
              ['url', `${baseUrl}/unused-test-artifact.html`],
            ],
          },
          secret,
        ),
      ],
    });
    for (let i = 0; i < 2; i++) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.exposeFunction('signPreference', (draft) => {
        if (refuseSigning) throw new Error('Signing declined');
        return finalizeEvent(draft, secret);
      });
      await page.evaluateOnNewDocument((key) => {
        window.nostr = {
          getPublicKey: async () => key,
          signEvent: (draft) => window.signPreference(draft),
        };
      }, pubkey);
      await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle0' });
      await page.evaluate(async () => {
        window.preferences = await import('/src/services/napplet-preferences.ts');
        window.accounts = await import('/src/services/accounts.ts');
        await window.accounts.loginWithExtension();
      });
      await page.waitForFunction(
        () =>
          window.preferences.getNappletPreferences().pubkey &&
          !window.preferences.getNappletPreferences().loading,
      );
      pages.push(page);
    }
    const [first, second] = pages;
    await first.evaluate(
      (value) => window.preferences.setNappletOverride('printable-create', value),
      override,
    );
    await second.waitForFunction(
      () =>
        window.preferences.getNappletPreferences().handlers['printable-create']?.publicEntries
          .intents.size === 2,
    );
    assert.equal(
      await second.evaluate(async (address) => {
        const { resolveNappletNaddr } = await import('/src/services/napplets.ts');
        return (await resolveNappletNaddr(address, 'printable-create')).title;
      }, override.naddr),
      'Test handler',
    );
    await second.waitForFunction(
      () =>
        window.preferences.preferredNapplet('printable-create', 'create')?.title === 'Test handler',
    );
    assert.equal(
      await second.evaluate(
        () =>
          window.preferences
            .getNappletPreferences()
            .handlers['printable-create'].candidates('create')[0].ref.pointer.identifier,
      ),
      pointer.identifier,
    );

    // An external device adds an unrelated intent. Editing the page must preserve it.
    const current = await second.evaluate(
      () => window.preferences.getNappletPreferences().handlers['printable-create'].event,
    );
    const external = finalizeEvent(
      {
        kind: current.kind,
        content: '',
        created_at: current.created_at + 1,
        tags: [
          ...current.tags,
          ['i', 'napplet:printable-create/external', `35129:${pubkey}:external`],
        ],
      },
      secret,
    );
    await seedTestRelay({ relayUrl, events: [external] });
    await first.waitForFunction(
      (id) =>
        window.preferences.getNappletPreferences().handlers['printable-create']?.event.id === id,
      {},
      external.id,
    );
    await first.evaluate(
      (value) => window.preferences.setNappletOverride('printable-create', value),
      override,
    );
    await second.waitForFunction(
      (timestamp) =>
        window.preferences.getNappletPreferences().handlers['printable-create']?.event.created_at >
        timestamp,
      {},
      external.created_at,
    );
    assert.equal(
      await second.evaluate(() =>
        window.preferences
          .getNappletPreferences()
          .handlers['printable-create'].publicEntries.intents.has(
            'napplet:printable-create/external',
          ),
      ),
      true,
    );

    await first.evaluate(() => window.preferences.removeNappletOverride('printable-create'));
    await second.waitForFunction(
      () =>
        window.preferences.getNappletPreferences().handlers['printable-create']?.publicEntries
          .intents.size === 0,
    );
    refuseSigning = true;
    await assert.rejects(
      first.evaluate(
        (value) => window.preferences.setNappletOverride('printable-create', value),
        override,
      ),
      /Signing declined/,
    );
    assert.equal(
      await first.evaluate(() => window.preferences.getNappletPreferences().saving),
      false,
    );
    assert.equal(
      await first.evaluate(
        () =>
          window.preferences.getNappletPreferences().handlers['printable-create'].publicEntries
            .intents.size,
      ),
      0,
    );
    await second.evaluate(async (otherPubkey) => {
      window.nostr.getPublicKey = async () => otherPubkey;
      await window.accounts.loginWithExtension();
    }, getPublicKey(generateSecretKey()));
    assert.equal(
      await second.evaluate(
        () => Object.keys(window.preferences.getNappletPreferences().handlers).length,
      ),
      0,
    );
    await second.evaluate(() => window.accounts.accountManager.clearActive());
    await second.waitForFunction(() => !window.preferences.getNappletPreferences().pubkey);
    assert.equal(
      await second.evaluate(
        () => Object.keys(window.preferences.getNappletPreferences().handlers).length,
      ),
      0,
    );
  } finally {
    await browser.close();
  }
});
