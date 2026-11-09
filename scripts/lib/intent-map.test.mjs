import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARCHETYPES,
  baseHref,
  hasPreview,
  intentFromLocation,
  intentToHref,
  isAdvertised,
  overlayFromLocation,
  previewHref,
  withNavigationState,
} from '../../apps/stlstr/src/services/intent-map.ts';

const pubkey = 'a'.repeat(64);
const eventId = 'b'.repeat(64);
const address = `33500:${pubkey}:phone-stand`;

/** One representative intent per routable archetype, in the action its route parses to. */
const samples = [
  { archetype: 'printable-discovery', action: 'open', payload: {} },
  { archetype: 'printable-search', action: 'open', payload: {} },
  { archetype: 'printable-search', action: 'open', payload: { query: 'phone stand' } },
  { archetype: 'printable-search', action: 'open', payload: { tag: 'tools' } },
  { archetype: 'printable-create', action: 'open', payload: {} },
  { archetype: 'printable-create', action: 'open', payload: { remixOf: address } },
  { archetype: 'profile', action: 'open', payload: { pubkey } },
  { archetype: 'printable-detail', action: 'open', payload: { address } },
  { archetype: 'printable-edit', action: 'edit', payload: { address } },
  { archetype: 'make-create', action: 'open', payload: { address } },
  { archetype: 'make-detail', action: 'open', payload: { eventId } },
  { archetype: 'part-detail', action: 'open', payload: { fileId: eventId } },
  { archetype: 'part-library', action: 'open', payload: {} },
  { archetype: 'part-upload', action: 'open', payload: {} },
];

function locationOf(href) {
  const url = new URL(href, 'http://shell.invalid');
  return { pathname: url.pathname, search: url.search };
}

test('every route intent survives an href round-trip unchanged', () => {
  for (const intent of samples) {
    const href = intentToHref(intent);
    assert.ok(href, `${intent.archetype} should address a page`);
    assert.deepEqual(intentFromLocation(locationOf(href)), intent, href);
  }
});

test('every page archetype has a round-trip sample', () => {
  const covered = new Set(samples.map((intent) => intent.archetype));
  const pages = Object.keys(ARCHETYPES).filter((archetype) => archetype !== 'stl-preview');
  assert.deepEqual(
    pages.filter((archetype) => !covered.has(archetype)),
    [],
  );
});

test('malformed ids do not parse to a page', () => {
  assert.equal(intentFromLocation({ pathname: '/part/not-hex', search: '' }), null);
  assert.equal(intentFromLocation({ pathname: '/makes/123', search: '' }), null);
  assert.equal(intentToHref({ archetype: 'part-detail', action: 'open', payload: {} }), null);
  assert.equal(
    intentToHref({ archetype: 'profile', action: 'edit', payload: { pubkey } }),
    null,
    'an unsupported action has no href',
  );
});

test('a preview overlay round-trips over its base page', () => {
  const payload = { url: 'https://example.com/a.stl', name: 'a.stl', size: '12' };
  const href = previewHref('/search?q=stand', payload);
  assert.ok(href && hasPreview(href));

  const location = locationOf(href);
  assert.deepEqual(overlayFromLocation(location), {
    archetype: 'stl-preview',
    action: 'open',
    payload,
  });
  assert.deepEqual(intentFromLocation(location), {
    archetype: 'printable-search',
    action: 'open',
    payload: { query: 'stand' },
  });
  assert.equal(baseHref(href), '/search?q=stand');
  assert.equal(previewHref('/', { name: 'no url' }), null);
});

test('history state supplies the verb and sender, but only for accepted actions', () => {
  const route = { archetype: 'printable-create', action: 'open', payload: {} };

  assert.deepEqual(withNavigationState(route, null), { ...route, sender: 'shell' });
  assert.deepEqual(
    withNavigationState(route, {
      intents: { 'printable-create': { action: 'create', sender: 'nip5d:35129:x:y' } },
    }),
    { ...route, action: 'create', sender: 'nip5d:35129:x:y' },
  );
  // An action the archetype does not accept, or an entry for another archetype, is ignored.
  assert.deepEqual(
    withNavigationState(route, {
      intents: { 'printable-create': { action: 'delete', sender: 'nip5d:35129:x:y' } },
    }),
    { ...route, sender: 'shell' },
  );
  assert.deepEqual(
    withNavigationState(route, {
      intents: { profile: { action: 'open', sender: 'nip5d:35129:x:y' } },
    }),
    { ...route, sender: 'shell' },
  );
});

test('archetypes without a published napplet are not advertised', () => {
  assert.equal(isAdvertised('make-create'), false);
  assert.equal(isAdvertised('printable-detail'), true);
  assert.equal(isAdvertised('mastodon-toot'), false);
});
