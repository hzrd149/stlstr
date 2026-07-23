# @napplet/* Package Reference

> Source: https://napplet.run/docs/packages/

The napplet SDK is a small set of focused, ESM-only packages. Runtimes use **`@napplet/shim`** to inject selected domains. Napplets use **`@napplet/sdk`** and/or `@napplet/core` types, with **`@napplet/vite-plugin`** as a dev dependency for manifest generation.

## Dependency graph

```
@napplet/shim ──► @napplet/nap ──► @napplet/core
@napplet/sdk  ──► @napplet/core

@napplet/vite-plugin  (build-time only, depends on nostr-tools)
@napplet/cli          (Deno deploy and diagnostics tool)

@napplet/conformance-cli ──► @napplet/conformance + @napplet/conformance-web
@napplet/conformance-web ──► @napplet/conformance

@napplet/boilerplate  (CLI generator, clones github.com/napplet/boilerplate)
```

The iframe sandbox requires only `allow-scripts` — **no `allow-same-origin`**. Napplets cannot access the host shell's DOM, cookies, `localStorage`, or service workers; all persistent state goes through the shell's proxies.

Every package is published to [npm](https://www.npmjs.com/org/napplet); most are also on [JSR](https://jsr.io/@napplet) (`@napplet/boilerplate`, `@napplet/conformance-cli`, and `@napplet/conformance-web` are npm-only). Source lives at [github.com/napplet/napplet](https://github.com/napplet/napplet).

---

## @napplet/core

> JSON envelope types and NAP dispatch infrastructure. Imported by all other packages. Zero dependencies, no DOM/browser APIs.

### Install

```bash
npm install @napplet/core
```

### Key exports

```typescript
import {
  type NappletMessage,
  type NapDomain,
  type NappletGlobal,
  type NapHandler,
  type NapDispatch,
  NAP_DOMAINS,
  SHELL_BRIDGE_URI,
  PROTOCOL_VERSION,
  createDispatch,
  registerNap,
  dispatch,
  getRegisteredDomains,
  ALL_CAPABILITIES,
  TOPICS,
} from '@napplet/core';
```

### Envelope types

- **`NappletMessage`** — base interface: `{ type: string }` in `domain.action` format.
- **`NapDomain`** — string literal union: `'relay' | 'identity' | 'storage' | 'inc' | 'theme' | 'keys' | 'media' | 'notify' | 'config' | 'resource' | 'cvm' | 'outbox' | 'upload' | 'intent' | 'ble' | 'webrtc' | 'link' | 'count' | 'lists' | 'serial' | 'common' | 'dm'`
- **`NappletGlobal`** — the runtime-injected `window.napplet` namespace with optional domain properties.
- **`NAP_DOMAINS`** — runtime constant array of all domain strings.

### Dispatch infrastructure

NAP modules self-register at import time; inbound messages route by the domain prefix of `message.type` (part before the first `.`).

- **`createDispatch()`** — factory returning an isolated `{ registerNap, dispatch, getRegisteredDomains }` backed by its own registry.
- **`registerNap(domain, handler)`** — register a handler on the module-level singleton registry (throws if already registered).
- **`dispatch(message)`** — route a message to its handler; returns `true` if found, `false` for unknown/malformed type.
- **`getRegisteredDomains()`** — list registered domain strings.

### Boundary helpers (clone-safety)

Every NAP shim crosses the napplet ⇄ shell boundary by structured-cloning a JSON envelope through `postMessage`. Framework reactive values (Svelte 5 `$state`, Vue `reactive`, Solid stores) are `Proxy` objects that are **not** structured-cloneable, so a naive `postMessage` throws `DataCloneError` (silently swallowed in async paths).

- **`sendEnvelope(target, message, targetOrigin?)`** — the single boundary chokepoint. Per clone mode: posts as-is, recovers via snapshot, or throws a loud synchronous error.
- **`toCloneableSnapshot(value)`** — deep snapshot stripping reactive proxies into plain objects/arrays while **preserving binary** (`Uint8Array`, `ArrayBuffer`), `Date`, `RegExp`, `Map`, `Set`, and cycles. Lossless for binary; functions/symbols throw.
- **`setCloneMode(mode)`** / **`getCloneMode()`** — `'auto'` (default), `'strict'` (throw on DataCloneError), or `'snapshot'` (eagerly snapshot every envelope).
- **`clearCloneWarnings()`** — reset once-per-type auto-recovery warnings.

### Protocol types & constants

- **`NostrEvent`**, **`NostrFilter`**, **`EventTemplate`**, **`Subscription`** — shared Nostr structures.
- **`Capability`** / **`ALL_CAPABILITIES`** — human-readable capability strings (`relay:read`, `relay:write`, `sign:event`, `sign:nip44`, `state:read`, ...).
- **`PROTOCOL_VERSION`** (`'4.0.0'`), **`SHELL_BRIDGE_URI`** (`'napplet://shell'`), **`REPLAY_WINDOW_SECONDS`** (`30`), legacy **`TOPICS`** routing constants.

### Usage

```typescript
import { createDispatch } from '@napplet/core';

const { registerNap, dispatch } = createDispatch();

registerNap('outbox', (msg) => {
  console.log('outbox message:', msg.type);
});

dispatch({ type: 'outbox.query', id: 'abc', filters: [{ kinds: [1] }] }); // true
dispatch({ type: 'unknown.action' }); // false
dispatch({ type: 'malformed' }); // false (no dot)
```

---

## @napplet/shim

> Runtime-side helper for injecting selected `window.napplet.<domain>` objects before napplet scripts run. Consumed by NIP-5D runtimes, NOT by napplet application code. No cryptographic dependencies. No `window.nostr` is installed.

### Install

```bash
npm install @napplet/shim
```

### Runtime export

`installNappletGlobal` installs selected domain objects onto a target window.

For `iframe.srcdoc` runtimes, `@napplet/shim/prelude` exposes a host-injectable surface that does not require every napplet bundle to import the shim:

```typescript
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderNappletRuntimePreludeCall } from '@napplet/shim/prelude';

const require = createRequire(import.meta.url);
const preludeSource = readFileSync(require.resolve('@napplet/shim/prelude.global'), 'utf8');
const activatePrelude = renderNappletRuntimePreludeCall({
  domains: ['identity', 'storage', 'outbox'],
});

const srcdoc = html.replace(
  '<head>',
  `<head><script>${preludeSource}\n${activatePrelude}</script>`,
);
```

The IIFE artifact exposes `globalThis.NappletShimPrelude.install({ domains })` and installs only the requested known NAP domains. `prelude.global` artifact is npm-only.

### The `window.napplet` shape

After runtime injection, the global may contain:

| Namespace  | What it does                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `outbox`   | Outbox-aware `getEvent`, `query`, `subscribe`, `publish`, `resolveRelays`; default for normal event reads and publishes |
| `common`   | Profile lookup, follow/unfollow, reactions, reports, NIP-19 helpers                                                     |
| `lists`    | NIP-51 list read and mutation helpers                                                                                   |
| `count`    | Count queries through the shell                                                                                         |
| `dm`       | Shell-mediated encrypted direct-message helpers                                                                         |
| `relay`    | Low-level explicit relay proxy for relay-local escape hatches                                                           |
| `inc`      | Inter-napplet communication: `emit`, `on`                                                                               |
| `storage`  | Scoped key-value storage: `getItem`, `setItem`, `removeItem`, `keys` (512 KB quota), plus `storage.instance.*`          |
| `keys`     | Keyboard forwarding + action keybindings: `registerAction`, `unregisterAction`, `onAction`                              |
| `media`    | Ownership-aware media sessions: `createSession`, `reportState`, `onCommand`, ...                                        |
| `notify`   | Shell-rendered notifications: `send`, `badge`, `onAction`, ...                                                          |
| `identity` | Read-only user queries: `getPublicKey`, `onChanged`, `getProfile`, ...                                                  |
| `config`   | Per-napplet declarative config: `get`, `subscribe`, `openSettings`, `registerSchema`, `schema`                          |
| `resource` | Sandboxed byte fetching: `info`, `bytes`, `bytesMany`, `bytesAsObjectURL`                                               |

**Domain absence:** If a property is absent, that NAP is unavailable to the napplet.

### Usage

```typescript
import { installNappletGlobal } from '@napplet/shim';

installNappletGlobal({ domains: ['outbox', 'storage', 'identity'] });
```

### TypeScript support

The shim does not modify global `Window` types in its published source (for JSR acceptance). For typed access, cast using `NappletGlobal` from `@napplet/core`, or use named helpers from `@napplet/sdk`:

```typescript
import type { NappletGlobal } from '@napplet/core';
const napplet = (window as Window & { napplet: NappletGlobal }).napplet;
```

### Wire format

Outbound: `window.parent.postMessage(msg, '*')`. Inbound: `message` listener. Request/response pairs correlated by `id` field.

---

## @napplet/sdk

> Named TypeScript exports for napplet developers using a bundler. Wraps `window.napplet` at call time. Depends on `@napplet/core` for types only. No side effects. Throws a clear error if a method is called before the runtime injected `window.napplet` or before a domain is available.

### Install

```bash
npm install @napplet/sdk
```

### Key exports

Top-level namespaced objects mirroring `window.napplet`:

- **`outbox`** — `getEvent`, `query`, `subscribe`, `publish`, `resolveRelays`
- **`common`** — profile lookup, follow/unfollow, reactions, reports, NIP-19 helpers
- **`lists`** — NIP-51 list read and mutation helpers
- **`count`** — count queries through the shell
- **`dm`** — shell-mediated encrypted direct-message helpers
- **`relay`** — low-level explicit relay proxy; use only for relay-local escape hatches
- **`inc`** — `emit`, `on` (plus deprecated `ifc*` migration aliases)
- **`storage`** — `getItem`, `setItem`, `removeItem`, `keys`, plus `storage.instance.*`
- **`keys`** — `registerAction`, `unregisterAction`, `onAction`
- **`media`** — `createSession`, `reportState`, `onCommand`, ...
- **`notify`** — `send`, `badge`, `onAction`, ...
- **`config`** — `get`, `subscribe`, `openSettings`, `registerSchema`, `schema`
- **`resource`** — `info`, `bytes`, `bytesMany`, `bytesAsObjectURL`

`identity` is exported as a top-level object and through bare-name helpers:

- `identityGetPublicKey`, `identityOnChanged`

There is **no top-level `shell` object**. Detect capability availability from runtime-injected domain presence (`window.napplet?.outbox`, etc.).

The SDK also re-exports:

- The `*_DOMAIN` constants and `install*Shim` installers
- `resourceInfo`, `resourceBytes`, `resourceBytesMany`, `resourceBytesAsObjectURL`
- Protocol types from `@napplet/core` and per-domain message-type unions (`RelayNapMessage`, `IdentityNapMessage`, ...)

### Usage

```typescript
import { outbox, common, inc, storage, keys, config, resource } from '@napplet/sdk';

const { events } = await outbox.query([{ kinds: [1], limit: 20 }], { timeoutMs: 3000 });
const sub = outbox.subscribe([{ kinds: [1], limit: 20 }], { timeoutMs: 3000 });
sub.on('event', (result) => console.log('New note:', result.event.content));

const published = await outbox.publish({
  kind: 1,
  content: 'Hello from my napplet!',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
});
if (!published.ok || !published.event) throw new Error(published.error ?? 'publish failed');

await common.react(published.event.id, '+');
inc.emit('chat:message', [], JSON.stringify({ text: 'hi' }));
await storage.setItem('theme', 'dark');
const configSub = config.subscribe((values) => applyTheme(values.theme));
const avatarBlob = await resource.bytes('https://example.com/avatar.png');
```

### Typed config with `FromSchema`

`json-schema-to-ts` is an **optional** peer dependency. Install it for `FromSchema<typeof schema>` typing in `config.subscribe`:

```typescript
import { config } from '@napplet/sdk';
import type { FromSchema } from 'json-schema-to-ts';

const schema = {
  type: 'object',
  properties: { theme: { type: 'string', enum: ['light', 'dark'], default: 'dark' } },
  required: ['theme'],
} as const;

const sub = config.subscribe((values: FromSchema<typeof schema>) => {
  // values.theme is typed 'light' | 'dark'
});
```

### Namespace import

`import * as napplet from '@napplet/sdk'` produces an object structurally identical to `window.napplet`:

```typescript
import * as napplet from '@napplet/sdk';
const { events } = await napplet.outbox.query([{ kinds: [1], limit: 20 }]);
```

---

## @napplet/nap

> Every active NAP domain as layered subpath exports. No root export — must import from a domain subpath.

### Install

```bash
pnpm add @napplet/nap
```

### Subpath patterns

Each domain exposes up to four entry-point shapes:

| Pattern        | Subpath                       | Contents                                  |
| -------------- | ----------------------------- | ----------------------------------------- |
| **Barrel**     | `@napplet/nap/<domain>`       | types + shim installer + SDK helpers      |
| **Types-only** | `@napplet/nap/<domain>/types` | pure TypeScript types, zero runtime       |
| **Shim**       | `@napplet/nap/<domain>/shim`  | installer + message handlers (for shells) |
| **SDK**        | `@napplet/nap/<domain>/sdk`   | named helper functions (for napplet code) |

```typescript
import { installRelayShim, relaySubscribe, RelaySubscribeMessage } from '@napplet/nap/relay';
import type { IncEventMessage } from '@napplet/nap/inc/types';
import { installStorageShim } from '@napplet/nap/storage/shim';
import { notifySend } from '@napplet/nap/notify/sdk';
```

### Tree-shaking contract

- Published with `sideEffects: false`.
- 92 entry points: 22 active domain barrels, 22 types entries, 22 shim entries, 22 sdk entries, plus the `ifc` compatibility wrapper.
- A bundler importing only `@napplet/nap/relay/types` produces zero bytes from other domains.

### Domain notes

- **resource** — single scheme-pluggable byte-fetching primitive over four canonical schemes (`data:`, `https:`, `blossom:sha256:<hex>`, `nostr:<bech32>`).
- **identity** — strictly read-only. Take one snapshot with `getPublicKey()`, then subscribe to `identity.changed`.
- **media** — ownership-aware media sessions with optional context links.
- **ble** — runtime-mediated Bluetooth LE/GATT sessions.
- **webrtc** — runtime-mediated WebRTC data sessions.
- **link** — shell-mediated external navigation via `open(url, options?)`.
- **count** — runtime-mediated event counts via `query(filters, options?)`.
- **lists** — NIP-51 list mutations via `supported`/`add`/`remove`.
- **common** — shell-mediated public NIP-19 helpers, profile lookup, follows, reactions, reports.
- **serial** — runtime-mediated serial device access: `open`/`write`/`close`/`onEvent`.

### Optional peer dependency

`json-schema-to-ts` is an optional peer dependency (scoped to the `config` domain's `FromSchema` typing).

---

## @napplet/vite-plugin

> Vite plugin for napplet local development — injects aggregate-hash meta tags and generates NIP-5A manifests for testing. Build/dev time only, not a runtime dependency.

### Install

```bash
npm install -D @napplet/vite-plugin
```

### Quick start

```typescript
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  plugins: [nip5aManifest({ nappletType: 'my-napp' })],
});
```

### Options

| Option                     | Type                                 | Purpose                                                                                                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `nappletType` _(required)_ | `string`                             | The napp type / `d` tag; injected as `<meta name="napplet-napp-type">` and used as manifest `d` tag.                      |
| `requires`                 | `string[]`                           | Bare NAP domain names this napplet needs. Injects `napplet-requires` meta tag and `["requires", ...]` manifest tags.      |
| `title`                    | `string`                             | Human-readable title. Sets/overrides HTML `<title>`. CLI reads it back and emits NIP-5A `["title", ...]` tag.             |
| `description`              | `string`                             | Human-readable description. Sets/overrides `<meta name="description">`. CLI emits NIP-5A `["description", ...]` tag.      |
| `configSchema`             | `NappletConfigSchema \| string`      | JSON Schema for NAP-CONFIG surface. Inline object or path; falls through to `config.schema.json` then `napplet.config.*`. |
| `artifactMode`             | `'external-assets' \| 'single-file'` | Default `'external-assets'`. `'single-file'` inlines local JS/CSS into `index.html` before hashing.                       |

### What gets injected

**Dev mode** — two meta tags:

```html
<meta name="napplet-aggregate-hash" content="" />
<meta name="napplet-napp-type" content="my-napp" />
```

**Build time** (with `VITE_DEV_PRIVKEY_HEX` set) — walks `dist/`, computes hashes, signs kind 35129 event, writes `.nip5a-manifest.json`:

```json
{
  "kind": 35129,
  "tags": [
    ["d", "my-music-app"],
    ["path", "/index.html", "<sha256>"],
    ["x", "<aggregateHash>", "aggregate"],
    ["requires", "outbox"],
    ["requires", "storage"]
  ]
}
```

### Build-time guards

- Config schema validation against NAP-CONFIG Core Subset — `pattern`, `$ref`, non-object root, or `x-napplet-secret` with `default` abort the build.
- Inline scripts are supported — NIP-5D loads via `iframe.srcdoc` (opaque origin), so JS is inline by design. `artifactMode: 'single-file'` folds local script/style into HTML.

### Environment

- **`VITE_DEV_PRIVKEY_HEX`** — hex 32-byte test private key. If set, signs manifest at build time; if unset, manifest generation gracefully skipped. **Never use a real key.**

---

## @napplet/cli

> Standalone CLI for creating, configuring, inspecting, and deploying napplets.

### Install

```bash
# macOS or Linux
curl -fsSL https://napplet.run/install.sh | sh

# Windows PowerShell
irm https://napplet.run/install.ps1 | iex
```

JSR/Deno alternative:

```bash
deno install --global \
  --allow-read --allow-write --allow-run --allow-env --allow-net \
  --name napplet \
  jsr:@napplet/cli/cli
```

### Quick start

```bash
napplet create my-napplet
cd my-napplet
napplet init
napplet skills install --to codex
pnpm install
pnpm verify
napplet deploy --dry-run
napplet deploy
```

### Commands

```bash
napplet guide
napplet create <directory> [--template <path-or-url>] [--force]
napplet init [--force] [--root] [--source-dir <dir>] [--name <dtag>] [--title <title>] [--description <text>] [--archetype <slug:NAP-N>] [--relay <url>] [--server <url>]
napplet skills <list|print|install> [args]
napplet discover [--config <file>] [--all]
napplet debug [--config <file>] [--all] [--root] [--name <dtag>] [--snapshot] [--sec <secret>]
napplet deploy [--config <file>] [--all] [--root] [--name <dtag>] [--snapshot] [--sec <secret>] [--prompt-sec] [--dry-run]
napplet keys store --name <ref> [--sec <secret> | --prompt-sec]
napplet keys connect --name <ref> [--relay <url> ...] [--config <file>]
napplet keys use --name <ref> [--config <file>]
napplet keys list
napplet keys delete --name <ref>
napplet keys doctor
napplet conformance [--config <file>] [--all] [-- <args>]
napplet paja [--config <file>] [-- <args>]
```

### Layouts

Single napplet repo: discovery checks `sourceDir`, prefers `dist/index.html`, falls back to top-level `index.html`.
Workspaces: set `discover.roots` and use `--all`. Each napplet deploys under its own folder name as the named `d` tag.

---

## @napplet/conformance

> Framework-agnostic conformance engine. Development/testing tool, not loaded in the sandbox.

### Install

```bash
npm install -D @napplet/conformance
```

### What's in the box

- **`validateEnvelope(msg)`** — runtime validation of any `domain.action` envelope across every NAP domain.
- **`validateManifestEvent(event)`** — checks that a resolved Nostr event is a NIP-5D manifest (`5129`, `15129`, or `35129`) with hashed `/index.html` path and bare known `requires` domains.
- **`validateManifest(html)`** — compatibility wrapper for older HTML-only harnesses.
- Reference mock shell, check registry, and reporters shared by CLI and web runtime.

The validator surface is kept in lockstep with `@napplet/nap` by a drift test.

```typescript
import { validateEnvelope, validateManifestEvent } from '@napplet/conformance';

validateEnvelope({ type: 'outbox.query', id: 'a', filters: [{ kinds: [1] }] }).ok; // true
validateManifestEvent(resolvedManifestEvent).ok; // true when well-formed
```

---

## @napplet/conformance-cli

> The headless `napplet-conformance` runner — drives the conformance engine against a napplet in real headless Chromium via Playwright.

### Usage

```bash
npx napplet-conformance ./dist
npx napplet-conformance .
npx napplet-conformance --url https://my.napplet.example/
```

### Wire it up as `test:conformance`

```jsonc
{
  "scripts": {
    "test:conformance": "napplet-conformance ./dist",
    "test:conformance:ui": "napplet-conformance --ui . --exec \"vite build --watch\"",
  },
}
```

### UI / watch mode

```bash
napplet-conformance --ui . --exec "vite build --watch"
```

`--ui` serves the standalone conformance web runtime plus the napplet, opens the browser, and re-runs conformance live on every change.

---

## @napplet/conformance-web

> Browser conformance runtime for live napplet protocol testing. Powers the deployed `/conformance` app and `napplet-conformance --ui` watch mode.

### Use the hosted app

Open `https://napplet.run/conformance/`, enter a napplet `nevent` or `naddr`, or deep-link with `?target=...`. The runtime resolves the signed manifest event, fetches `/index.html` from Blossom server hints, verifies the blob hash, and runs conformance.

### Run through the CLI

```bash
napplet-conformance --ui . --exec "vite build --watch"
```

---

## @napplet/boilerplate

> Project-only generator behind `napplet create`. Clones the `github.com/napplet/boilerplate` template — a Vite + TypeScript napplet starter.

### Usage

```bash
napplet create my-napplet
# or directly:
npx @napplet/boilerplate ./my-napplet --yes
```

### Options

| Option                     | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `--variant <name>`         | Template variant. Currently `basic`.            |
| `--template <path-or-url>` | Override the template source.                   |
| `--yes`, `-y`              | Use `./my-napplet` when destination is omitted. |
| `--force`                  | Allow generation into a non-empty directory.    |

---

## @napplet/skills

> Agent skills that let a coding agent make, design, build, port, and test a napplet end-to-end.

### The skills

| Skill            | When                            | Covers                                                                                                                      |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `make-napplet`   | One-prompt end-to-end builds    | Orchestrates project-state triage, port/design/build/test, NAP-THEME, OUTBOX-first, evidence checklist.                     |
| `design-napplet` | First — plan before code        | Sandbox/loading constraints, OUTBOX-first NAP selection, hard-vs-optional shell domains, responsive layout, build spec.     |
| `build-napplet`  | Implementation                  | Correct project state, preserves starter substrate, applies NAP-THEME, uses `@napplet/sdk`, previews through Paja.          |
| `port-nostr-app` | Migrating an existing Nostr app | Replace direct relay pools, `window.nostr`, local storage, direct fetch, app-owned signing with shell-owned NAP boundaries. |
| `test-napplet`   | Before publishing               | Protocol conformance via `napplet-conformance`, interpreting failures, runtime guard, CI wiring.                            |

### Install routes

```bash
napplet skills install --to claude       # .claude/skills/<skill>/SKILL.md
napplet skills install --to claude-user  # ~/.claude/skills/<skill>/SKILL.md (global)
napplet skills install --to cursor       # .cursor/rules/<skill>.mdc
napplet skills install --to windsurf     # .windsurf/rules/<skill>.md
napplet skills install --to agents       # AGENTS.md (appended block)
napplet skills install --to gemini       # GEMINI.md (appended block)
napplet skills install --to copilot      # .github/copilot-instructions.md
```

`agents` / `gemini` / `copilot` are idempotent — re-running replaces the managed `<!-- @napplet/skills:start -->...<!-- @napplet/skills:end -->` block.

### Programmatic API

```typescript
import { listSkills, readSkill, install } from '@napplet/skills';

listSkills(); // [{ name, description, path }, ...]
readSkill('build-napplet'); // full SKILL.md source
install({ to: 'claude' }); // → InstallResult[]
```
