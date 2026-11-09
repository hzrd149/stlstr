import { useCallback, useState } from 'react';
import { Check, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import {
  ARCHETYPES,
  NAPPLET_CATEGORIES,
  conventionId,
  type ArchetypeEntry,
  type IntentDoc,
  type NappletCategory,
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
  category: NappletCategory;
  naddr: string | null;
};

const CATEGORY_TITLES = new Map<NappletCategory, string>(
  NAPPLET_CATEGORIES.map((category) => [category.id, category.title]),
);

/** Every published napplet (archetypes with a category), in category display order. */
function catalogNapplets(): CatalogNapplet[] {
  const entries = Object.entries(ARCHETYPES);
  return NAPPLET_CATEGORIES.flatMap((category) =>
    entries
      .filter(([, entry]) => entry.category === category.id)
      .map(([archetype, entry]) => ({
        archetype,
        entry,
        category: category.id,
        naddr: publishedNappletNaddr(entry.dTag),
      })),
  );
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

/** One NAP-INTENT the napplet accepts, collapsed to its convention id and payload keys. */
function IntentItem({ convention, doc }: { convention: string; doc: IntentDoc }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-base-200 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-base-content/50 transition-transform group-open:rotate-90"
        />
        <code className="truncate font-mono text-xs">{convention}</code>
        {doc.fields.length > 0 && (
          <span className="ml-auto shrink-0 font-mono text-xs text-base-content/50">
            {doc.fields.map((field) => `${field.name}${field.required ? '' : '?'}`).join(', ')}
          </span>
        )}
      </summary>
      <div className="grid gap-1.5 py-1.5 pr-1 pl-6 text-xs">
        <p className="text-base-content/70">{doc.summary}</p>
        {doc.fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {doc.fields.map((field) => (
              <div key={field.name} className="contents">
                <dt className="font-mono">
                  {field.name}
                  {!field.required && <span className="text-base-content/50">?</span>}
                </dt>
                <dd className="text-base-content/60">{field.description}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}

function NappletCard({
  napplet,
  copied,
  onCopy,
}: {
  napplet: CatalogNapplet;
  copied: string | null;
  onCopy: (value: string) => void;
}) {
  const { archetype, entry, category, naddr } = napplet;

  return (
    <article className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <img
          src={nappletIcon}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-lg object-contain"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="font-semibold">{entry.title}</h2>
            <span className="text-xs text-base-content/50">{CATEGORY_TITLES.get(category)}</span>
          </div>
          <p className="line-clamp-2 text-sm text-base-content/65">{entry.description}</p>
        </div>
      </div>

      <div className="grid gap-0.5 pl-12">
        {Object.entries(entry.intents).map(([action, doc]) => (
          <IntentItem key={action} convention={conventionId(archetype, action)} doc={doc} />
        ))}
      </div>

      {naddr && (
        <div className="flex gap-1 pl-11">
          <button
            type="button"
            className="btn btn-ghost btn-xs font-normal text-base-content/70"
            onClick={() => onCopy(naddr)}
            title={naddr}
          >
            {copied === naddr ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            {copied === naddr ? 'Copied' : 'Copy naddr'}
          </button>
          <a
            href={pajaUrl(naddr)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-xs font-normal text-base-content/70"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open in Paja
          </a>
        </div>
      )}
    </article>
  );
}

/** The catalog is static build data, so resolve it once. */
const napplets = catalogNapplets();
const categories = NAPPLET_CATEGORIES.filter((category) =>
  napplets.some((napplet) => napplet.category === category.id),
);

export default function NappletsView() {
  const { copied, copy } = useCopy();
  const [filter, setFilter] = useState<NappletCategory | 'all'>('all');
  const shown = filter === 'all' ? napplets : napplets.filter((n) => n.category === filter);

  return (
    <div className="grid w-full gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Napplets</h1>
          <p className="text-sm text-base-content/60">
            {napplets.length} napplets published by STLstr
          </p>
        </div>
        <div role="tablist" className="tabs tabs-sm">
          {[{ id: 'all' as const, title: 'All' }, ...categories].map((category) => (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={filter === category.id}
              className={`tab ${filter === category.id ? 'tab-active' : ''}`}
              onClick={() => setFilter(category.id)}
            >
              {category.title}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((napplet) => (
          <NappletCard key={napplet.archetype} napplet={napplet} copied={copied} onCopy={copy} />
        ))}
      </div>
    </div>
  );
}
