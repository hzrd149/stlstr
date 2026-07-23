#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.STLSTR_TEST_HOST || '127.0.0.1';
const port = Number(process.env.STLSTR_TEST_PORT || 5174);
const baseUrl = `http://${host}:${port}`;
const registryPath = join(root, 'apps', 'stlstr', 'public', 'napplets.dev.json');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`);
}

async function findChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common browser path.
    }
  }

  return '';
}

function writeRegistry() {
  const registry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    app: {
      packageName: '@apps/stlstr',
      url: baseUrl,
    },
    paja: null,
    napplets: [
      {
        name: 'counter',
        folder: 'napplets/counter',
        packageName: 'counter',
        title: 'counter',
        url: `${baseUrl}/napplets.dev/counter/index.html`,
        dev: {
          mode: 'browser-test',
          dist: join(root, 'napplets', 'counter', 'dist'),
          route: '/napplets.dev/counter/',
        },
      },
    ],
  };

  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function main() {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid STLSTR_TEST_PORT: ${port}`);
  }

  const chromiumPath = await findChromium();
  if (!chromiumPath) {
    throw new Error('No Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH.');
  }

  writeRegistry();

  await run('pnpm', ['--filter', './napplets/counter', 'build']);

  if (!existsSync(join(root, 'napplets', 'counter', 'dist', 'index.html'))) {
    throw new Error('Counter napplet build did not produce dist/index.html');
  }

  const server = spawn(
    'pnpm',
    [
      '--filter',
      '@apps/stlstr',
      'exec',
      'vite',
      '--host',
      host,
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  server.stdout.pipe(process.stderr);
  server.stderr.pipe(process.stderr);

  const stopServer = () => {
    if (!server.killed) server.kill('SIGTERM');
  };

  process.on('SIGINT', stopServer);
  process.on('SIGTERM', stopServer);

  try {
    await waitForServer(baseUrl);
    const testDir = join(root, 'tests', 'browser');
    const testFiles = readdirSync(testDir)
      .filter((file) => file.endsWith('.test.mjs'))
      .map((file) => join(testDir, file));

    await run('node', ['--test', ...testFiles], {
      env: {
        STLSTR_TEST_BASE_URL: baseUrl,
        PUPPETEER_EXECUTABLE_PATH: chromiumPath,
      },
    });
  } finally {
    stopServer();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
