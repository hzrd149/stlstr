# Design: part management

Status: design (pre-build).

Two new napplets — **`part-upload`** and **`part-library`** — that let a user
manage the files they have published: upload new ones, see what they have,
find out which objects use a given file, and remove ones they no longer want.

Attaching parts to objects from inside `create-object` / `edit-object` is
deliberately **out of scope here** and is deferred to a follow-up; §9 records
what this design leaves ready for it.

---

## 1. What a part is

Per [NIP.md](../NIP.md), a part is **not** a field of an object. It is an
independent [NIP-94](https://github.com/nostr-protocol/nips/blob/master/94.md)
`kind:1063` file metadata event, referenced from a `kind:33500` object by an
ordered, role-marked `e` tag:

```json
["e", "<1063-event-id>", "<relay-hint>", "part"]
```

Four properties of the protocol drive every decision below. None of them are
choices we get to make.

### 1.1 The role belongs to the reference, not to the file

NIP.md: _"The fourth element of the `e` tag is a role marker."_ The role describes
what the file is **to that object**, so it belongs on the reference — the same
file event can legitimately be a `part` in one object and `aux` in another, and
putting the role on the file would make that unrepresentable. This is the right
model, and nothing below proposes changing it.

It does, though, decide the shape of both napplets, because neither of them is
looking at a file through an object:

- **`part-upload` cannot ask for a role.** There is nowhere to put the answer —
  the role is chosen at attach time, by whichever object is doing the attaching.
- **`part-library` cannot filter or group by role.** All it has is the `m` MIME
  tag and the filename. It can guess "this looks like a model", but it cannot
  know how any object is actually using it without running the §1.4 usage query.
- **The model these two napplets hold is a file, not a part.** "Part" is the right
  product language and the right archetype prefix; the data model just carries no
  role field, because at this layer there is no single answer to what the role is.

### 1.2 A `kind:1063` is a regular event

It cannot be edited in place. Correcting a file's name or notes means publishing
a **new** event and repointing whatever references it. The old event stays valid
for anyone else who references it.

### 1.3 A part is referenced, not owned

The NIP is explicit: _"Clients SHOULD allow objects to reference NIP-94 file
events authored by other users. This enables multiple objects to share the same
part file."_ A file may be referenced by objects you cannot see, authored by
people you do not know, on relays you do not read.

This is what makes deletion genuinely hazardous rather than merely irreversible.
See §6.

### 1.4 Usage is a documented query

NIP.md §Queries, "Find objects using a specific file event":

```json
{ "kinds": [33500], "#e": ["<1063-event-id>"] }
```

`e` is relay-indexed, and this query is not author-scoped, so it finds other
people's objects too — as far as the relays we read reach. This is both the
"what is this used in" feature and the safety gate before removal.

---

## 2. Review: what exists today

### 2.1 There is no file management of any kind

Nothing queries `kind:1063` except to resolve a specific part for display
(`object-detail`) or preview (`part-preview`). There is no list view, no upload
path outside the create-object wizard, no usage lookup, and no removal.

`kind:1063` events are only ever created as a side effect of publishing an
object, which means a user's files are invisible to them and only reachable
through the objects that happen to reference them.

### 2.2 Published parts have no name — shipping defect

`create-object/src/App.svelte:195` builds NIP-94 tags as `url`, `m`, `x`, `ox`,
`size`, `dim`, `fallback`. It never emits `name`. Both consumers read it:

- `object-detail/src/App.svelte:135` — `tagValue(event.tags, 'name') || 'Part file'`
- `part-preview/src/App.svelte` — `value('name') || value('alt') || basename(url)`

An object published through the real app lists its parts as identical rows
reading "Part file". This is invisible in CI because
`scripts/lib/test-fixtures.mjs:132` writes `['name', '<identifier>.stl']` by
hand — the fixture is more correct than the code that ships.

This is a hard prerequisite for `part-library`: a library of files with no names
is not a library. Fix it first.

### 2.3 Partial publish failures orphan events silently

`create-object`'s `publishObject()` loops uploads and `kind:1063` publishes, then
publishes the object. A failure on file 4 of 5 throws out of the whole function.
Files 1–3 are already uploaded **and** already published as `kind:1063` events —
they persist on the relays — but the napplet has forgotten them, so a retry
re-uploads and re-publishes all five.

Every one of those abandoned events is invisible today. Once `part-library`
exists they become visible, which is a feature: the library is where orphans and
duplicates surface. It is also why §5.4 exists.

### 2.4 Adjacent gap: parts cannot be downloaded

`object-detail` renders a Preview button and nothing else. `part-preview` has a
NAP-LINK download, but it sits inside a modal reachable only by previewing first
— and preview refuses files over 10 MiB, which is most real parts. So a user who
finds a 40 MB STL has no way to get it. `object-detail/vite.config.ts` does not
request `link`.

`part-library` should not repeat this: download is a first-class row action.

### 2.5 Adjacent gap: `archetypes.naps` on `edit-object` is malformed

`napplets/edit-object/vite.config.ts:18` reads
`naps: ['outbox', 'identity', 'upload', 'resource']` — NAP domain names in a field
that takes convention ids. Every other napplet uses `napplet:<slug>/<action>`. It
should be `['napplet:edit-object/open', 'napplet:edit-object/edit']`. Worth
fixing alongside, since two new napplets are about to be written and this is the
example they would be copied from.

---

## 3. The two napplets

| Napplet        | Archetype      | Route           | Analogous to    |
| -------------- | -------------- | --------------- | --------------- |
| `part-upload`  | `part-upload`  | `/parts/upload` | `create-object` |
| `part-library` | `part-library` | `/parts`        | `browse`        |

The split mirrors the object side exactly, and for the same reason: publishing is
a focused, linear, write-heavy flow with a signer requirement, while browsing is
a read-heavy destination that must work while signed out of nothing in
particular. Keeping them separate keeps the library's bundle free of the upload
machinery.

Both are **destinations**, not pickers. That matters: the earlier concern that a
picker napplet cannot return a selection (NAP-INTENT is outbound-only and
`services/intent-delivery.ts` provides no reply channel) does not apply to either
of these. Neither needs to hand a value back to a caller. A future "attach an
existing part" picker still does — see §9.

### 3.1 Shell wiring

Both need entries in `apps/stlstr/src/services/intent-map.ts` and mounting
routes in `App.tsx`:

```ts
'part-library': {
  dTag: 'part-library', routeId: 'part-library', nav: 'parts',
  actions: ['open'],
  toHref: () => '/parts',
},
'part-upload': {
  dTag: 'part-upload', routeId: 'part-upload',
  actions: ['open', 'create'],
  toHref: () => '/parts/upload',
},
```

plus `intentFromLocation` cases for `/parts` and `/parts/upload`.

### 3.2 The nav bar

`part-library` is a top-level destination and gets a **Parts** entry in the main
nav, after Create and before Settings — it is a maker-side tool, so it belongs
next to Create rather than next to Browse.

One trap here. `ArchetypeEntry.nav` looks like it drives the nav bar and does
not: it is declared on the type, set on `browse` and `create`, and **read by
nothing**. The bar is a hardcoded list of `ShellNavLink`s at `App.tsx:1165`. So
adding `nav: 'parts'` to the archetype entry has no visible effect on its own —
the link has to be added to that list:

```tsx
<ShellNavLink to="/" label="Browse" alsoActiveOn={/^\/(search|tags)(\/|$)/} />
<ShellNavLink to="/create" label="Create" />
<ShellNavLink to="/parts" label="Parts" alsoActiveOn={/^\/parts(\/|$)/} />
<ShellNavLink to="/settings" label="Settings" />
```

`alsoActiveOn` keeps Parts highlighted while the user is on `/parts/upload`,
which is the same section under different framing — the same reason Browse stays
lit on `/search` and `/tags/*`.

The entry is shown whether or not anyone is signed in, matching Create, which is
also visible while signed out even though publishing needs a signer. The library
handles the signed-out case as an empty state pointing at sign-in (§5.1); hiding
the nav entry instead would make the feature undiscoverable to exactly the people
who have not signed in yet.

Adding a third hardcoded entry is a reasonable moment to either wire `nav` up for
real or delete it, but that is a tidy-up and not a prerequisite. Note that
deriving the whole bar from `ARCHETYPES` cannot be total: `/settings` is
shell-native and has no archetype.

---

## 4. `part-upload`

**Purpose.** Publish one or more files as `kind:1063` events, independently of
any object.

```
requires: ['upload', 'outbox', 'identity', 'intent']
```

No `storage` — unlike the object wizard there is no long text draft worth
persisting, and `File` handles cannot be persisted anyway.

### 4.1 Flow

1. Select one or more files.
2. Per file: an editable **name** (defaulting to the filename) and an optional
   **description**, which becomes the event's Markdown `.content`.
3. Hash each file locally, then check for an existing event (§4.3).
4. Upload over NAP-UPLOAD, publish a `kind:1063` per file.
5. Navigate to `part-library` via `intent.open`, the same way `edit-object`
   now lands on `object-detail` after publishing.

**No role selector**, per §1.1. If a role affordance is ever wanted it belongs in
the attach flow, not here.

### 4.2 Published tags

```json
{
  "kind": 1063,
  "content": "<description — Markdown, per NIP.md>",
  "tags": [
    ["url", "<blossom url>"],
    ["m", "model/stl"],
    ["x", "<sha256>"],
    ["size", "<bytes>"],
    ["name", "<filename>"],
    ["fallback", "<other blossom url>"]
  ]
}
```

`name` is the fix from §2.2 and is not optional here.

### 4.3 Deduplication

Blossom is content-addressed, so re-uploading a file is cheap and yields the same
blob. Publishing a **second** `kind:1063` for it is not cheap: it splits the
file's identity, so NIP-22 comments and NIP-25 reactions on the file scatter
across two events, and the library fills with rows that look like different files
and are not.

Before uploading, hash with `crypto.subtle.digest('SHA-256', …)` and query
`{ kinds: [1063], '#x': [hash], authors: [me] }`. `x` is a single-letter tag and
therefore relay-indexed, so this is cheap. On a hit, show the existing event and
offer to reuse it rather than publishing again.

Two caveats:

- Compare the local hash against the `sha256` the upload actually returns. They
  diverge if a Blossom server transforms the file. For models it will not, but the
  comparison is what makes that safe rather than assumed.
- **Verify `crypto.subtle` is reachable inside a sandboxed `srcdoc` frame before
  building on it.** The frame has an opaque origin; an opaque-origin child of a
  secure context should itself be a secure context, but this needs confirming
  empirically, not reasoning about. If it is unavailable, dedupe degrades to
  post-upload detection — upload first, then match on the returned `sha256` — which
  still prevents the duplicate _event_, just not the duplicate transfer.

### 4.4 Failure handling

Per-file state, kept across retries. A file that has already published its
`kind:1063` is marked done and is not re-uploaded when the user retries the ones
that failed. This is the §2.3 defect, not repeated.

---

## 5. `part-library`

**Purpose.** The user's own files: what exists, where each is used, and what to
remove.

```
requires: ['outbox', 'identity', 'inc', 'intent', 'link', 'count']
```

`link` for downloads (§2.4), `intent` to hand a file to `part-preview` and to
reach `part-upload`, `count` for usage badges without pulling every referencing
object, `inc` for the intent payload seam.

### 5.1 The list

`outbox.query([{ kinds: [1063], authors: [me] }])`, newest first.

Signed out, the page is an empty state pointing at sign-in — NAP-IDENTITY is the
only source for who the user is, and with no pubkey there is no query to run.

Per row: name (falling back to the URL basename), size, MIME, publication date,
usage count badge, and actions:

- **Preview** — `intent.open('part-preview', { fileId })`, feature-detected with
  `intent.available` exactly as `object-detail` does. Hidden for non-model files
  and for files above the 10 MiB preview ceiling, which the row already knows
  from the `size` tag.
- **Download** — `link.open(url, { label: name })`.
- **Used in** — expands the row (§5.2).
- **Remove** — §6.

### 5.2 "Used in"

`outbox.query([{ kinds: [33500], '#e': [fileId] }])` per §1.4, resolved to object
titles and addresses, each linking through `intent.open('object-detail', …)`.

Two honesty requirements in the copy:

- The list is **not author-scoped**. Someone else's object appearing here is
  correct and expected, and the UI should show the author rather than implying
  everything listed is the user's own.
- The list is **what our relays know**, not the truth. Absence of results is not
  evidence of absence. This matters most immediately before removal.

A `count.query` on the same filter gives the badge without fetching the objects,
so the expensive query only runs when a row is expanded.

### 5.3 A detail page is deliberately not built

Expanding a row covers "what is this used in". A separate `part-detail`
archetype would be the right home for public file pages with NIP-22 comments —
the NIP provides for comments on individual part files — but nothing asks for
that yet, and `part-preview` already occupies the "look at one file" slot.

### 5.4 Duplicates and orphans

The library is where the mess becomes visible, so it should name it rather than
just displaying it:

- **Duplicates** — group rows sharing an `x` value and mark them. These are the
  §4.3 case that already happened, plus anything created before dedupe existed.
- **Orphans** — a usage count of zero. Often that is fine (just uploaded, not yet
  attached), so this is a filter, not a warning.

---

## 6. Removal — the hard part

This is where the design has to be most careful, and where the honest answer is
smaller than the word "delete" implies.

### 6.1 The shell cannot delete the bytes

**NAP-UPLOAD has no delete operation.** Its entire surface is `info`, `upload`,
`status`, `onStatus`. A napplet can put bytes on a Blossom server and can never
take them off. Blossom itself defines blob deletion (BUD-02 `DELETE /<sha256>`,
authenticated), but no NAP exposes it, so nothing inside the sandbox can reach it.

So "remove a part" means exactly one thing: **publish a NIP-09 `kind:5` deletion
request for the `kind:1063` event.** The file remains on every Blossom server it
was uploaded to, at a URL that still works, for anyone who has it.

The UI must say this. Call the action **"Remove from library"**, not "Delete
file", and state plainly that the file itself stays hosted. A user who removes a
part believing the bytes are gone has been actively misled by us, and it is the
kind of mistake they only discover when it matters.

Getting real blob deletion needs either a NAP-UPLOAD extension upstream, or a
shell-native storage manager outside the napplet sandbox (the shell holds the
signer and can issue the BUD-02 auth itself). Both are out of scope; see §8.

### 6.2 NIP-09 is a request, not a guarantee

Relays may honour a `kind:5`, may ignore it, and other relays holding the event
will never see it. The event may already be cached by clients. Removal is
best-effort and the copy should not overstate it.

### 6.3 Removal is gated on usage

Because files are shared (§1.3), removing one can break objects — including
objects belonging to other people, which the user cannot see and we cannot
enumerate.

The gate:

1. Run the §1.4 usage query at the moment of the click, not from the cached badge.
2. If **any** object references it, show them, and require an explicit
   confirmation naming the count.
3. If any referencing object has a **different author**, say so specifically.
   This is the case where the damage lands on someone else.
4. Never offer bulk removal. There is no version of "remove 12 files" where the
   user has meaningfully consented to each consequence.

The usage query is advisory — it reflects the relays we read. The confirmation
copy should say so rather than presenting a clean "used in 0 objects" as proof.

### 6.4 What is emitted

```json
{
  "kind": 5,
  "tags": [
    ["e", "<1063-event-id>"],
    ["k", "1063"]
  ],
  "content": "<optional reason>"
}
```

`outbox.publish` applies no kind restriction, so nothing shell-side blocks this.

---

## 7. Shared code

`create-object` already contains the NIP-94 tag construction these napplets need,
and `edit-object` contains a byte-identical copy. `part-upload` would be the
third. `lib/napplet-kit` already exists (`profiles.ts`, `MakerLink.svelte`), so
the pattern is established.

Into the kit:

- `nip94TagsFromUpload(result, file, name)` — including `name`, fixing §2.2 in one
  place for all three call sites.
- `readFileMeta(tags)` — the `kind:1063` reader, currently duplicated in
  `part-preview` and partially in `object-detail`.
- `publishFileEvent(...)` — hash, dedupe check, upload, publish.
- `formatBytes(bytes)` — currently duplicated verbatim in `object-detail` and
  `part-preview`.

Migrating `create-object` and `edit-object` onto it is what makes the `name` fix
land everywhere instead of only in the new code.

---

## 8. Phasing

| Phase | Work                                                                                | Notes                                                           |
| ----- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1     | Kit file module + `name` tag fix; migrate `create-object`; fix `edit-object` `naps` | Prerequisite. A library of unnamed files is not worth building. |
| 2     | `part-upload` napplet, archetype, route, nav                                        | Includes dedupe (§4.3) and per-file retry (§4.4).               |
| 3     | `part-library` list, preview, download, usage badges and expansion                  | Read-only. Delivers most of the ask with none of the risk.      |
| 4     | Removal with the §6.3 usage gate, and honest copy about §6.1                        | Separate phase on purpose — it is the only irreversible action. |
| 5     | Duplicate grouping and orphan filter                                                | Needs the library to exist before the mess is visible.          |

Deliberately **not** scheduled: real Blossom blob deletion (§6.1), attach-existing
in the object editors (§9), public file libraries on profiles, `part-detail`.

---

## 9. What this leaves ready for attach-existing

The follow-up — attaching an already-published file to an object from
`create-object` / `edit-object` — is unblocked by this work but not delivered
by it. Two things it will need that are worth knowing now:

- **`edit-object` cannot currently touch parts at all.** `MUTABLE_TAGS`
  (`edit-object/src/App.svelte:43`) omits `e`, so every file reference is captured
  into `preservedTags` and re-emitted verbatim. Making `e` mutable means the
  editor must round-trip **every** `e` tag including roles it does not render, or
  changing an object's title will silently drop its instruction PDFs —
  unrecoverably, since the replacement supersedes the prior version.
- **A picker cannot be its own napplet.** NAP-INTENT is outbound-only and
  `intent-delivery.ts` is a one-way seam, so a picker napplet could be opened and
  could never hand a selection back. It has to live inside the editor, unless a
  reply convention is designed at the NAP level.

---

## 10. Settled decisions

No open questions remain. These were raised, decided, and are recorded here so
the reasoning is not relitigated.

1. **Blob deletion — accept NIP-09 only.** Removal publishes a `kind:5` for the
   `kind:1063`; the bytes stay on every Blossom server they reached, because
   NAP-UPLOAD has no delete and nothing in the sandbox can issue BUD-02 auth
   (§6.1). This is acceptable, on the condition that the UI says so: the action is
   **"Remove from library"** and the copy states the file remains hosted. A
   shell-native storage manager could do real blob deletion later, since the shell
   holds the signer; it is not scheduled.
2. **Library scope — all of the user's `kind:1063` events**, with a "models only"
   filter. Since role is not on the event (§1.1), a narrower default would hide
   the user's own instruction PDFs from the only place they can manage them.
3. **Archetype naming — `part-upload` and `part-library`**, matching the `part-`
   prefix `part-preview` already uses. The internal model still holds files rather
   than parts, which is a deliberate and harmless mismatch: "part" is what users
   call these and what the object side calls them.
4. **`part-library` is a main-nav destination** (§3.2), shown signed in or out.

---

## 11. Testing

The browser suite runs against the long-lived local relay. `kind:1063` is a
**regular** event, so unlike `kind:33500` a test that publishes one cannot shadow
a fixture — but a `kind:5` deletion emitted against a fixture file event is
permanent for that relay, and every fixture object references one
(`test-fixtures.mjs:123`).

So removal tests need a **dedicated fixture file event that no object
references** and that nothing else asserts on. Usage-gate tests need a second one
that **is** referenced, ideally by an object belonging to a different fixture
maker, to exercise the §6.3 cross-author warning.

Worth covering:

- A file published by `part-upload` carries a `name` tag, and `part-library`
  and `object-detail` both render it.
- Uploading the same file twice offers reuse instead of publishing a second event.
- "Used in" lists an object authored by a different maker.
- Removal is blocked behind confirmation when usage is non-zero, and the
  confirmation names the count.
- A partial upload failure leaves already-published files published.
