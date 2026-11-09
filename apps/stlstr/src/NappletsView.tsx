import {
  ARCHETYPES,
  NAPPLET_CATEGORIES,
  conventionId,
  type ArchetypeEntry,
  type IntentDoc,
} from './services/intent-map';
import { publishedNappletNaddr } from './services/napplets';
import nappletIcon from '../../../scripts/lib/napplet-icon.png';

/** Opens a napplet by naddr in the hosted Paja runtime. */
function pajaUrl(naddr: string): string {
  return `https://kehto.github.io/web/paja/?pointer=${encodeURIComponent(naddr)}`;
}

type CatalogNapplet = {
  archetype: string;
  entry: ArchetypeEntry;
  naddr: string | null;
};

type CatalogGroup = {
  id: string;
  title: string;
  napplets: CatalogNapplet[];
};

/** Published napplets (archetypes with a category), grouped in category display order. */
function catalogGroups(): CatalogGroup[] {
  const entries = Object.entries(ARCHETYPES);
  return NAPPLET_CATEGORIES.map((category) => ({
    id: category.id,
    title: category.title,
    napplets: entries
      .filter(([, entry]) => entry.category === category.id)
      .map(([archetype, entry]) => ({
        archetype,
        entry,
        naddr: publishedNappletNaddr(entry.dTag),
      })),
  })).filter((group) => group.napplets.length > 0);
}

/** One NAP-INTENT the napplet accepts: its convention id, what it does, and its payload. */
function Intent({ convention, doc }: { convention: string; doc: IntentDoc }) {
  return (
    <div className="grid gap-1">
      <code className="font-mono text-xs">{convention}</code>
      <p className="text-xs text-base-content/60">{doc.summary}</p>
      {doc.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {doc.fields.map((field) => (
            <div key={field.name} className="contents">
              <dt className="font-mono text-base-content/80">
                {field.name}
                {!field.required && <span className="text-base-content/50">?</span>}
              </dt>
              <dd className="text-base-content/55">{field.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Napplet({ napplet }: { napplet: CatalogNapplet }) {
  const { archetype, entry, naddr } = napplet;

  return (
    <article className="flex gap-3">
      <img
        src={nappletIcon}
        alt=""
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded-lg object-contain"
      />
      <div className="grid min-w-0 content-start gap-2">
        <div>
          <h3 className="font-semibold">{entry.title}</h3>
          <p className="text-sm text-base-content/65">{entry.description}</p>
        </div>
        {Object.entries(entry.intents).map(([action, doc]) => (
          <Intent key={action} convention={conventionId(archetype, action)} doc={doc} />
        ))}
        {naddr && (
          <p className="text-xs text-base-content/60">
            <a href={pajaUrl(naddr)} target="_blank" rel="noreferrer" className="link">
              Open in Paja
            </a>
            {' · '}
            <a href={`nostr:${naddr}`} className="link" title={naddr}>
              naddr
            </a>
          </p>
        )}
      </div>
    </article>
  );
}

/** The catalog is static build data, so resolve it once. */
const groups = catalogGroups();
const total = groups.reduce((sum, group) => sum + group.napplets.length, 0);

export default function NappletsView() {
  return (
    <div className="grid w-full gap-8 px-4 py-6 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-bold">Napplets</h1>
        <p className="text-sm text-base-content/60">{total} napplets published by STLstr</p>
      </header>

      {groups.map((group) => (
        <section key={group.id} className="grid gap-4">
          <h2 className="text-sm font-semibold tracking-wide text-base-content/50 uppercase">
            {group.title}
          </h2>
          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
            {group.napplets.map((napplet) => (
              <Napplet key={napplet.archetype} napplet={napplet} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
