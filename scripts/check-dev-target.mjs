#!/usr/bin/env node
/**
 * Preflight for local napplet deploys.
 *
 * `pnpm napplet:deploy` signs with the user's real key. The only thing standing between a
 * local test publish and a permanent public one is which config file the CLI reads,
 * so this asserts the dev config cannot reach off-machine before the key is touched.
 *
 * Relays are append-only and Blossom blobs are content-addressed: a mistake here is
 * not revocable, which is why this fails closed on anything it does not recognise as
 * loopback rather than warning and continuing.
 */

import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

const CONFIG_PATH = process.argv[2] ?? '.napplet/config.dev.json';

/** Hosts that cannot leave this machine. */
function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  // 127.0.0.0/8 — the whole block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Every URL a deploy could contact, paired with where it came from. */
function targetsOf(config) {
  return [
    ...(config.relays ?? []).map((url) => ['relays', url]),
    ...(config.blossomServers ?? []).map((url) => ['blossomServers', url]),
    // Bunker relays are contacted during signing, so a remote one leaks the request
    // even when nothing is published off-machine.
    ...(config.signing?.relays ?? []).map((url) => ['signing.relays', url]),
  ];
}

/** Resolves to true if something is listening, without speaking any protocol. */
function isListening(url) {
  const { hostname, port, protocol } = new URL(url);
  const resolvedPort = port || (protocol === 'https:' || protocol === 'wss:' ? 443 : 80);

  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(resolvedPort) });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => null);
if (raw === null) {
  console.error(`[deploy] no config at ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(raw);
const targets = targetsOf(config);

if (targets.length === 0) {
  console.error(`[deploy] ${CONFIG_PATH} names no relays or Blossom servers`);
  process.exit(1);
}

const offMachine = targets.filter(([, url]) => {
  try {
    return !isLoopback(new URL(url).hostname);
  } catch {
    // An unparseable URL is not demonstrably local, so it fails the check.
    return true;
  }
});

if (offMachine.length > 0) {
  console.error(`[deploy] ${CONFIG_PATH} targets hosts outside this machine:\n`);
  for (const [field, url] of offMachine) console.error(`  ${field}: ${url}`);
  console.error('\nRefusing to deploy. Local deploys must stay on loopback.');
  console.error('To publish publicly on purpose, use `pnpm napplet:deploy:prod`.');
  process.exit(1);
}

// Everything is local; now check it is actually up, so a missing relay reports itself
// rather than surfacing as a partial deploy.
const down = [];
for (const [field, url] of targets) {
  if (!(await isListening(url))) down.push([field, url]);
}

if (down.length > 0) {
  console.error('[deploy] nothing is listening on:\n');
  for (const [field, url] of down) console.error(`  ${field}: ${url}`);
  console.error('\nStart the local relay and Blossom server, then retry.');
  process.exit(1);
}

console.log(`[deploy] ${CONFIG_PATH}: ${targets.length} targets, all loopback and reachable`);
