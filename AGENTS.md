# stlstr Agent Notes

## Purpose

- stlstr is intended to become a Thingiverse replacement built on Nostr events and Blossom files, using the NIP-5D napplet system from `https://napplet.run/`.
- The host app is `apps/stlstr`; it uses Kehto (`https://kehto.github.io/web/docs/`) to embed sandboxed napplet iframes and provide shell/runtime services.
- Product UX belongs in napplets. The shell owns user identity, config, relay/Blossom wiring, window/runtime state, and the NAP APIs napplets call through `window.napplet`.

## Architecture Intent

- Shell stack: Kehto hosts and dispatches napplet protocol messages; Applesauce is the intended Nostr engine behind shell services, not direct `nostr-tools` or ad hoc relay code.
- Use Applesauce docs/MCP before designing shell-side Nostr behavior. Relevant surfaces include `EventStore`, relay pools/loaders, models/casting, account/signing helpers, actions, React bindings, content parsing, encrypted-content caching, event caching, and Blossom/file examples.
- NAP boundary: napplets should be small contained UX pieces that call `@napplet/sdk`; the shell translates those NAP calls into identity, config, Nostr, Blossom, storage, cache, media, and relay behavior.
- Planned napplet domains are product slices such as browsing parts, uploading STL/files, thing/detail views, maker profiles, collections, comments/reactions, and makes.

## Product UX

- stlstr is a user-facing product, not a protocol debugger. Normal UI should show human-readable names, profile metadata, printable titles, thumbnails, and friendly status text instead of raw hex IDs, event JSON, full pubkeys, relay internals, or other debug/protocol details.
- Raw pubkeys, event IDs, relay URLs, and JSON are acceptable only in explicit advanced/debug views, logs, developer tooling, or copy/export actions where the user intentionally asks for protocol-level data.

## Repo Shape

- pnpm workspace, not npm/yarn: packages are `apps/*`, `lib/*`, `napplets/*`, and `tools/*`.
- Root requires Node `>=20`, pnpm `>=10`; lockfile/packageManager currently pins `pnpm@11.16.0`.
- `apps/stlstr` is the React/Vite host app. `napplets/*` are standalone NIP-5D napplets built to `dist/`.
- `tools/napplet-cli` provides the workspace `napplet` bin by shelling out to Deno/JSR `@napplet/cli`; Deno must exist for `napplet discover`, `deploy`, `debug`, and root conformance scripts.

## Commands

- Install with `pnpm install`; `pnpm-workspace.yaml` intentionally allows only `esbuild` postinstall builds and disables Puppeteer's browser download.
- Full local dev is `pnpm dev`: starts `@apps/stlstr` on `127.0.0.1:5173`, builds every napplet with `vite build --watch`, writes `apps/stlstr/public/napplets.dev.json`, and starts Kehto Paja on `127.0.0.1:5197`.
- Use `pnpm dev --no-paja` for host + napplet build-watch only. Dev ports can be overridden with `--host`, `--app-port`, `--paja-port` or `STLSTR_DEV_HOST`, `STLSTR_APP_PORT`, `STLSTR_PAJA_PORT`, `STLSTR_NO_PAJA=1`.
- Scripts are namespaced `app:*` (host app, deployed as an nsyte static site) and `napplet:*` (napplets, deployed to Nostr/Blossom via the napplet CLI); `dev`, `verify`, `test`, `type-check`, and `format` stay unprefixed.
- Root `pnpm napplet:build` only builds napplets. `pnpm app:build` builds the napplets first, then the host, and bundles every built-in napplet artifact into `apps/stlstr/dist/napplets/<dTag>/` with a `napplets.json` registry (see the bundle plugin in `apps/stlstr/vite.config.ts`). For host-only iteration use `pnpm --filter @apps/stlstr build` (expects `napplets/*/dist` to already exist).
- Focused napplet verification: `pnpm --filter stl-preview verify` or `pnpm --filter part-detail verify`; conformance: `pnpm --filter stl-preview test:conformance`.
- Root verification: `pnpm verify` runs `pnpm test`, then turbo `type-check` and `build` for `napplets/*` and `lib/*`; it does not build/lint the host app.
- Host lint/build checks are separate: `pnpm --filter @apps/stlstr lint` and `pnpm --filter @apps/stlstr build`.
- Browser smoke tests are separate: `pnpm test:browser` requires a system Chromium or `PUPPETEER_EXECUTABLE_PATH`, writes the dev registry, builds the napplets under test (`testNapplets` in `scripts/test-browser.mjs`), and serves the host on `127.0.0.1:5174` by default (`STLSTR_TEST_HOST` / `STLSTR_TEST_PORT` override it).
- Formatting is Prettier via `pnpm format:check` / `pnpm format`; `pnpm-lock.yaml`, `dist`, `.turbo`, and napplet sidecar manifests are ignored by Prettier.

## Publishing Napplets

- This section is about publishing the napplets themselves (`napplet:*`), which is independent of deploying the host app (`pnpm app:deploy`, an nsyte static-site deploy of `apps/stlstr/dist`).
- **`pnpm napplet:deploy` is public and permanent.** There is no local deploy target any more: it signs with the real `hzrd149` key, relay writes are append-only, and Blossom blobs are content-addressed, so a slip is not revocable. `pnpm napplet:deploy:dry` is the same command with `--dry-run` — use it first, and never run the real one unprompted.
- `napplet:deploy` reaches only what its config names — `napplet deploy` publishes to `config.relays` and uploads to `config.blossomServers` with no NIP-65 or outbox expansion — so `.napplet/config.json` is the entire blast radius.
- **Signing identity is the config's `signing.keyReference`, resolved at deploy time — `.napplet/config.json` references `hzrd149`.** `napplet deploy` re-signs the manifest event with the resolved signer; the build-time `.nip5a-manifest.json` (signed with `VITE_DEV_PRIVKEY_HEX`, the deadbeef dev default) is a local artifact for conformance/aggregate-hash only and never determines the published pubkey. So a build never needs the real key — only a deploy does.
- `pnpm napplet:login` stores a secret in the OS keychain (libsecret `secret-tool` on Linux; needs a D-Bus session) under the `hzrd149` reference and points `keys use` at `.napplet/config.json`. It keeps the key out of the repo — only the key _reference_ name is stored in config, never the secret. Sign out with `pnpm napplet:logout`.
- The local relay on `ws://localhost:4869` and Blossom on `http://localhost:24242` are for `pnpm dev` and the tests, not for deploys. Both are assumed to be already running on this machine — tests depend on them rather than starting their own.

## Source Control

- **Commit every finished feature.** As soon as a unit of work builds and its checks pass, commit it. Uncommitted work is the only work that can be lost, and this tree has already lost a day's worth once.
- Do not batch a whole session into one commit at the end. Commit at each point the tree is coherent — a shell service, a napplet, a test suite — so any single mistake costs one step instead of everything.
- **More than one agent may be editing this tree at the same time.** Before running anything that discards working-tree state, assume someone else has uncommitted work in it and check `git status` first. `git reset --hard`, `git checkout -- .`, `git clean`, and `git stash` all destroy other agents' changes without warning; a stash is not safe just because it is reversible in principle, because the next `git stash drop` makes it unreachable.
- Prefer committing over stashing. If you need a clean tree, commit the current state (a WIP commit is fine and can be amended) rather than shelving it.
- If work does go missing, it is usually still in the object store: `git reflog` shows resets, and `git fsck --unreachable --dangling` finds dropped stash commits and orphaned blobs. Back up the working tree before attempting any recovery.
- Never commit generated artifacts — `dist`, `.turbo`, `apps/stlstr/public/napplets.dev.json`, and napplet sidecar manifests are all ignored on purpose.

## Napplet Workflow

- Scaffold new napplets with `pnpm napplet:new <name> ["Display Title"] [-- <generator flags>]`; this wraps `npx @napplet/boilerplate` and then `scripts/lib/adopt.mjs` normalizes the package for this monorepo.
- Napplet folder names double as deploy `d` tags; `adopt.mjs` warns if names are not lowercase/digit/hyphen and at most 13 chars.
- Do not add app-owned `@napplet/shim` imports in napplets. Kehto injects `window.napplet`; napplet app code should use `@napplet/sdk`.
- Napplet `vite.config.ts` must declare every used NAP in `nip5aManifest({ requires: [...] })`; the host injects grants from that list.
- Napplet builds should stay single-file artifacts by using `artifactMode: 'single-file'`; host dev serves `napplets/<name>/dist` at `/napplets.dev/<name>/`.
- **Root `build`/`verify` set a dummy `VITE_DEV_PRIVKEY_HEX`, and it is not a key.** `@napplet/vite-plugin` returns early unless that variable is set, and the early return sits above the code that assembles the manifest's `requires` and `archetype` tags — so without it `dist/` is just `index.html` and `napplet deploy` publishes a napplet with no declared capabilities. The signature it buys is discarded anyway: deploy recomputes the aggregate hash from the real files and re-signs with the deploy key. Nothing reads the dummy signature, `.nip5a-manifest.json` is gitignored, and the value is overridable if a real dev manifest is ever wanted. Declared in `turbo.json` under `build.env` because turbo runs strict env mode and would otherwise filter it out before `vite build` sees it. Remove all of this once the upstream fix lands (napplet/web: `writeBundleManifest` should build the template unconditionally and sign only when a key exists).
- For normal dev, napplets are not run as Vite dev servers; `pnpm dev` serves their built `dist/index.html` from the host origin.
- **Napplets MUST NEVER touch `window.nostr`, bundle `nostr-tools`, or hold a key.** Identity comes from NAP-IDENTITY, publishing from NAP-OUTBOX; there is no third way. `sandbox="allow-scripts"` does not stop a NIP-07 extension, which injects into every frame including srcdoc ones — a napplet that found a signer there could read the user and request signatures with no grant, no consent prompt, and nothing the shell could see or revoke. Two things enforce this: the shell seals `window.nostr` in every napplet frame (`apps/stlstr/src/services/sandbox.ts`), and `scripts/lib/napplet-source.test.mjs` fails the build if napplet source reaches for a signer.
- Napplets MUST NOT render their own title bars, card wrappers, or visible borders; they are seamless embedded surfaces in the stlstr shell. Napplets MUST use DaisyUI (on Tailwind) so their visual language matches the host. See the `build-napplet` skill's "Visual Integration" section for the full contract.

## Host Wiring

- `apps/stlstr/src/App.tsx` routes each path to a napplet in a sandboxed iframe with `sandbox="allow-scripts"`, injecting only the NAP domains that route grants.
- `@kehto/runtime` handles `storage`, `media`, `keys`, `notify`, and `theme` itself; every other domain (`outbox`, `upload`, `resource`, `intent`, `common`, `count`, `lists`, `link`, ...) is **service-only** and does nothing until the shell registers a handler in `createStlstrAdapter().services`. Unhandled messages surface through `onUnroutedMessage`.
- Registered so far: `outbox` and `upload` (Applesauce/Blossom backed), `resource` (`services/resource.ts`), `intent` (`services/intent.ts`), `identity` (`services/identity.ts`), and `link` (`services/links.ts`). `common` and `count` are granted on some routes but still unregistered.
- **NAP-IDENTITY is the only way a napplet learns who the user is.** Never infer the current user from an intent payload, a route param, or an event author — those are untrusted or incidental. `services/identity.ts` answers `getPublicKey`/`getRelays` from the signer and `getProfile`/`getFollows`/`getMutes` from the shell's Applesauce event store, so a napplet asking for the user's profile never causes a relay round trip it cannot see. It is strictly read-only: napplets learn _about_ the user, never act _as_ them, and publishing goes through NAP-OUTBOX where the shell holds the signer.
- Identity has **two halves, and both are required**. The service only answers questions; `bridge.publishIdentityChanged(pubkey)` in `App.tsx` pushes every account change. A napplet must pair `identity.getPublicKey()` at mount with an `identity.onChanged` subscription, or it holds the answer it got at mount forever and owner-gated actions never appear on login. Use `publishIdentityChanged`, not `injectEvent` — the latter sends an inc.event on a topic nothing subscribes to.
- An empty pubkey means "nobody is signed in", not an error. Gate owner-only UI on a non-empty pubkey matching the owner, so a shell without NAP-IDENTITY hides the action rather than showing it.
- NAP-RESOURCE is the shell's fetch boundary: any `https` origin is grantable, but the host `fetch` enforces scheme, private-host, 10 MiB, 30s, and concurrency limits and re-types every response by sniffing so upstream `Content-Type` never reaches a napplet. Dev builds also allow `http` to private hosts for the local Blossom server.
- NAP-INTENT resolves archetypes to shell routes rather than new windows, so `intent.open('printable-detail', { address })` is a navigation. Navigation is deferred a tick so the caller's result arrives before its iframe unmounts.
- `apps/stlstr/vite.config.ts` has a dev-only middleware for `/napplets.dev.json` and `/napplets.dev/<name>/*`; if a napplet 404s in the host, build/watch its `dist` first.
- The dev registry `apps/stlstr/public/napplets.dev.json` is generated by `pnpm dev` and is gitignored; do not commit it.

## Current Gaps

- There is no CI workflow in the current tree; trust package scripts and config over stale generated/template prose.
- NAP-RESOURCE rejects `image/svg+xml` instead of rasterizing it, as the spec requires; there is no rasterizer yet. It also cannot re-check resolved addresses after DNS the way the policy describes, because browsers do not expose that.
- Refusals raised inside the host `fetch` reach napplets as `network-error` with no detail — `@kehto/services` only maps pre-fetch grant failures to `blocked-by-policy`. The shell logs the real reason to the console.
- `@apps/stlstr` still depends on `nostr-tools`; replace shell-side Nostr plumbing with Applesauce packages as NAP service handlers are implemented.
