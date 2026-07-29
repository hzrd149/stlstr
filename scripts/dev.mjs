#!/usr/bin/env node
// Start the whole local development environment:
//   - @apps/stlstr on Vite's default dev port (5173)
//   - every napplet workspace package as `vite build --watch` into dist/
//   - Kehto Paja on its own port (5197), targeting the stlstr app
//
// By default the app talks to the production relays. `--local` (i.e. `pnpm local`) pins it
// to the local relay instead, which is expected to already be running on this machine.
//
// The script writes apps/stlstr/public/napplets.dev.json before startup. Vite
// serves that file from the app origin, so the stlstr app can discover every
// local napplet's built single-file HTML during development without hard-coded
// filesystem paths in app code. The app Vite server serves napplet dist files at
// /napplets.dev/<name>/ via a dev-only plugin in apps/stlstr/vite.config.ts.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = join(root, 'apps');
const stlstrDir = join(appsDir, 'stlstr');
const nappletsDir = join(root, 'napplets');
const registryPath = join(stlstrDir, 'public', 'napplets.dev.json');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_APP_PORT = 5173;
const DEFAULT_PAJA_PORT = 5197;
const DEFAULT_LOCAL_RELAY = 'ws://localhost:4869';

const argv = process.argv.slice(2);
let host = process.env.STLSTR_DEV_HOST || DEFAULT_HOST;
let appPort = Number(process.env.STLSTR_APP_PORT) || DEFAULT_APP_PORT;
let pajaPort = Number(process.env.STLSTR_PAJA_PORT) || DEFAULT_PAJA_PORT;
let runPaja = process.env.STLSTR_NO_PAJA !== '1';
let local = process.env.STLSTR_LOCAL === '1';
const pajaArgs = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--host') host = argv[++i];
  else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
  else if (arg === '--app-port') appPort = Number(argv[++i]);
  else if (arg.startsWith('--app-port=')) appPort = Number(arg.slice('--app-port='.length));
  else if (arg === '--paja-port') pajaPort = Number(argv[++i]);
  else if (arg.startsWith('--paja-port=')) pajaPort = Number(arg.slice('--paja-port='.length));
  else if (arg === '--no-paja') {
    runPaja = false;
  } else if (arg === '--local') {
    local = true;
  } else {
    pajaArgs.push(arg);
  }
}

function assertPort(name, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid ${name}: ${port}`);
    process.exit(1);
  }
}

assertPort('--app-port', appPort);
assertPort('--paja-port', pajaPort);

const appUrl = `http://${host}:${appPort}`;
const pajaUrl = `http://${host}:${pajaPort}`;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listNapplets() {
  if (!existsSync(nappletsDir)) return [];

  return readdirSync(nappletsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(nappletsDir, entry.name);
      const packagePath = join(dir, 'package.json');
      if (!existsSync(packagePath)) return null;

      const pkg = readJson(packagePath);
      return {
        folder: entry.name,
        packageName: pkg.name || entry.name,
        title: pkg.displayName || pkg.title || entry.name,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

const napplets = listNapplets().map((napplet, index) => {
  return {
    ...napplet,
    url: `${appUrl}/napplets.dev/${encodeURIComponent(napplet.folder)}/index.html`,
    dist: join(nappletsDir, napplet.folder, 'dist'),
    buildOrder: index + 1,
  };
});

if (appPort === pajaPort) {
  console.error(`Port ${appPort} is used by both the stlstr app and Paja.`);
  process.exit(1);
}

const registry = {
  version: 1,
  generatedAt: new Date().toISOString(),
  app: {
    packageName: '@apps/stlstr',
    url: appUrl,
  },
  paja: runPaja
    ? {
        url: pajaUrl,
        targetUrl: appUrl,
      }
    : null,
  napplets: napplets.map((napplet) => ({
    name: napplet.folder,
    folder: `napplets/${napplet.folder}`,
    packageName: napplet.packageName,
    title: napplet.title,
    url: napplet.url,
    dev: {
      mode: 'build-watch',
      dist: napplet.dist,
      route: `/napplets.dev/${napplet.folder}/`,
    },
  })),
};

writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

const children = new Map();
let shuttingDown = false;

function prefixLines(label, stream) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) console.error(`[${label}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffered.length > 0) console.error(`[${label}] ${buffered}`);
  });
}

function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.set(label, child);
  prefixLines(label, child.stdout);
  prefixLines(label, child.stderr);

  child.on('error', (error) => {
    if (shuttingDown) return;
    console.error(`[${label}] failed to start: ${error.message}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    children.delete(label);
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`[${label}] stopped (${reason}); shutting down dev environment.`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const [label, child] of children) {
    console.error(`Stopping ${label}...`);
    child.kill('SIGTERM');
  }

  setTimeout(() => {
    for (const child of children.values()) {
      child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 2000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const localRelay = process.env.VITE_STLSTR_LOCAL_RELAY || DEFAULT_LOCAL_RELAY;

console.error(`Starting stlstr dev environment (${local ? 'local' : 'production'} network)`);
console.error(`  app:      ${appUrl}`);
console.error(`  registry: ${appUrl}/napplets.dev.json`);
if (runPaja) console.error(`  paja:     ${pajaUrl} -> ${appUrl}`);
if (local) {
  console.error(`  relay:    ${localRelay} (expected to already be running)`);
} else {
  console.error('  network:  production relays (`pnpm local` for the local relay)');
}
if (napplets.length === 0) {
  console.error('  napplets: none (scaffold one with `pnpm napplet:new <name>`)');
} else {
  console.error('  napplets (build --watch -> same-origin dist URLs):');
  for (const napplet of napplets) {
    console.error(`    ${napplet.folder}: ${napplet.url}`);
  }
}

start(
  'app',
  'pnpm',
  [
    '--filter',
    '@apps/stlstr',
    'exec',
    'vite',
    '--host',
    host,
    '--port',
    String(appPort),
    '--strictPort',
  ],
  local
    ? {
        VITE_STLSTR_LOCAL: '1',
        VITE_STLSTR_LOCAL_RELAY: localRelay,
      }
    : {},
);

for (const napplet of napplets) {
  start(`napplet:${napplet.folder}`, 'pnpm', [
    '--filter',
    `./napplets/${napplet.folder}`,
    'exec',
    'vite',
    'build',
    '--watch',
    '--mode',
    'development',
  ]);
}

if (runPaja) {
  start('paja', 'pnpm', [
    'exec',
    'kehto',
    'paja',
    '--host',
    host,
    '--port',
    String(pajaPort),
    '--target-url',
    appUrl,
    ...pajaArgs,
  ]);
}
