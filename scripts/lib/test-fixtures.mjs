import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

/**
 * Seed data for the browser-test relay.
 *
 * Keys and timestamps are fixed so assertions can name an exact maker or object, and so a
 * rerun produces the same feed order.
 */

const SECRET_KEYS = {
  vera: hexToBytes('1'.repeat(64)),
  otto: hexToBytes('2'.repeat(64)),
};

/** The two makers the fixture objects are published by. */
export const MAKERS = {
  vera: { name: 'Vera Prints', pubkey: getPublicKey(SECRET_KEYS.vera) },
  otto: { name: 'Otto Makes', pubkey: getPublicKey(SECRET_KEYS.otto) },
};

/**
 * Bump this whenever fixture content changes.
 *
 * The dev relay is long-lived and shared, and `kind:33500` is addressable: a relay that
 * already holds a fixture object will keep the copy it has unless the replacement is
 * strictly newer. Without a bump, an edited description silently never reaches the tests.
 */
const BASE_TIME = 1_760_100_000;

/**
 * A description exercising the Markdown rules in NIP.md, including the ones that must be
 * refused. `{{baseUrl}}` is substituted with the test server's origin.
 *
 * The hostile cases are fixtures, not decoration: a `javascript:` link, a `data:` image and
 * a raw HTML element are the three things a description must never be able to turn into
 * markup, so they are seeded here and asserted against in `object-markdown.test.mjs`.
 */
const MARKDOWN_DESCRIPTION = `## Print settings

Print **flat on the bed** with _no supports_. Set the wall count to \`3\` and it survives a drop.

| Setting | Value |
| --- | --- |
| Layer height | 0.2mm |
| Infill | 15% |

### Assembly

- Sand the hinge lightly
- Test fit before gluing

### Progress

- [x] Model the hinge
- [ ] Add a cable channel

> The first revision snapped at the hinge. This one does not.

\`\`\`gcode
M104 S205 ; hotend
\`\`\`

Build log in [my notes](https://notes.example/phone-stand), or ~~the old page~~.

![Hinge detail]({{baseUrl}}/src/assets/hero.png)

Do not link [this](javascript:alert(1)) and do not load ![this](data:text/html,boom).

<b data-testid="raw-html">raw html must not render</b>

---

Ampersands &amp; entities decode.
`;

/**
 * Objects in publication order, oldest first. The feed renders these newest first, so the
 * last entry here is the first card on the page.
 */
export const OBJECTS = [
  {
    maker: 'otto',
    identifier: 'cable-comb',
    title: 'Cable Comb',
    summary: 'Keeps desk cables in a straight line.',
    topics: ['desk', 'cables'],
  },
  {
    maker: 'vera',
    identifier: 'hex-bit-holder',
    title: 'Hex Bit Holder',
    summary: 'A magnetic holder for 1/4 inch driver bits.',
    topics: ['workshop', 'tools'],
  },
  {
    maker: 'vera',
    identifier: 'adjustable-phone-stand',
    title: 'Adjustable Phone Stand',
    summary: 'A folding phone stand printable without supports.',
    topics: ['desk', 'phone-stand'],
    description: MARKDOWN_DESCRIPTION,
  },
];

/** The `.content` a fixture object is published with, per NIP.md's Markdown Content rules. */
export function descriptionOf(object, baseUrl) {
  const source = object.description ?? `${object.summary}\n\nPrint at 0.2mm layer height.`;
  return source.replaceAll('{{baseUrl}}', baseUrl);
}

/**
 * Builds the signed fixture events.
 *
 * @param baseUrl Origin the cover images are served from — the test's own Vite server, so
 *                NAP-RESOURCE has something real to proxy.
 */
/**
 * The part file every fixture object carries, as a kind-1063 (NIP-94) event. It is a real
 * 684-byte binary STL served by the test's own Vite server, so the preview napplet exercises
 * the whole path — outbox lookup, NAP-RESOURCE fetch, parse, render — rather than a stub.
 */
function buildFileEvent(baseUrl, object, index) {
  return finalizeEvent(
    {
      kind: 1063,
      created_at: BASE_TIME + index + 1,
      tags: [
        ['url', `${baseUrl}/src/assets/cube.stl`],
        ['m', 'model/stl'],
        ['size', '684'],
        ['name', `${object.identifier}.stl`],
      ],
      content: `Printable part for ${object.title}.`,
    },
    SECRET_KEYS[object.maker],
  );
}

export function buildFixtureEvents(baseUrl) {
  const profiles = Object.entries(MAKERS).map(([key, maker]) =>
    finalizeEvent(
      {
        kind: 0,
        created_at: BASE_TIME,
        tags: [],
        content: JSON.stringify({ name: maker.name, display_name: maker.name }),
      },
      SECRET_KEYS[key],
    ),
  );

  // Files are built first: an object's `e` tag has to name an id that already exists.
  const files = OBJECTS.map((object, index) => buildFileEvent(baseUrl, object, index));

  const objects = OBJECTS.map((object, index) =>
    finalizeEvent(
      {
        kind: 33500,
        created_at: BASE_TIME + index + 1,
        tags: [
          ['d', object.identifier],
          ['title', object.title],
          ['summary', object.summary],
          [
            'imeta',
            `url ${baseUrl}/src/assets/hero.png`,
            'm image/png',
            `alt ${object.title} printed in blue PLA`,
          ],
          // Role-marked file reference: the fourth position names what the file is to
          // this object, which is how the detail napplet tells parts from instructions.
          ['e', files[index].id, '', 'part'],
          ...object.topics.map((topic) => ['t', topic]),
        ],
        content: descriptionOf(object, baseUrl),
      },
      SECRET_KEYS[object.maker],
    ),
  );

  return [...profiles, ...files, ...objects];
}

/** The kind-1063 file event id for a fixture object, by its position in `OBJECTS`. */
export function fileIdOf(baseUrl, identifier) {
  const index = OBJECTS.findIndex((object) => object.identifier === identifier);
  if (index === -1) throw new Error(`No fixture object named ${identifier}`);
  return buildFileEvent(baseUrl, OBJECTS[index], index).id;
}

/** The address the object-detail intent should produce for a fixture object. */
export function addressOf(object) {
  return `33500:${MAKERS[object.maker].pubkey}:${object.identifier}`;
}
