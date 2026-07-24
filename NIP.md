# NIP: Printables

`draft` `optional`

This NIP defines events for publishing 3D printables on Nostr. It is intended for Thingiverse-like clients where a top-level printable contains a description, image gallery, references to printable part files, user makes, and user collections.

The design reuses existing Nostr primitives where possible:

- [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) `imeta` tags for printable and make images.
- [NIP-94](https://github.com/nostr-protocol/nips/blob/master/94.md) `kind:1063` file metadata events for reusable files such as STL, 3MF, PDFs, videos, slicer profiles, and other non-image resources.
- [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) comments for printable, make, and file discussion.
- [NIP-25](https://github.com/nostr-protocol/nips/blob/master/25.md) reactions.
- [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) list/set semantics for user collections.

## Kinds

| kind    | name                 | type        |
| ------- | -------------------- | ----------- |
| `33500` | Printable            | addressable |
| `2351`  | Make                 | regular     |
| `30050` | Printable Set        | addressable |

## Markdown Content

The `.content` field of `kind:33500` printables and `kind:2351` makes is Markdown, as is the `.content` of the `kind:1063` file metadata events a printable references.

Content SHOULD be [CommonMark](https://spec.commonmark.org/). Clients MAY additionally support the [GitHub Flavored Markdown](https://github.github.com/gfm/) extensions for tables, task lists, strikethrough, and autolinks.

Clients that render Markdown SHOULD support at least headings, paragraphs, emphasis, inline code, fenced code blocks, ordered and unordered lists, block quotes, links, images, and thematic breaks.

This content is authored by arbitrary third parties and read by clients that may hold the reader's keys, so rendering it is a security boundary:

- Clients MUST NOT render raw HTML embedded in `.content`. Inline and block HTML SHOULD be shown as literal text or dropped; it MUST NOT be inserted into the document.
- Clients MUST refuse link and image destinations whose scheme is not `http`, `https`, `mailto`, or `nostr`. In particular, `javascript:` and `data:` destinations MUST NOT be rendered as links or loaded as images.
- Clients SHOULD treat relative link and image destinations as invalid. An event has no base URL, so a relative destination resolves against the client's own origin rather than anything the author meant.
- Clients MAY defer, proxy, or refuse remote images referenced from Markdown. Loading them directly discloses the reader's IP address to whatever host the author chose.

Images embedded in `.content` are illustrations within the description. They are not part of the printable's gallery: the ordered `imeta` tags defined below are the printable's image set, and clients SHOULD NOT promote a Markdown image into it.

Clients MAY render `nostr:` URIs and [NIP-21](https://github.com/nostr-protocol/nips/blob/master/21.md) entities as mentions. Clients that do not MUST render them as plain text.

Clients that do not render Markdown SHOULD display `.content` as plain text.

## Printable

A printable is an addressable event of kind `33500`.

Its `.content` field is a Markdown description of the printable, as defined in [Markdown Content](#markdown-content). It MAY include print instructions, assembly notes, attribution, changelogs, or any other human-readable information.

```json
{
  "kind": 33500,
  "content": "Markdown description and print instructions.",
  "tags": [
    ["d", "adjustable-phone-stand"],
    ["title", "Adjustable Phone Stand"],
    ["summary", "A folding phone stand printable without supports."],
    ["published_at", "1735689600"],
    [
      "imeta",
      "url https://cdn.example/cover.jpg",
      "m image/jpeg",
      "x <sha256>",
      "dim 1600x1200",
      "alt Phone stand printed in blue PLA"
    ],
    [
      "imeta",
      "url https://cdn.example/gallery-1.jpg",
      "m image/jpeg",
      "x <sha256>",
      "dim 1600x1200",
      "alt Side view of the hinge"
    ],
    ["e", "<kind-1063-stl-event-id>", "wss://relay.example", "part"],
    ["e", "<kind-1063-pdf-event-id>", "wss://relay.example", "instructions"],
    ["license", "CC-BY-4.0"],
    ["t", "phone-stand"],
    ["t", "desk"],
    ["i", "https://www.printables.com/model/12345-adjustable-phone-stand"]
  ]
}
```

### Required Tags

- `d`: unique identifier for this author's printable.
- `title`: display title.

### Recommended Tags

- `summary`: short printable summary.
- `published_at`: Unix timestamp, as a string, for the first publication time.
- `imeta`: one or more image metadata tags. Image `imeta` tags are ordered; the first image is the cover image and subsequent images are gallery images.
- `e`: references to NIP-94 `kind:1063` file metadata events for non-image resources.
- `license`: license identifier, preferably an SPDX identifier such as `CC-BY-4.0`, `CC0-1.0`, or `MIT`.
- `t`: category or search tags.

### Image Metadata

All printable images SHOULD be represented as `imeta` tags on the printable event itself. Clients implementing this NIP MUST treat image `imeta` tags as the printable's ordered image gallery even when the image URLs are not present in `.content`.

The first image `imeta` tag is the cover image. Additional image `imeta` tags are gallery images.

Image `imeta` tags SHOULD include fields from NIP-92 and NIP-94 where available, especially:

- `url`
- `m`
- `x`
- `dim`
- `blurhash`
- `alt`
- `fallback`

Printable images SHOULD NOT require separate NIP-94 events. NIP-94 file metadata events are reserved for resources that benefit from independent referencing, reuse, or file-specific discussion.

### File References

Non-image printable resources SHOULD be published as NIP-94 `kind:1063` file metadata events and referenced from the printable using `e` tags.

The fourth element of the `e` tag is a role marker:

```json
["e", "<1063-event-id>", "<relay-hint>", "<role>"]
```

Defined roles:

| role           | meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `part`         | printable or manufacturing file, such as STL or 3MF        |
| `video`        | video related to the printable                             |
| `instructions` | PDF, HTML, or other standalone instruction document        |
| `preview`      | non-image preview, such as an animated/video preview       |
| `aux`          | auxiliary resource, such as slicer profiles or setup files |

Clients MAY ignore unknown roles. Clients that do not understand this NIP can still treat these as normal `e` references.

File events SHOULD carry a `name` tag holding the file's name, including its extension:

```json
["name", "phone-stand-body.stl"]
```

NIP-94 does not define `name`; this NIP adds it, because a printable file's name is meaningful to the person downloading it in a way a URL is not. Publishers uploading to content-addressed storage in particular MUST NOT rely on the URL to carry the name, since it encodes a hash. Clients SHOULD fall back to `alt`, then to the final path segment of `url`, when no `name` is present.

### Imported Source URL

Printables imported from another platform MAY include an `i` tag pointing to the canonical source URL:

```json
["i", "https://www.thingiverse.com/thing:1234567"]
```

The URL SHOULD be normalized and SHOULD NOT include a fragment. Native Nostr-first printables SHOULD omit this tag unless they intentionally mirror an external page.

Clients MAY use this tag to show provenance, link to the source page, detect duplicate imports, or group mirrors of the same external printable.

### Remixes and Derivations

Printables that remix, derive from, or depend on another printable SHOULD reference the parent printable with an `a` tag:

```json
["a", "33500:<pubkey>:<d>", "<relay-hint>", "remix"]
```

Clients MAY ignore unknown `a` tag markers. Clients can query remixes of a printable using `#a` filters.

### File Thumbnails

A printable file has no inherent preview. STL carries only raw geometry, and rendering one requires parsing the whole file and drawing it — which a client cannot reasonably do for every entry in a list, and cannot do at all for files too large to fetch.

Publishing clients SHOULD therefore include a `thumb` tag on `kind:1063` file events for printable parts, using the NIP-94 fields:

```json
["thumb", "https://cdn.example/phone-stand-body.png", "<sha256>"],
["image", "https://cdn.example/phone-stand-body-large.png", "<sha256>"],
["blurhash", "<blurhash>"],
["alt", "Rendered view of the phone stand body"]
```

- `thumb`: a small preview with the same aspect ratio as `image`. This is what clients render in file lists.
- `image`: a larger preview, for a file detail view.
- `blurhash`: a placeholder to show while the preview loads.
- `alt`: a description of the preview, for accessibility.

Thumbnails SHOULD be a raster format such as `image/png`, `image/webp`, or `image/jpeg`. Clients that refuse to render SVG — a reasonable policy, since SVG is an active document format — would otherwise be unable to show the preview at all.

A thumbnail MAY be rendered by the publishing client from the file's geometry, or extracted from formats that already embed one, such as the thumbnail image inside a 3MF package or the preview a slicer writes into G-code. An extracted thumbnail SHOULD be preferred, because it depicts what the author's own tooling produced.

Thumbnails are **not** part of the printable's image gallery. The printable's ordered `imeta` tags are its gallery, as defined in [Image Metadata](#image-metadata); clients SHOULD NOT promote a file thumbnail into it, in the same way they do not promote images embedded in Markdown.

A thumbnail is author-supplied metadata and is not verifiable against the file it describes: nothing prevents a `thumb` that depicts geometry the file does not contain. Clients MUST NOT present a thumbnail as evidence of what a file will print, and SHOULD apply the same fetching policy they apply to any other remote image referenced by an untrusted author.

Clients SHOULD fall back to a placeholder derived from the file's `m` type or filename when no thumbnail is published. Files with no meaningful visual form, such as slicer profiles, are expected to have none.

### Optional Print Metadata on File Events

Print details MAY be written in the printable's Markdown description or in the `.content` field of referenced NIP-94 file metadata events.

NIP-94 file events MAY also include custom tags for common print metadata. These tags are optional and MUST NOT be required for a valid printable or part.

Examples:

```json
[
  ["material", "PLA"],
  ["layer_height", "0.2mm"],
  ["infill", "15%"],
  ["supports", "no"],
  ["nozzle_temp", "205C"],
  ["bed_temp", "60C"],
  ["print_time", "3h20m"]
]
```

Example NIP-94 part event:

```json
{
  "kind": 1063,
  "content": "Print flat on the large face. No supports required.",
  "tags": [
    ["url", "https://blossom.example/phone-stand-body.stl"],
    ["m", "model/stl"],
    ["x", "<sha256>"],
    ["size", "1234567"],
    ["name", "phone-stand-body.stl"],
    ["thumb", "https://cdn.example/phone-stand-body.png", "<sha256>"],
    ["blurhash", "<blurhash>"],
    ["alt", "Rendered view of the phone stand body"],
    ["material", "PLA"],
    ["layer_height", "0.2mm"],
    ["supports", "no"]
  ]
}
```

## Make

A make is a regular event of kind `2351`. It represents a user's print, build, remix attempt, or physical result for a printable.

Its `.content` field is Markdown, as defined in [Markdown Content](#markdown-content), and MAY include print settings, build notes, problems encountered, or a story about the make.

Makes MUST reference the printable with an `a` tag:

```json
["a", "33500:<pubkey>:<d>", "<relay-hint>"]
```

Make images SHOULD be represented as ordered `imeta` tags on the make event. Make photos SHOULD NOT require separate NIP-94 events.

Example:

```json
{
  "kind": 2351,
  "content": "Printed in PETG at 0.2mm. The hinge was tight at first but loosened after a few cycles.",
  "tags": [
    ["a", "33500:<pubkey>:adjustable-phone-stand", "wss://relay.example"],
    ["published_at", "1735776000"],
    [
      "imeta",
      "url https://cdn.example/make-1.jpg",
      "m image/jpeg",
      "x <sha256>",
      "dim 1600x1200",
      "alt Finished blue PETG phone stand on a desk"
    ],
    ["t", "petg"]
  ]
}
```

Makes are regular events, so a user MAY publish multiple makes for the same printable. Makes MAY have their own comments using NIP-22.

## Printable Set

A printable set is an addressable NIP-51-style set of kind `30050`. It is used for user-created collections of printables.

Printable sets MUST use `a` tags to reference `kind:33500` printables.

They SHOULD follow NIP-51 set conventions for metadata tags:

- `d`: set identifier.
- `title`: display title.
- `image`: collection image.
- `description`: collection description.
- `a`: printable address.
- `t`: optional category tags.

Example:

```json
{
  "kind": 30050,
  "content": "",
  "tags": [
    ["d", "desk-accessories"],
    ["title", "Desk Accessories"],
    ["description", "Useful printables for a cleaner desk."],
    ["image", "https://cdn.example/desk-accessories.jpg"],
    ["a", "33500:<pubkey-a>:adjustable-phone-stand", "wss://relay.example"],
    ["a", "33500:<pubkey-b>:cable-clip", "wss://relay.example"],
    ["t", "desk"]
  ]
}
```

Private collection items MAY be stored in encrypted `.content` using the private item mechanism defined by NIP-51.

## Comments and Reactions

Comments SHOULD use NIP-22 `kind:1111`.

For comments on a printable, the root scope is the printable address:

```json
[
  ["A", "33500:<pubkey>:<d>", "<relay-hint>"],
  ["K", "33500"],
  ["P", "<printable-author-pubkey>", "<relay-hint>"],
  ["a", "33500:<pubkey>:<d>", "<relay-hint>"],
  ["k", "33500"],
  ["p", "<printable-author-pubkey>", "<relay-hint>"]
]
```

For comments on a make, the root scope is the make event id:

```json
[
  ["E", "<make-event-id>", "<relay-hint>", "<make-author-pubkey>"],
  ["K", "2351"],
  ["P", "<make-author-pubkey>", "<relay-hint>"],
  ["e", "<make-event-id>", "<relay-hint>", "<make-author-pubkey>"],
  ["k", "2351"],
  ["p", "<make-author-pubkey>", "<relay-hint>"]
]
```

For comments on an individual part file, use the NIP-22 pattern for comments on NIP-94 files.

Reactions SHOULD use NIP-25 `kind:7` with the appropriate printable, make, or file reference.

## Queries

Browse printables:

```json
{ "kinds": [33500] }
```

Fetch one printable by address:

```json
{ "kinds": [33500], "authors": ["<pubkey>"], "#d": ["<d>"] }
```

Fetch resources referenced by a printable:

```json
{ "ids": ["<1063-event-id>"] }
```

Find all makes of a printable:

```json
{ "kinds": [2351], "#a": ["33500:<pubkey>:<d>"] }
```

Find printables using a specific file event:

```json
{ "kinds": [33500], "#e": ["<1063-event-id>"] }
```

Find remixes of a printable:

```json
{ "kinds": [33500], "#a": ["33500:<pubkey>:<d>"] }
```

Find printables imported from a source URL:

```json
{ "kinds": [33500], "#i": ["https://www.printables.com/model/12345-adjustable-phone-stand"] }
```

Find a user's printable sets:

```json
{ "kinds": [30050], "authors": ["<pubkey>"] }
```

## Client Behavior

Clients SHOULD render `.content` as Markdown, subject to the rules in [Markdown Content](#markdown-content).

Clients SHOULD render the first image `imeta` tag on a printable as the cover image.

Clients SHOULD render remaining image `imeta` tags as the gallery.

Clients SHOULD resolve role-marked `e` tags to NIP-94 file metadata events before presenting downloads.

Clients SHOULD allow printables to reference NIP-94 file events authored by other users. This enables multiple printables to share the same part file.

Clients SHOULD render a file's `thumb` tag when listing files, and SHOULD fall back to a placeholder derived from `m` or `name` when there is none. See [File Thumbnails](#file-thumbnails).

Clients that publish files SHOULD write a `name` tag, and SHOULD generate or extract a `thumb` for printable parts. Neither is required to publish a valid file event, and neither may be required to read one.

Clients SHOULD treat `i` source URL tags as unverified provenance metadata. They do not prove authorship or ownership of the external source.

Clients SHOULD NOT require optional print metadata tags to display, download, or print a printable.
