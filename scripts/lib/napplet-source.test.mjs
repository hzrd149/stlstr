import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Napplets must never reach a Nostr signer directly.
 *
 * The shell seals `window.nostr` inside every napplet frame at runtime
 * (`apps/stlstr/src/services/sandbox.ts`), but that guard is a backstop for a browser
 * extension injecting into the frame. This test is the other half: it catches a napplet
 * that *tries*, at the point the code is written rather than the moment it runs.
 *
 * Identity comes from NAP-IDENTITY; publishing goes through NAP-OUTBOX, where the shell
 * holds the signer and applies policy.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nappletsDir = join(root, 'napplets');

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.svelte', '.html', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);

/**
 * Ways a napplet could reach a signer outside the NAP boundary. `window.nostr` is the
 * NIP-07 global; `nostr-tools` signing helpers would mean the napplet holds a key itself.
 */
const FORBIDDEN = [
  { pattern: /\bwindow\s*\.\s*nostr\b/, why: 'window.nostr (NIP-07) — use NAP-IDENTITY' },
  { pattern: /\bglobalThis\s*\.\s*nostr\b/, why: 'globalThis.nostr — use NAP-IDENTITY' },
  { pattern: /\bnostr-tools\b/, why: 'nostr-tools — the shell owns signing, via NAP-OUTBOX' },
  { pattern: /\bfinalizeEvent\b|\bgetPublicKey\s*\(\s*sk/, why: 'local signing' },
];

function sourceFiles(dir) {
  const found = [];

  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;

    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry))) found.push(path);
  }

  return found;
}

function napplets() {
  return readdirSync(nappletsDir).filter((entry) =>
    statSync(join(nappletsDir, entry)).isDirectory(),
  );
}

test('no napplet reaches a Nostr signer directly', () => {
  const violations = [];

  for (const napplet of napplets()) {
    for (const file of sourceFiles(join(nappletsDir, napplet))) {
      const contents = readFileSync(file, 'utf8');

      for (const { pattern, why } of FORBIDDEN) {
        if (!pattern.test(contents)) continue;
        violations.push(`${file.slice(root.length + 1)}: ${why}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `napplets must not access a signer directly:\n${violations.join('\n')}`,
  );
});

test('every napplet declares the NAP domains it uses', () => {
  // A domain used but not declared in `requires` is injected by nothing and fails silently
  // at runtime, which is far harder to diagnose than a failing test here.
  const tracked = ['identity', 'outbox', 'resource', 'intent', 'inc', 'upload', 'link', 'storage'];
  const violations = [];

  for (const napplet of napplets()) {
    const config = join(nappletsDir, napplet, 'vite.config.ts');
    let manifest;
    try {
      manifest = readFileSync(config, 'utf8');
    } catch {
      continue;
    }

    const requires = /requires:\s*\[([^\]]*)\]/.exec(manifest)?.[1] ?? '';
    const declared = new Set([...requires.matchAll(/'([^']+)'/g)].map((match) => match[1]));

    const code = sourceFiles(join(nappletsDir, napplet, 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    // What the napplet imports from the SDK, not what its identifiers are named — a local
    // called `resource` is not a use of NAP-RESOURCE.
    const imported = new Set();
    for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@napplet\/sdk'/g)) {
      for (const name of match[1].split(',')) {
        const bare = name
          .replace(/\btype\b/, '')
          .split(/\s+as\s+/)[0]
          .trim();
        if (bare) imported.add(bare);
      }
    }

    for (const domain of tracked) {
      if (imported.has(domain) && !declared.has(domain)) {
        violations.push(`napplets/${napplet}: imports ${domain} but does not require it`);
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'));
});
