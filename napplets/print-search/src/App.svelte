<script lang="ts">
  import { inc, intent, outbox } from '@napplet/sdk';
  import MakerLink from '@stlstr/napplet-kit/components/MakerLink.svelte';
  import { fetchMakers, type MakerProfile } from '@stlstr/napplet-kit/profiles';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import { onMount } from 'svelte';
  import CoverImage from './lib/CoverImage.svelte';
  import {
    collectPrintable,
    filterPrintables,
    PRINTABLE_KIND,
    sortByNewest,
    toPrintableObject,
    type PrintableObject,
  } from './lib/printables';

  /**
   * The home page: a live feed of recently published printables.
   *
   * Its own payload (a search query or tag) arrives over the NAP-INTENT delivery seam, and
   * it dispatches onward navigation the same way — by archetype, never by URL, so the shell
   * keeps ownership of routing.
   */

  const OPEN_TOPIC = 'printable-search:open';
  const READY_TOPIC = 'printable-search:ready';

  /** How many printables to pull for the feed. Pagination is a follow-up. */
  const FEED_LIMIT = 60;

  /** Names are looked up in batches so a fast-streaming feed does not fan out per card. */
  const MAKER_LOOKUP_DELAY_MS = 300;

  type BrowseFilter = {
    kinds: number[];
    limit: number;
    search?: string;
    [key: `#${string}`]: string[] | undefined;
    [key: `&${string}`]: string[] | undefined;
  };

  let printables = $state(new Map<string, PrintableObject>());
  let makers = $state(new Map<string, MakerProfile>());
  let query = $state('');
  let searchInput = $state('');
  let topics = $state<string[]>([]);
  let sortMode = $state<'relevance' | 'newest'>('newest');
  let status = $state('');
  let loading = $state(true);

  const orderedObjects = $derived(
    query && sortMode === 'relevance' ? [...printables.values()] : sortByNewest(printables.values()),
  );
  const feed = $derived(filterPrintables(orderedObjects, { query, topics }));

  const hasInc = () => hasMethods('inc', 'emit', 'on');
  const hasIntent = () => hasMethods('intent', 'open');
  const hasOutbox = () => hasMethods('outbox', 'subscribe');

  function normalizeTopic(value: string): string {
    return value.trim().replace(/^#+/, '').toLowerCase();
  }

  function normalizeTopics(values: unknown[]): string[] {
    return [
      ...new Set(
        values
          .filter((value): value is string => typeof value === 'string')
          .map(normalizeTopic)
          .filter(Boolean),
      ),
    ];
  }

  function parseSearchInput(input: string): { query: string; topics: string[] } {
    const topics = normalizeTopics(
      input.match(/(^|\s)#([^\s#]+)/g)?.map((tag) => tag.trim()) ?? [],
    );
    const query = input
      .replace(/(^|\s)#[^\s#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { query, topics };
  }

  function searchText(nextQuery: string, nextTopics: string[]): string {
    return `${nextQuery.trim()}${nextTopics.map((tag) => ` #${tag}`).join('')}`.trim();
  }

  function buildFilter(): BrowseFilter {
    const filter: BrowseFilter = { kinds: [PRINTABLE_KIND], limit: FEED_LIMIT };
    const tagFilters = [...topics];
    // Text matching is applied client-side below. Keeping the relay query broad makes search
    // work on basic NIP-01 relays that do not implement NIP-50.
    if (tagFilters.length === 1) filter['#t'] = tagFilters;
    if (tagFilters.length > 1) {
      filter['&t'] = [...tagFilters];
      // NIP-91 requires clients to include the equivalent OR tag for older relays.
      filter['#t'] = [...tagFilters];
    }
    return filter;
  }

  // ---------------------------------------------------------------- maker names

  let pendingMakers = new Set<string>();
  let makerTimer = 0;

  function scheduleMakerLookup(pubkey: string): void {
    if (makers.has(pubkey) || pendingMakers.has(pubkey)) return;
    pendingMakers.add(pubkey);

    window.clearTimeout(makerTimer);
    makerTimer = window.setTimeout(() => {
      const batch = [...pendingMakers];
      pendingMakers = new Set();
      void fetchMakers(batch).then((resolved) => {
        const next = new Map(makers);
        for (const maker of resolved) next.set(maker.pubkey, maker);
        makers = next;
      });
    }, MAKER_LOOKUP_DELAY_MS);
  }

  // ---------------------------------------------------------------- the feed

  let closeFeed: (() => void) | undefined;

  function ingest(event: Parameters<typeof toPrintableObject>[0]): void {
    const printable = toPrintableObject(event);
    if (!printable) return;

    const merged = collectPrintable(printables, printable);
    if (merged === printables) return;

    printables = merged;
    loading = false;
    scheduleMakerLookup(printable.pubkey);
  }

  function openFeed(): (() => void) | undefined {
    if (!hasOutbox()) {
      loading = false;
      status = 'This shell does not provide relay access, so prints cannot be listed.';
      return undefined;
    }

    const subscription = outbox.subscribe([buildFilter()]);
    subscription.on('event', (result) => ingest(result.event));
    subscription.on('closed', (reason) => {
      loading = false;
      if (reason) status = 'The connection to the relays dropped. Reload to try again.';
    });

    // Relays that return nothing never send a closing signal, so the empty state needs its
    // own deadline or the feed would show a skeleton forever.
    const deadline = window.setTimeout(() => {
      loading = false;
    }, 6000);

    return () => {
      window.clearTimeout(deadline);
      subscription.close();
    };
  }

  function restartFeed(): void {
    closeFeed?.();
    closeFeed = undefined;
    printables = new Map();
    status = '';
    loading = true;
    closeFeed = openFeed();
  }

  // ---------------------------------------------------------------- navigation

  /** Hands the printable to whichever napplet fulfills the `printable-detail` role. */
  async function openPrintable(printable: PrintableObject): Promise<void> {
    if (!hasIntent()) {
      status = 'This shell cannot open prints.';
      return;
    }

    const result = await intent.open('printable-detail', { address: printable.address });
    if (!result.ok) status = result.error ?? 'Could not open that print.';
  }

  /**
   * Napplet iframes are sandboxed with `allow-scripts` only, which blocks form submission
   * outright — a `<form onsubmit>` never fires. Search is driven by the button and the
   * Enter key instead.
   */
  function onSearch(): void {
    const raw = searchInput.trim();
    const next = parseSearchInput(raw);
    openSearch(next.query, next.topics);
  }

  function openSearch(nextQuery: string, nextTopics: string[]): void {
    const normalized = normalizeTopics(nextTopics);
    const raw = searchText(nextQuery, normalized);
    // Route through the shell so the URL matches what is shown and the search is linkable.
    if (hasIntent()) void intent.open('printable-search', raw ? { query: raw } : {});
    else {
      query = nextQuery.trim();
      topics = normalized;
      searchInput = raw;
      restartFeed();
    }
  }

  function removeTopic(topic: string): void {
    openSearch(
      query,
      topics.filter((entry) => entry !== topic),
    );
  }

  function clearSearch(): void {
    openSearch('', []);
  }

  function openTopic(next: string): void {
    if (hasIntent()) void intent.open('printable-search', { tag: next });
    else {
      query = '';
      topics = normalizeTopics([next]);
      searchInput = '';
      restartFeed();
    }
  }

  // ---------------------------------------------------------------- lifecycle

  function applyIntent(payload: unknown): void {
    const values = (payload ?? {}) as { query?: unknown; tag?: unknown; tags?: unknown };
    const parsed = parseSearchInput(typeof values.query === 'string' ? values.query : '');
    query = parsed.query;
    topics = normalizeTopics([
      ...parsed.topics,
      ...(typeof values.tag === 'string' ? [values.tag] : []),
      ...(typeof values.tags === 'string' ? values.tags.split(',') : []),
      ...(Array.isArray(values.tags) ? values.tags : []),
    ]);
    sortMode = query ? 'relevance' : 'newest';
    searchInput = searchText(query, topics);
    restartFeed();
  }

  onMount(() => {
    closeFeed = openFeed();

    if (!hasInc()) return closeFeed;

    // Subscribe BEFORE signalling readiness, or the shell flushes into a dead listener.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      window.clearTimeout(makerTimer);
      closeFeed?.();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <div class="flex flex-col gap-2 sm:flex-row" role="search">
    <div class="join min-w-0 flex-1">
      <input
        class="input join-item w-full"
        placeholder="Search phone stands, minis, brackets... add #tags to narrow"
        aria-label="Search prints"
        bind:value={searchInput}
        onkeydown={(event) => event.key === 'Enter' && onSearch()}
      />
      <button type="button" class="btn btn-primary join-item" onclick={onSearch}>Search</button>
    </div>

    <label class="select w-full sm:w-44" aria-label="Sort results">
      <span class="label">Sort</span>
      <select bind:value={sortMode}>
        <option value="relevance">Relevance</option>
        <option value="newest">Newest</option>
      </select>
    </label>
  </div>

  <p class="mt-2 text-xs text-base-content/60">
    Use hashtags together, like <span class="font-mono">#desk #organizer</span>, to ask NIP-91
    relays for prints matching every tag.
  </p>

  {#if query || topics.length > 0}
    <div class="mt-3 flex flex-wrap items-center gap-2" aria-label="Active search filters">
      {#if query}
        <span class="badge badge-primary badge-soft gap-1" data-testid="browse-query-chip">
          {query}
        </span>
      {/if}

      {#each topics as entry (entry)}
        <button
          type="button"
          class="badge badge-secondary badge-soft gap-1"
          data-testid="browse-tag-chip"
          aria-label={`Remove #${entry}`}
          onclick={() => removeTopic(entry)}
        >
          #{entry} <span aria-hidden="true">x</span>
        </button>
      {/each}

      <button type="button" class="btn btn-ghost btn-xs" onclick={clearSearch}>Clear</button>
      <span class="text-xs text-base-content/60" data-testid="browse-result-count">
        {loading ? 'Searching...' : `${feed.length} ${feed.length === 1 ? 'result' : 'results'}`}
      </span>
    </div>
  {/if}

  {#if topics.length > 0}
    <p class="mt-3 text-sm text-base-content/70" data-testid="browse-tag">
      Showing prints tagged {topics.map((entry) => `#${entry}`).join(' + ')}
    </p>
  {/if}

  {#if query}
    <p class="mt-3 text-sm text-base-content/70" data-testid="browse-query">
      Showing results for {query}
    </p>
  {/if}

  {#if loading && feed.length === 0}
    <section class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading prints">
      {#each [0, 1, 2, 3, 4, 5] as placeholder (placeholder)}
        <div class="grid gap-2">
          <div class="skeleton aspect-video w-full"></div>
          <div class="skeleton h-4 w-2/3"></div>
          <div class="skeleton h-3 w-1/3"></div>
        </div>
      {/each}
    </section>
  {:else if feed.length === 0}
    <p class="mt-6 text-base-content/70" data-testid="browse-empty">
      {#if query || topics.length > 0}
        Nothing published here matches that yet. Try a broader search.
      {:else}
        No prints have been published to these relays yet. Be the first to share one.
      {/if}
    </p>
  {:else}
    <section
      class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label={query ? 'Search results' : 'Recently published prints'}
      data-testid="browse-results"
    >
      {#each feed as printable (printable.address)}
        <article class="grid content-start gap-2" data-testid="printable-result">
          <button
            type="button"
            class="grid gap-2 text-left"
            data-testid="open-printable"
            data-address={printable.address}
            onclick={() => openPrintable(printable)}
          >
            <CoverImage cover={printable.cover} title={printable.title} />
            <span class="font-medium" data-testid="printable-title">{printable.title}</span>
            {#if printable.summary}
              <span class="line-clamp-2 text-sm text-base-content/70">{printable.summary}</span>
            {/if}
          </button>

          <MakerLink
            pubkey={printable.pubkey}
            profile={makers.get(printable.pubkey)}
            testId="open-maker"
            buttonClass="link flex w-fit items-center gap-2 text-sm text-base-content/70"
            fallbackClass="flex w-fit items-center gap-2 text-sm text-base-content/70"
            labelClass="truncate"
            onError={(message) => (status = message)}
          />

          {#if printable.topics.length > 0}
            <div class="flex flex-wrap gap-1">
              {#each printable.topics.slice(0, 3) as entry (entry)}
                <button
                  type="button"
                  class="badge badge-ghost badge-sm"
                  data-testid="printable-topic"
                  onclick={() => openTopic(entry)}
                >
                  #{entry}
                </button>
              {/each}
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}

  {#if status}
    <p class="mt-4 text-sm text-base-content/60" aria-live="polite" data-testid="browse-status">
      {status}
    </p>
  {/if}
</main>
