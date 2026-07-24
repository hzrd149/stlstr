import { useCallback, useState } from 'react';
import {
  Box,
  Camera,
  Check,
  Compass,
  Copy,
  ExternalLink,
  Package,
  Puzzle,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  ARCHETYPES,
  NAPPLET_CATEGORIES,
  conventionId,
  type ArchetypeEntry,
  type IntentDoc,
  type NappletCategory,
} from './services/intent-map';
import {
  NAPPLET_PUBLISHER_PUBKEY,
  publishedNappletAddress,
  publishedNappletNaddr,
} from './services/napplets';

/** Opens a napplet by naddr in the hosted Paja runtime. */
function pajaUrl(naddr: string): string {
  return `https://kehto.github.io/web/paja/?pointer=${encodeURIComponent(naddr)}`;
}

/** The lucide glyph that fronts each showcase category. Presentation-only, so it lives here. */
const CATEGORY_ICONS: Record<NappletCategory, LucideIcon> = {
  discover: Compass,
  printables: Box,
  makes: Camera,
  parts: Package,
  tools: Wrench,
};

type ShowcaseNapplet = {
  archetype: string;
  entry: ArchetypeEntry;
  naddr: string | null;
};

type ShowcaseGroup = {
  id: NappletCategory;
  title: string;
  description: string;
  Icon: LucideIcon;
  napplets: ShowcaseNapplet[];
};

/** The published napplets, grouped by category in display order — the showcase's data. */
function showcaseGroups(): ShowcaseGroup[] {
  const entries = Object.entries(ARCHETYPES);

  return NAPPLET_CATEGORIES.map((category) => ({
    id: category.id,
    title: category.title,
    description: category.description,
    Icon: CATEGORY_ICONS[category.id],
    napplets: entries
      .filter(([, entry]) => entry.category === category.id)
      .map(([archetype, entry]) => ({
        archetype,
        entry,
        naddr: publishedNappletNaddr(entry.dTag),
      })),
  })).filter((group) => group.napplets.length > 0);
}

type ArchetypeRow = {
  archetype: string;
  entry: ArchetypeEntry;
  intents: Array<[string, IntentDoc]>;
  /** True when a napplet is actually built and deployed for this archetype. */
  published: boolean;
  address: string | null;
};

/**
 * Every archetype the shell defines, published napplets first (in category order) and
 * planned-but-unpublished archetypes last — the technical reference's data.
 */
function archetypeRows(): ArchetypeRow[] {
  const rank = new Map(NAPPLET_CATEGORIES.map((category, index) => [category.id, index]));

  return Object.entries(ARCHETYPES)
    .map(([archetype, entry]) => {
      const published = Boolean(entry.category);
      return {
        archetype,
        entry,
        intents: Object.entries(entry.intents),
        published,
        address: published ? publishedNappletAddress(entry.dTag) : null,
      };
    })
    .sort((a, b) => {
      const ar = a.entry.category ? (rank.get(a.entry.category) ?? 0) : Number.POSITIVE_INFINITY;
      const br = b.entry.category ? (rank.get(b.entry.category) ?? 0) : Number.POSITIVE_INFINITY;
      return ar - br;
    });
}

/** Copies text to the clipboard, tracking which value was last copied for button feedback. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied((current) => (current === value ? null : current)), 1_500);
    } catch {
      // Clipboard access can be denied; leave the button in its resting state.
    }
  }, []);

  return { copied, copy };
}

/** A read-only monospace value with a one-click copy button. */
function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium text-base-content/60">{label}</span>
      <div className="join w-full">
        <input
          className="input input-sm join-item w-full font-mono text-sm"
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          aria-label={label}
        />
        <button
          type="button"
          className="btn btn-sm join-item"
          onClick={() => onCopy(value)}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
        >
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** Part one: the promotional showcase of the napplets this app publishes. */
function Showcase({ copied, onCopy }: { copied: string | null; onCopy: (value: string) => void }) {
  const groups = showcaseGroups();

  return (
    <section className="grid gap-6">
      <header className="grid gap-2">
        <div className="flex items-center gap-2">
          <Puzzle size={24} aria-hidden="true" className="text-primary" />
          <h1 className="text-3xl font-bold">Napplets</h1>
        </div>
        <p className="max-w-2xl text-base text-base-content/70">
          STLstr is built from small, sandboxed napplets — and it publishes every one of them for
          other Nostr apps to embed. Drop a maker profile, a 3D preview, or the whole printable feed
          into your own app without rebuilding any of it. Copy a napplet&rsquo;s address, or open it
          straight away in Paja.
        </p>
      </header>

      {groups.map((group) => (
        <div key={group.id} className="grid gap-3">
          <div className="flex items-center gap-2">
            <group.Icon size={18} aria-hidden="true" className="text-primary" />
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <span className="text-sm text-base-content/60">— {group.description}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.napplets.map(({ archetype, entry, naddr }) => (
              <article
                key={archetype}
                className="flex flex-col gap-3 rounded-box bg-base-100 p-4 shadow-sm ring-1 ring-base-300/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{entry.title}</h3>
                  <span className="badge badge-ghost badge-sm shrink-0 font-mono">
                    {entry.dTag}
                  </span>
                </div>
                <p className="text-sm text-base-content/65">{entry.description}</p>

                {naddr && (
                  <div className="mt-auto grid gap-2 pt-1">
                    <CopyField
                      label="naddr"
                      value={naddr}
                      copied={copied === naddr}
                      onCopy={onCopy}
                    />
                    <a
                      href={pajaUrl(naddr)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-primary btn-sm"
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                      Open in Paja
                    </a>
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** One documented intent (verb) of an archetype: what it does and the payload it reads. */
function IntentDetail({ convention, doc }: { convention: string; doc: IntentDoc }) {
  return (
    <div className="grid gap-2 rounded-box bg-base-200/50 p-3">
      <code className="w-fit font-mono text-sm font-semibold">{convention}</code>
      <p className="text-sm text-base-content/75">{doc.summary}</p>
      {doc.fields.length > 0 ? (
        <dl className="grid gap-1.5">
          {doc.fields.map((field) => (
            <div key={field.name} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-3">
              <dt className="flex items-center gap-2">
                <code className="font-mono text-sm">{field.name}</code>
                <span
                  className={`badge badge-sm ${
                    field.required ? 'badge-success badge-outline' : 'badge-ghost'
                  }`}
                >
                  {field.required ? 'required' : 'optional'}
                </span>
              </dt>
              <dd className="text-sm text-base-content/70">{field.description}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-base-content/55">No payload.</p>
      )}
    </div>
  );
}

/** One archetype's full definition: what it is, its address, and every intent it accepts. */
function ArchetypeSection({
  row,
  copied,
  onCopy,
}: {
  row: ArchetypeRow;
  copied: string | null;
  onCopy: (value: string) => void;
}) {
  const { archetype, entry, intents, published, address } = row;

  return (
    <article className="grid gap-4 rounded-box bg-base-100 p-5 ring-1 ring-base-300/70">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-lg font-semibold">{archetype}</h3>
          <span className="badge badge-ghost badge-sm font-mono">{entry.dTag}</span>
          {published ? (
            <span className="badge badge-success badge-sm badge-outline">published</span>
          ) : (
            <span className="badge badge-ghost badge-sm">planned</span>
          )}
        </div>
        <p className="max-w-2xl text-base text-base-content/70">{entry.description}</p>
        {address ? (
          <div className="max-w-xl pt-1">
            <CopyField
              label="Address"
              value={address}
              copied={copied === address}
              onCopy={onCopy}
            />
          </div>
        ) : (
          <p className="text-sm text-base-content/50">
            {published
              ? 'Publishing identity not configured for this build.'
              : 'Routable in this app, but no napplet is published for it yet.'}
          </p>
        )}
      </header>

      <div className="grid gap-2">
        <span className="text-sm font-medium text-base-content/60">
          {intents.length === 1 ? 'Intent' : 'Intents'}
        </span>
        {intents.map(([action, doc]) => (
          <IntentDetail key={action} convention={conventionId(archetype, action)} doc={doc} />
        ))}
      </div>
    </article>
  );
}

/** Part two: the technical reference for every archetype this app defines. */
function ArchetypeReference({
  copied,
  onCopy,
}: {
  copied: string | null;
  onCopy: (value: string) => void;
}) {
  const rows = archetypeRows();
  const configured = Boolean(NAPPLET_PUBLISHER_PUBKEY);

  return (
    <section className="grid gap-4">
      <header className="grid gap-2 border-t border-base-300 pt-6">
        <h2 className="text-2xl font-bold">Archetypes</h2>
        <p className="max-w-2xl text-base text-base-content/65">
          An archetype is the interoperable role another runtime targets with NAP-INTENT — the
          contract, not the implementation. Each defines the intents it accepts and the payload
          shape each intent reads. Grant a napplet those intents, then open it by its{' '}
          <code className="rounded bg-base-200 px-1.5 py-0.5 font-mono text-sm">kind:pubkey:d</code>{' '}
          address.
        </p>
      </header>

      {!configured && (
        <div className="alert alert-info text-sm">
          <span>
            This build has no publishing identity configured, so copyable addresses are hidden. The
            archetypes and intents below are still accurate.
          </span>
        </div>
      )}

      {rows.map((row) => (
        <ArchetypeSection key={row.archetype} row={row} copied={copied} onCopy={onCopy} />
      ))}
    </section>
  );
}

export default function NappletsView() {
  const { copied, copy } = useCopy();

  return (
    <div className="grid w-full gap-10 px-4 py-6 sm:px-6 lg:px-8">
      <Showcase copied={copied} onCopy={copy} />
      <ArchetypeReference copied={copied} onCopy={copy} />
    </div>
  );
}
