# Plan: browse-objects MVP (home / search page)

Status: draft · Target: `napplets/browse-objects` + shell wiring in `apps/stlstr`

## Goal

Turn `napplets/browse-objects/src/App.svelte` (currently a 16-line skeleton mockup) into a working
home page: a live feed of printable objects (`kind:33500`, per `NIP.md`) read through **NAP-OUTBOX**,
with cover images fetched through **NAP-RESOURCE**, and a click-through to the object detail route.

## Current state (verified)

- `browse-objects` renders static skeletons; no SDK calls at all.
- Shell route `DEFAULT_ROUTE` (`apps/stlstr/src/App.tsx:56`) already grants
  `['outbox', 'identity', 'common', 'count', 'resource', 'intent']`.
- Shell registers only two services: `outbox` and `upload` (`App.tsx:146`).
- `@kehto/runtime` treats `resource`, `intent`, `common`, `count` as **service-only** domains
  (`createRuntimeDomainHandlers`, runtime/dist/index.js:1383). With no registered handler the
  message is dropped into `onUnroutedMessage` — so today `resource.bytes()` and `intent.open()`
  silently fail even though the domains are injected.
- `napplets/browse-objects/vite.config.ts` declares `requires: ['outbox']` only.
- The outbox service is real and Applesauce-backed (`services/outbox.ts`), including
  `subscribe` → `outbox.event` streaming. In `STLSTR_DEV_MODE` all reads are routed to
  `getAppRelays()`, which is fine for the MVP.

## Blockers to clear first (shell side)

### B1 — Register a NAP-RESOURCE service

`@kehto/services` exports `createResourceService`. All four options are required or the factory
throws (`[RESOURCE-01 / H-03]`):

```ts
createResourceService({
  fetch, // host-owned: SSRF/private-IP block, size cap, MIME sniff
  isOriginGranted,
  getConnectGrants, // (dTag, aggregateHash) => allowed origins
  resolveIdentity, // wrap bridge.runtime.sessionRegistry
});
```

Open decision — **grant policy for cover images**. Object images live on arbitrary Blossom/CDN
hosts, so a static per-dTag origin allowlist cannot work. MVP recommendation: `getConnectGrants`
returns a wildcard sentinel and `isOriginGranted` allows any `https:` origin, with the real
enforcement in the host `fetch` wrapper:

- block private/loopback/link-local IPs after DNS and on every redirect
- cap response at 10 MiB, 30s timeout
- sniff MIME; ignore upstream `Content-Type`
- **reject `image/svg+xml`** rather than rasterize (the spec requires rasterization; rejecting is
  the honest MVP shortcut — record it as a known gap)

New file: `apps/stlstr/src/services/resource.ts`, wired into `createStlstrAdapter().services`.

### B2 — Register a NAP-INTENT service (needed for card → detail navigation)

`intent` is service-only too, so `intent.open(...)` is a no-op today (this also silently breaks
`create-object`'s existing "Open object" button, `create-object/src/App.svelte:331`).
Use `createIntentService` from `@kehto/services` and map an archetype to a shell route push.

Inconsistency to resolve while doing this: `create-object` opens archetype `'printable-object'`,
but `object-detail/vite.config.ts` declares archetype slug `'object-detail'`. Pick one
(`object-detail` matches the folder/dTag convention) and fix the caller.

### B3 — Route params never reach the napplet

`routeFromLocation` computes `params` for `/search?q=` and `/tags/:tag`, but `NappletFrame` passes
only `{ domains }` to `injectNappletNamespacePrelude`. Sandboxed `srcdoc` napplets have no URL, so
there is currently **no channel** for the query/tag.

MVP decision: **search state lives inside the napplet.** The napplet owns its search input and tag
chips; `/search` and `/tags/:tag` shell routes render the same napplet with no seeded state.
Follow-up (out of MVP scope): deliver route params via NAP-CONFIG values keyed per route, which is
the cleanest fit since config is shell-written and push-updated.

## Napplet scope (MVP)

In:

- live feed of `kind:33500` via `outbox.subscribe([{ kinds: [33500], limit: 60 }])`
- addressable dedup: key `33500:<pubkey>:<d>`, keep highest `created_at`; sort desc
- responsive result grid: cover image, title, summary, tag chips
- cover image via NAP-RESOURCE with skeleton → image → placeholder-on-failure states
- client-side search box filtering loaded objects on `title` / `summary` / `t` tags
- tag chip click = client-side tag filter
- click a result → `intent.open('object-detail', { address })`
- empty / loading / error states in friendly language

Out (explicit non-goals): relay-side NIP-50 search, pagination/infinite scroll, author profile
names (needs `common`/`identity` follow-up), make counts (`count`), blurhash placeholders,
collections, sorting controls.

## Data mapping (from `NIP.md`)

- `title` tag → card title; `summary` tag → card subtitle; `t` tags → chips
- **first `imeta` tag is the cover**; parse space-separated `url ...` / `m ...` / `alt ...` /
  `dim ...` fields out of the tag values
- skip objects with no `title` (malformed) rather than showing raw hex
- never render pubkeys, event IDs, or `d` tags in the UI (AGENTS.md product-UX rule)

## Constraints that will bite

- **`pnpm test:browser` asserts** the browse frame has no `.card` and no `h1`, that
  `main` fits ≤390px on mobile, and that the search input placeholder is exactly
  `"Search phone stands, minis, brackets..."` (`tests/browser/stlstr-ui.test.mjs:54`). Build the
  grid without DaisyUI `.card`, keep the placeholder, or update the tests deliberately.
- No title bars, wrappers, or visible borders — seamless surface (AGENTS.md).
- Must stay a single-file artifact (`artifactMode: 'single-file'`).
- Every domain used must be in `nip5aManifest({ requires })`, and each optional domain must be
  feature-detected via `window.napplet?.<domain>` before use (the pattern already used in
  `create-object`'s `hasStorage()` / `hasIntent()`).
- Object URLs from `resource.bytes` must be revoked on unmount / list churn.

## Tasks

1. ~~**Shell: resource service**~~ — done. `apps/stlstr/src/services/resource.ts` + policy-enforcing
   `fetch` wrapper, registered in `createStlstrAdapter`. (B1)
2. ~~**Shell: intent service**~~ — done. `apps/stlstr/src/services/intent.ts` maps archetype →
   `navigate()`; `create-object` now opens `object-detail`. (B2)
   Covered end-to-end by `tests/browser/nap-handlers.test.mjs`.
3. **Napplet manifest** — `requires: ['outbox', 'resource', 'intent']` in
   `napplets/browse-objects/vite.config.ts`; keep archetype `browse-objects`.
4. **Feed module** — `src/lib/objects.ts`: filter builder, `RelayEventResult` → `PrintableObject`
   parser (title/summary/tags/cover from `imeta`), address dedup + sort.
5. **Cover image component** — `src/lib/CoverImage.svelte`: `resource.bytes(url)` →
   `URL.createObjectURL`, skeleton while pending, placeholder on error, revoke on destroy,
   concurrency-friendly (don't fire 60 fetches at once — cap in-flight ~8).
6. **App.svelte** — subscription lifecycle (`sub.on('event')`, `sub.on('closed')`, `sub.close()` on
   unmount), search/tag filtering, result grid, empty/error states, intent navigation.
7. **Tests** — extend `tests/browser/stlstr-ui.test.mjs` for the rendered grid; keep existing
   assertions green.
8. **Docs** — note the resource grant policy and the SVG-rejection gap in `AGENTS.md`
   "Current Gaps".

Suggested commit split: (1+2) shell services, (3–6) napplet, (7+8) tests and docs.

## Verification

```
pnpm --filter browse-objects verify
pnpm --filter browse-objects test:conformance
pnpm --filter @apps/stlstr lint && pnpm --filter @apps/stlstr build
pnpm test:browser
```

Manual: `pnpm dev`, confirm the home page streams real objects from the configured app relays,
covers load, search filters, and clicking a card lands on `/objects/:pubkey/:d`.

## Open questions for hzrd149

1. Resource grant policy — wildcard-https + host-side SSRF guard (recommended), or restrict to the
   Blossom servers configured in settings?
2. Archetype slug — standardize on `object-detail`?
3. Route-param delivery (`/search?q=`, `/tags/:tag`) — accept the MVP's napplet-owned search now and
   do NAP-CONFIG later, or solve it in this pass?
