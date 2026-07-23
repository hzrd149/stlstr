# Plan: the preview dialog and the `part-preview` archetype

Status: **built** (phases 1–6) · Target: `apps/stlstr` shell chrome + `napplets/part-preview`

See §10 for what changed between plan and build.

A centered modal that mounts a napplet over the current page, so a user can spin an STL without
leaving the object they were reading. Builds directly on `.planning/intent-architecture.md` — the
dialog is a second delivery surface for the same intent machinery, not a parallel one.

## 1. Decisions

| Question                       | Decision                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Is an open dialog in the URL?  | **Yes, as an overlay query param.** `…?preview=<fileId>` layers on whatever route is beneath. Deep-linkable, back dismisses. |
| What does the payload address? | **A kind-1063 file event id.** `{ fileId }`; the napplet resolves url/mime/hash/name itself over outbox.                     |
| How general is the modal?      | **Hardcoded to `part-preview`.** One `PreviewDialog`, no `presentation` field on `ArchetypeEntry` yet. See §9.               |

The third decision is the one to revisit first: everything below is written so that generalizing to
`presentation: 'route' | 'modal'` later is a field addition and a branch, not a rewrite.

## 2. Constraints verified in the installed packages and in our own code

| Fact                                                                                                                                                                                                             | Evidence                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **`IntentBehavior` carries no presentation hint** — only `focus`, `newWindow`, `reuse`. Modal-vs-route is not something a caller can request on the wire; the shell decides from the archetype.                  | `IntentBehavior` in `@kehto/services` and `@napplet/nap/intent` |
| A query-param change does **not** remount `NappletFrame`. The mount effect keys on `[napplet, routeId, pathname, intentKey]` and the iframe on `key={pathname}`. Adding `?preview=` touches none of them.        | `App.tsx:776`, `App.tsx:781`                                    |
| …**except** on `/search` and `/create`, whose route components derive `intentKey` from `useSearchParams`. Those read only `q` / `remix`, so `preview` still does not disturb them.                               | `SearchRoute`, `CreateRoute` in `App.tsx`                       |
| Each `NappletFrame` installs its **own** `window` message listener and its **own** `ShellBridge`, while `originRegistry` is a module-global singleton. Two mounted frames means every message hits both bridges. | `App.tsx:688-776`; `originRegistry` import                      |
| `createIntentDelivery` already supports handing a new payload to a live napplet (`redeliver`), but `NappletFrame` never calls it — `intentKey` is a mount dep, so a payload change remounts instead.             | `intent-delivery.ts:88`, `App.tsx:756`                          |
| NAP-RESOURCE caps responses at **10 MiB** (`MAX_BYTES`) and there is no MIME allowlist — unrecognized bytes sniff to `application/octet-stream` and pass through. Only `image/svg+xml` is rejected outright.     | `resource.ts:13`, `resource.ts:264`                             |
| Binary STL has no magic number (80-byte free-form header); ASCII STL starts `solid `; 3MF is a ZIP, so it currently sniffs as `application/zip`.                                                                 | `sniffMimeType` in `resource.ts`                                |
| The object-detail napplet already role-marks part files as `e` tags (`part`/`instructions`/`video`/`preview`/`aux`) resolving to kind 1063 — so a file event id is a reference it holds already.                 | `.planning/object-detail-napplet.md` data-flow table            |

Two consequences worth stating plainly before the phases:

1. **The message-listener collision is the real engineering risk of this feature**, not the dialog
   chrome. It is the only thing here that has never run with two frames alive at once. §5.
2. **10 MiB is below the size of a great many STLs.** The preview has to have a designed
   too-large path, not an error state. §6.

## 3. URL shape and `intent-map` changes

```
/objects/<pk>/<d>                      base route only
/objects/<pk>/<d>?preview=<fileId>     same base, dialog open over it
/tags/printers?preview=<fileId>        works over any base — the param is orthogonal
```

`intent-map.ts` gains:

```ts
/** The overlay archetype. Hardcoded: it is the only archetype the shell renders as a dialog. */
export const PREVIEW_ARCHETYPE = 'part-preview';

/** Parses the overlay intent a URL carries, independent of the base route. */
export function overlayFromLocation(location: { search: string }): StlstrIntent | null;

/** Adds/replaces `?preview=` on a URL, preserving the base path and its other params. */
export function previewHref(currentUrl: string, fileId: string): string;

/** Strips `?preview=`, yielding the base href to fall back to when history has no prior entry. */
export function baseHref(currentUrl: string): string;
```

`intentFromLocation` keeps its current signature and meaning — it parses the **base** route and
ignores `preview`. It has no callers outside its own module today, so nothing breaks; the pair
`(intentFromLocation, overlayFromLocation)` is the `{ base, overlay }` split, expressed as two
functions rather than a new return type.

`intentToHref` returns `null` for `part-preview`, correctly: an overlay intent does not name a page
on its own, only a modification of the current one. The intent service special-cases it (§4)
instead of teaching `intentToHref` about ambient location.

## 4. Shell: resolving a `part-preview` intent

In `services/intent.ts`, `invoke` branches before the href step:

```
archetype === 'part-preview'
  → payload must carry a non-empty `fileId`  (else failed(...,'payload does not name a file'))
  → href = previewHref(window.location.pathname + window.location.search, fileId)
  → navigate(href)                            // pushes, so Back closes the dialog
  → result { ok, handled, handler: 'part-preview', windowId: 'overlay-preview-part-preview' }
```

Reading `window.location` here is deliberate and load-bearing: the overlay is defined relative to
wherever the user currently is, and the router's browser history keeps `window.location`
authoritative. Threading the router location through the adapter would mean a new ref in
`NappletFrame` for a value we can read directly.

**The navigation deferral changes meaning.** For route intents the `setTimeout(…, 0)` exists because
navigating unmounts the calling napplet, so the result must be posted first. For an overlay the
caller stays mounted (§2), so the deferral is no longer load-bearing — but keep it anyway, so both
branches settle in the same order and no napplet learns to depend on the difference.

`ARCHETYPES` gains a `part-preview` entry (dTag, title, `actions: ['open']`, `toHref: () => null`)
so `intent.available('part-preview')` and `intent.handlers()` report it truthfully. A napplet must
be able to feature-detect the preview before offering a preview button.

### `PreviewDialog`

Rendered once in `ShellLayout`, beside `<Outlet/>`, so it survives base-route changes:

```tsx
const overlay = overlayFromLocation(useLocation());
…
{overlay && (
  <dialog ref={dialogRef} className="modal modal-open">
    <div className="modal-box max-w-5xl h-[80vh] p-0 overflow-hidden">
      <NappletFrame napplet="part-preview" routeId="overlay-preview" title="Part preview"
                    intent={overlay} fill />
    </div>
    <form method="dialog" className="modal-backdrop"><button onClick={dismiss}>close</button></form>
  </dialog>
)}
```

- `NappletFrame` currently hardcodes `min-h-screen` on the iframe; it needs a `fill` variant
  (`h-full w-full`) so the frame sizes to the dialog box instead of the viewport.
- **Dismissal must go through history, never through `dialog.close()` alone**, or the DOM and the
  URL diverge (closed dialog, `?preview=` still in the bar; Back then re-opens it). One `dismiss()`:
  if we pushed the entry (`history.state.previewPushed`), `navigate(-1)`; otherwise — a cold deep
  link, where there is no prior entry to return to — `navigate(baseHref(...), { replace: true })`.
- Wire `onCancel` (native ESC on `<dialog>`) to the same `dismiss()`, with `preventDefault()`.
- Use `showModal()` in an effect rather than the `modal-open` class alone: it is what gives the
  focus trap, inertness of the page behind, and ESC for free.
- Restore focus to the invoking element on close — the browser does this for `showModal()` only if
  the dialog was opened while that element had focus, which it was not (the click came from inside
  an iframe). Stash `document.activeElement` before opening.

## 5. Two live frames on one `window` — the thing to get right

Today exactly one `NappletFrame` is mounted, so its `window.addEventListener('message')` handler is
free to forward everything to its bridge. With the dialog open there are two, and every napplet
message reaches both. Bridge B receives frame A's message, resolves the sender through the _global_
`originRegistry` to a windowId that is absent from B's own `sessionRegistry`, and lands in
`onUnroutedMessage` at best — at worst a request is serviced twice, once per bridge.

**Fix: scope each frame's listener to its own iframe.** One guard at the top of `handleMessage`:

```ts
const handleMessage = (event: MessageEvent) => {
  if (event.source !== iframeRef.current?.contentWindow) return;
  delivery.observeReady(event);
  shell.handleMessage(event);
};
```

This is correct regardless of how many frames exist and costs nothing. The eventual right shape is
a single shell-wide `ShellBridge` with both frames registered as sessions — worth doing when a
third surface appears, not now.

Verify before building on it: that `originRegistry.register` for two windows in the same document
does not collide, and that unregistering the overlay's windowId on dialog close does not disturb the
base frame's registration.

### Delivering to a dialog that is already open

Clicking a second part while the dialog is open changes only `?preview=`, so nothing remounts — and
nothing delivers, because `NappletFrame` seeds only inside its mount effect. Restructure:

- Mount effect drops `intentKey` from its deps and seeds from a ref (`intentRef.current`), so a
  payload change no longer tears down the frame.
- A second effect calls `delivery.redeliver(intent)` when `intentKey` changes _after_ the first
  seed. `redeliver` already exists for exactly this and re-arms the exactly-once flush.

This keeps three.js and the WebGL context alive across part switches. It also changes base-route
behavior — `/search?q=a` → `/search?q=b` starts redelivering instead of remounting `browse-objects`,
which is better but is a behavior change to an existing napplet. Land it as its own commit so it can
be reverted independently, and cover it in the browse test.

## 6. The `part-preview` napplet

New workspace `napplets/part-preview`, Svelte + Tailwind, `artifactMode: 'single-file'`, following
`napplets/object-detail` as the template.

```
requires: ['outbox', 'inc', 'resource', 'link', 'theme', 'common']
archetypes: [{ slug: 'part-preview', naps: ['napplet:part-preview/open'] }]
```

(Note the `naps` value: convention protocol strings, not domain names — the bug §1 of the intent
architecture doc records against the existing five napplets. Do not reproduce it here.)

**Payload** `{ fileId }` on inc topic `part-preview:open`; emits `part-preview:ready` after
subscribing, never before.

**Flow.** `outbox` request `{ ids: [fileId] }` → kind 1063 → read `url`, `m`, `x`, `size`, `name`
from its tags → `resource.bytes(url)` → parse → render.

**Formats.** STL (binary and ASCII) first; 3MF and OBJ behind the same viewer if the parser cost is
acceptable in a single-file artifact. Sniff from the bytes, not from the 1063 `m` tag — the tag is
publisher-controlled.

**Size.** The 10 MiB `MAX_BYTES` cap is the governing constraint and it will be hit routinely.
Design the too-large path as a first-class state, not an error: read the 1063 `size` tag _before_
fetching, and if it exceeds the cap render the file's metadata plus a `link.open(url)` download
button with an explicit "too large to preview in-app" message. Never start a fetch that is destined
to be rejected mid-stream. (Raising `MAX_BYTES` for model MIME types is a separate decision — it
would loosen the shell's boundary for every napplet, so it is not part of this plan.)

**Viewport.** The napplet must render usably in a dialog box that is ~1000×600 on a desktop and
effectively full-screen on a phone; the design-napplet rule about surviving any viewport applies
with more force here than for a routed page. No fixed pixel dimensions; the canvas sizes to its
container via `ResizeObserver`.

**Bundle.** three.js plus `STLLoader` inlined into a single-file artifact is several hundred KB.
Import from `three/examples/jsm/loaders/STLLoader.js` and pull in only the renderer/scene/camera
pieces used — a namespace import of `three` defeats tree-shaking and roughly doubles it.

**No publishes, no relay escape hatch.** Reads are outbox-only, exactly as object-detail.

## 7. Phases

**Phase 1 — shell can hold two frames.** The listener guard (§5), the `originRegistry` /
`sessionRegistry` two-window verification, and the `fill` variant of `NappletFrame`. No user-visible
change; provable by mounting a second frame in a test.

**Phase 2 — the overlay URL.** `overlayFromLocation` / `previewHref` / `baseHref`, the
`part-preview` entry in `ARCHETYPES`, the overlay branch in `invoke`.

**Phase 3 — `PreviewDialog`.** Chrome, `showModal`, history-based dismissal, focus restore. Point it
at a stub napplet that renders its `fileId` — the dialog is verifiable before any 3D code exists,
and that keeps three.js debugging out of the dialog debugging.

**Phase 4 — redelivery.** The `NappletFrame` seed/redeliver split. Separate commit (§5).

**Phase 5 — the real napplet.** 1063 resolution, resource fetch, size gate, STL parse and render,
then the other formats.

**Phase 6 — wire it up.** `object-detail` gains a preview button per part file, gated on
`intent.available('part-preview')`.

## 8. Tests

Extend `tests/browser/intent-navigation.test.mjs`:

- `intent.open('part-preview', { fileId })` from the detail napplet opens the dialog and puts
  `?preview=` in the URL.
- **The base napplet does not remount** — the strongest signal that the overlay is really an
  overlay. Assert against a value that only survives a live frame (an incrementing counter the stub
  posts on boot), not against DOM presence.
- Cold deep link to `/objects/<pk>/<d>?preview=<id>` opens both the page and the dialog, and the
  payload arrives — the same cold-load path the architecture doc requires of every route.
- ESC, backdrop click, and the close button each restore the base URL exactly.
- Back after opening closes it; Forward re-opens it with the payload re-delivered.
- Changing `?preview=` while open delivers the new payload **without** a remount (Phase 4).
- A payload sent to the overlay does not reach the base napplet, and vice versa — the anti-leak
  assertion that justifies targeted `inc.event` over broadcast.

Unit-level: `baseHref(previewHref(url, id)) === url` across the route table, mirroring the existing
`intentToHref(intentFromLocation(url)) === url` check.

## 10. What changed between plan and build

**The viewer is hand-rolled WebGL, not three.js.** §6 planned a tree-shaken three.js import; what
shipped is `napplets/part-preview/src/viewer.ts` — a shader, a bounding box, and pointer math in
~280 lines. One flat-shaded mesh on a turntable needs no scene graph, and the single-file artifact
is **76 KB total** rather than several hundred. Trade: no OBJ/3MF loader comes for free, so those
formats are now real work rather than an import (§6 listed them as "behind the same viewer").

**`intent-delivery` had a latent bug that only redelivery exposed.** `redeliver` forced
`ready = true` on the grounds that a mounted napplet is listening — but a mounted napplet has not
necessarily _subscribed_ yet, and forcing it posts into a void and sets `delivered`, so nothing
retries. Worse, `observeReady` read the archetype off `pending`, which flush had already cleared —
so the ready signal was missed after the first delivery and every later redelivery waited on a
signal that never comes twice. Both fixed: `seed` and `redeliver` are now one `arm()`, and the
archetype is remembered across flushes.

**`NappletFrame` gained `frameKey`.** The plan had the frame keyed by pathname throughout. The
dialog needs a constant, or a base-route change underneath would destroy an open preview.

**Phase 6 required building a slice of `object-detail`.** It was a static skeleton with no script at
all, so there was nothing to invoke the preview from. It now resolves its object, lists role-marked
`e` tag part files, and offers a Preview button gated on `intent.available('part-preview')` — the
narrow slice of `.planning/object-detail-napplet.md` needed to reach the dialog, and no more.

**Test environment note.** `--use-gl=swiftshader` yields _no_ WebGL context in headless Chromium;
`--enable-unsafe-swiftshader` is the flag that gives the software fallback. Getting this backwards
reads exactly like a broken viewer.

Delivered and covered by `tests/browser/preview-dialog.test.mjs` (8 tests): open-from-intent, URL
overlay, base napplet stays live, no cross-delivery between the two frames, cold deep link,
close/back/forward, deep-link dismissal, and archetype advertisement. The rendered assertion is
strict — it checks the parsed triangle count and the absence of the status line, so it fails if the
bytes never reach a live WebGL context.

Not built: the `?preview=` change-while-open case has redelivery plumbing (§5) but no test, because
fixture objects carry one part file each.

## 11. Open questions

1. **When does the hardcoding stop paying?** The moment a second archetype wants a dialog (a share
   sheet, a comment composer), `PreviewDialog` should become `OverlayDialog` driven by
   `presentation: 'modal'` on `ArchetypeEntry`, with the param generalized from `preview=<id>` to
   `overlay=<archetype>:<payload>`. Worth naming the trigger now so the second case does not get
   hardcoded beside the first.
2. **Should the dialog offer next/prev across an object's parts?** That needs the object address and
   an index, which is precisely the payload shape we declined. If it turns out to matter, it is an
   additive optional `{ address, index }` alongside `fileId`, not a replacement.
3. **`MAX_BYTES` for models.** Leaving it at 10 MiB means a real fraction of parts are
   download-only. Raising it per-MIME is a shell-boundary change affecting every napplet.
4. **Does the preview belong to `object-detail` at all?** A napplet could render an inline viewer
   itself. The dialog wins when the same preview is reachable from browse cards and from search
   results without those napplets each embedding a 3D stack — which is the actual argument for
   making it an archetype, and worth confirming against how browse is meant to feel.
