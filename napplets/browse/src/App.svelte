<script lang="ts">
  import { inc, intent, outbox } from '@napplet/sdk';
  import { onMount } from 'svelte';
  import CoverImage from './lib/CoverImage.svelte';
  import { fetchMakers, type MakerProfile } from './lib/profiles';
  import {
    collectObject,
    filterObjects,
    OBJECT_KIND,
    sortByNewest,
    toPrintableObject,
    type PrintableObject,
  } from './lib/objects';

  /**
   * The home page: a live feed of recently published printable objects.
   *
   * Its own payload (a search query or tag) arrives over the NAP-INTENT delivery seam, and
   * it dispatches onward navigation the same way — by archetype, never by URL, so the shell
   * keeps ownership of routing.
   */

  const OPEN_TOPIC = 'browse:open';
  const READY_TOPIC = 'browse:ready';

  /** How many objects to pull for the feed. Pagination is a follow-up. */
  const FEED_LIMIT = 60;

  /** Names are looked up in batches so a fast-streaming feed does not fan out per card. */
  const MAKER_LOOKUP_DELAY_MS = 300;

  let objects = $state(new Map<string, PrintableObject>());
  let makers = $state(new Map<string, MakerProfile>());
  let query = $state('');
  let searchInput = $state('');
  let topic = $state('');
  let status = $state('');
  let loading = $state(true);

  const feed = $derived(filterObjects(sortByNewest(objects.values()), { query, topic }));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasInc = () => typeof napplets().inc === 'object';
  const hasIntent = () => typeof napplets().intent === 'object';
  const hasOutbox = () => typeof napplets().outbox === 'object';

  function makerName(pubkey: string): string {
    return makers.get(pubkey)?.name || 'Unknown maker';
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

  function ingest(event: Parameters<typeof toPrintableObject>[0]): void {
    const object = toPrintableObject(event);
    if (!object) return;

    const merged = collectObject(objects, object);
    if (merged === objects) return;

    objects = merged;
    loading = false;
    scheduleMakerLookup(object.pubkey);
  }

  function openFeed(): (() => void) | undefined {
    if (!hasOutbox()) {
      loading = false;
      status = 'This shell does not provide relay access, so objects cannot be listed.';
      return undefined;
    }

    const subscription = outbox.subscribe([{ kinds: [OBJECT_KIND], limit: FEED_LIMIT }]);
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

  // ---------------------------------------------------------------- navigation

  /** Hands the object to whichever napplet fulfills the `object-detail` role. */
  async function openObject(object: PrintableObject): Promise<void> {
    if (!hasIntent()) {
      status = 'This shell cannot open objects.';
      return;
    }

    const result = await intent.open('object-detail', { address: object.address });
    if (!result.ok) status = result.error ?? 'Could not open that object.';
  }

  /** Hands the maker to whichever napplet fulfills the `user-profile` role. */
  async function openMaker(pubkey: string): Promise<void> {
    if (!hasIntent()) {
      status = 'This shell cannot open maker profiles.';
      return;
    }

    const result = await intent.open('user-profile', { pubkey });
    if (!result.ok) status = result.error ?? 'Could not open that maker.';
  }

  /**
   * Napplet iframes are sandboxed with `allow-scripts` only, which blocks form submission
   * outright — a `<form onsubmit>` never fires. Search is driven by the button and the
   * Enter key instead.
   */
  function onSearch(): void {
    const next = searchInput.trim();

    // Route through the shell so the URL matches what is shown and the search is linkable.
    if (hasIntent()) void intent.open('browse', next ? { query: next } : {});
    else query = next;
  }

  function openTopic(next: string): void {
    if (hasIntent()) void intent.open('browse', { tag: next });
    else topic = next;
  }

  // ---------------------------------------------------------------- lifecycle

  function applyIntent(payload: unknown): void {
    const values = (payload ?? {}) as { query?: unknown; tag?: unknown };
    query = typeof values.query === 'string' ? values.query : '';
    topic = typeof values.tag === 'string' ? values.tag : '';
    searchInput = query;
  }

  onMount(() => {
    const closeFeed = openFeed();

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
  <div class="join w-full" role="search">
    <input
      class="input join-item w-full"
      placeholder="Search phone stands, minis, brackets..."
      aria-label="Search objects"
      bind:value={searchInput}
      onkeydown={(event) => event.key === 'Enter' && onSearch()}
    />
    <button type="button" class="btn btn-primary join-item" onclick={onSearch}>Search</button>
  </div>

  {#if topic}
    <p class="mt-3 text-sm text-base-content/70" data-testid="browse-tag">
      Showing objects tagged #{topic}
    </p>
  {:else if query}
    <p class="mt-3 text-sm text-base-content/70" data-testid="browse-query">
      Showing results for {query}
    </p>
  {/if}

  {#if loading && feed.length === 0}
    <section class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading objects">
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
      {#if query || topic}
        Nothing published here matches that yet. Try a broader search.
      {:else}
        No objects have been published to these relays yet. Be the first to share one.
      {/if}
    </p>
  {:else}
    <section
      class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label="Recently published objects"
      data-testid="browse-results"
    >
      {#each feed as object (object.address)}
        <article class="grid content-start gap-2" data-testid="object-result">
          <button
            type="button"
            class="grid gap-2 text-left"
            data-testid="open-object"
            data-address={object.address}
            onclick={() => openObject(object)}
          >
            <CoverImage cover={object.cover} title={object.title} />
            <span class="font-medium" data-testid="object-title">{object.title}</span>
            {#if object.summary}
              <span class="line-clamp-2 text-sm text-base-content/70">{object.summary}</span>
            {/if}
          </button>

          <button
            type="button"
            class="link w-fit text-sm text-base-content/70"
            data-testid="open-maker"
            data-pubkey={object.pubkey}
            onclick={() => openMaker(object.pubkey)}
          >
            {makerName(object.pubkey)}
          </button>

          {#if object.topics.length > 0}
            <div class="flex flex-wrap gap-1">
              {#each object.topics.slice(0, 3) as entry (entry)}
                <button
                  type="button"
                  class="badge badge-ghost badge-sm"
                  data-testid="object-topic"
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
