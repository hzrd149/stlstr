# Design: `object-detail` napplet

Status: design (pre-build). Consumed by `build-napplet`, verified by `test-napplet`.

Renders a single printable object (`kind:33500`, see [NIP.md](../NIP.md)) as a
Thingiverse-style detail page: gallery, maker attribution, markdown description,
part files, makes, remixes, and comments.

---

## Build spec

```
nappletType: object-detail
purpose: Render one kind:33500 printable object — gallery, description, files, makes, remixes, comments.
NAPs used: outbox (req), inc (req), identity (opt), common (opt), count (opt),
           resource (opt), link (opt), intent (opt), theme (opt), storage (opt)
requires: ['outbox', 'inc']
optional domains and fallbacks:
  resource -> no image bytes; render blurhash/alt placeholder tiles, page still usable
  common   -> show truncated npub instead of display name; no reaction button
  count    -> hide count badges entirely (no zeroes, no spinners)
  identity -> never show the owner-only "Edit" action
  link     -> render file URLs as inert text with a copy-to-clipboard affordance
  intent   -> maker/remix/edit navigation degrades to disabled controls
  theme    -> fall back to the DaisyUI light/dark palette already in index.css
  storage  -> selected tab + gallery index reset on every load
SDK helpers: outbox.query, outbox.subscribe, inc.on, inc.emit, identity.getPublicKey,
             common.getProfile, common.npubEncode, count.query, resource.bytes,
             link.open, intent.open, intent.available, theme.get, theme.onChanged,
             storage.getItem, storage.setItem
config schema: none  (route params arrive over the intent seam, not NAP-CONFIG)
```

### Address delivery — the intent seam

Ported from `../hyprgate-gui` (`apps/shell/src/lib/kehto/intent-window-controller.ts`,
`napplets/feed/src/App.svelte`). NAP-INTENT's SDK surface is **outbound only**
(`invoke`/`open`/`available`/`handlers`/`onChanged`); there is no inbound intent
message. hyprgate's answer, which we adopt verbatim in shape:

> the shell delivers the intent payload as a **targeted `inc.event`** on topic
> `<archetype>:<action>`, gated on a readiness signal from the napplet.

For us:

|                 |                                                                       |
| --------------- | --------------------------------------------------------------------- |
| archetype       | `object-detail` (already declared in `vite.config.ts` `archetypes[]`) |
| delivery topic  | `object-detail:open`                                                  |
| readiness topic | `object-detail:ready` (napplet → shell)                               |
| payload         | `{ address: "33500:<pubkey>:<d>", pubkey, identifier }`               |

Sequence:

1. Napplet mounts, calls `inc.on('object-detail:open', apply)`.
2. Napplet emits `inc.emit('object-detail:ready')` **after** the subscription is
   registered — this is the cold-start race guard (hyprgate "Pitfall 2").
3. Shell flushes the buffered payload to **that iframe only** via targeted
   `postMessage({ type:'inc.event', topic:'object-detail:open', payload, sender:'shell' })`.
   Never a broadcast (hyprgate "Pitfall 1").
4. The subscription stays live, so a later delivery swaps the object in place
   without remounting the iframe.

The payload crosses a trust boundary, so it is **untrusted**: validate shape and
that `address` parses as `33500:<64-hex>:<d>` before applying. Drop invalid
payloads silently.

Deep links and in-app navigation share this one seam:

- **Cold load** (`/objects/:pubkey/:d` pasted directly) — no `intent.invoke`
  happens. The shell buffers `route.params` as the payload and flushes it on
  `object-detail:ready`. Identical code path.
- **In-app** (`browse-objects` → detail) — `intent.open('object-detail', { address })`;
  the resolver pushes the route, then delivers on the same seam.

### Data flow

All reads are `outbox`; nothing here needs relay-local semantics, so there are
**no relay escape hatches**.

| What                      | Query                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| the object                | `{ kinds:[33500], authors:[pubkey], '#d':[identifier] }` — `subscribe`, so an author edit repaints live          |
| part files                | `{ ids: [...e-tag ids] }` for role-marked `e` tags (`part`/`instructions`/`video`/`preview`/`aux`) → `kind:1063` |
| maker profile             | `common.getProfile(pubkey)`                                                                                      |
| makes                     | `{ kinds:[2351], '#a':[address] }`                                                                               |
| remixes                   | `{ kinds:[33500], '#a':[address] }`                                                                              |
| comments                  | `{ kinds:[1111], '#A':[address] }` (NIP-22 root scope)                                                           |
| collections containing it | `{ kinds:[30050], '#a':[address] }`                                                                              |
| counts                    | `count.query` for reactions / comments / makes / remixes — badges only, never download bodies                    |

Publishes: none in this napplet. "Post a make", "Post a remix", and comment
composition are separate napplets reached via `intent.open`.

### Images are a sandbox problem, not a styling problem

`<img src="https://…">` is outside the napplet authority boundary. Every gallery
image, thumbnail, and avatar must go through `resource.bytes(url)` →
`new Blob([bytes])` → `URL.createObjectURL`. Consequences the build must honor:

- Revoke object URLs on swap/unmount or the iframe leaks memory across navigations.
- Load the cover image first, thumbnails lazily as they scroll into view.
- Until bytes land, render the `imeta` `blurhash` if present, else a skeleton
  tile carrying the `alt` text.
- If `resource` is absent, the page still renders — placeholders only.

**Downloads** use `link.open(url)` rather than `resource.bytes`. Pulling a
multi-megabyte STL across `postMessage` just to re-offer it as a blob is waste;
the shell owns the download policy.

### Layout

Two-zone page, adapted from the Thingiverse reference.

**Large (≥1024px)** — the reference layout:

```
┌────────────────────────────────────────────────────────┬──────┐
│ ‹  (avatar) Title                    [Download all ⤓] │      │
│             maker · date                               │ 90   │  ← action rail
├──────────────────────────────────────────┬─────────────┤ ♡ 50K│    remixes,
│                                          │ ▢ thumb     │ ⤓ 2M │    likes,
│            cover / active image          │ ▣ thumb     │ ⊞ 89K│    downloads,
│                                          │ ▢ thumb     │ ↗    │    collections,
│              ‹              ›            │             │      │    share
├──────────────────────────────────────────┴─────────────┤      │
│  Post a make · Post a remix · Report · Open source ↗   │      │
├────────────────────────────────────────────────────────┴──────┤
│ [Details] [Files 3] [Comments 418] [Makes 1.3K] [Remixes 90]  │
├───────────────────────────────────────────────────────────────┤
│  rendered markdown · license · tags                           │
└───────────────────────────────────────────────────────────────┘
```

**Medium** — action rail collapses from a vertical rail into a horizontal row
under the gallery; thumbnails move below the cover as a scrolling strip.

**Tiny (a sidebar or widget, ~320px)** — must stay useful: cover image, title,
maker, and a single primary "Download" button. Tabs collapse to a `select`.
Counts become icon+number chips. No horizontal overflow at any width.

Strategy: CSS grid with `clamp()` sizing and **container queries**, not viewport
media queries — the shell can size this iframe to anything and resize it live,
and container queries are the only thing that reads the actual box. Tailwind 4 +
DaisyUI 5, matching the rest of `napplets/*`.

Per `AGENTS.md`: **no title bar, no card wrapper, no visible outer border** —
this is a seamless surface inside the stlstr shell.

### Theme

NAP-THEME is optional but whole-surface. On `theme.get()` and every
`theme.onChanged`, map `colors.background`/`colors.text` onto `:root`, `html`,
`body`, and the app root, then map primary/surface/border/muted onto the DaisyUI
custom properties. The fallback palette **must set an explicit page background**
so a dark shell never yields a white body behind dark cards.

### Product rules (`AGENTS.md`)

Human-readable everywhere: display names not pubkeys, object titles not `d`
tags, friendly relative dates, "3 files" not event ids. Raw hex, `naddr`, and
JSON appear only behind an explicit "copy / details" affordance.

---

## Required shell changes

These block the napplet; none of it exists yet.

1. **`route.params` is computed but never delivered.** `App.tsx:225-236` builds
   `params: { pubkey, identifier, address }`, and `NappletFrame` (`App.tsx:706`)
   injects only `domains`. Wire the intent seam described above.
2. **Register the intent service.** `createStlstrAdapter` has no `intent` entry.
   Port hyprgate's `bootstrap.ts:744-774` shape using the already-installed
   `@kehto/services@0.16.5`: `createIntentService({ resolver: createCatalogIntentResolver({ loadCatalog, windows, getDefaultHandler }) })`.
3. **Write a routed `IntentWindowController`.** hyprgate's controller creates a
   _window_; stlstr is a _routed_ shell with one iframe. Ours instead
   `history.pushState`es to `/objects/:pubkey/:d`, then buffers + flushes the
   payload on `object-detail:ready`. Same seam, different navigation primitive.
4. **Grant `inc`.** The object-detail route's `domains` list
   (`App.tsx:234`) is `['outbox','identity','common','count','resource','intent','link']`
   — add `inc` (hard requirement), plus `theme` and `storage`.

## Open questions

- **Downloads.** `link.open()` per file is honest but there is no "download all"
  primitive — a real zip would need a shell-side service. Ship per-file
  downloads first and treat "Download all files" as a follow-up?
- **`resource` bandwidth.** Every gallery image crosses `postMessage` as bytes.
  If galleries are large this wants a shell-side image cache; measure before
  optimizing.
- **Comment/make composition** are separate napplets. This page only _links_ to
  them via `intent.open`, so those archetypes must exist before those buttons
  do anything.
