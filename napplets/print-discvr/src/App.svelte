<script lang="ts">
  import { identity, inc, intent, outbox, type NostrEvent } from '@napplet/sdk';
  import MakerLink from '@stlstr/napplet-kit/components/MakerLink.svelte';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import { fetchMakers, type MakerProfile } from '@stlstr/napplet-kit/profiles';
  import { tagValue } from '@stlstr/napplet-kit/tags';
  import { onMount } from 'svelte';
  import CoverImage from './lib/CoverImage.svelte';
  import {
    collectPrintable,
    PRINTABLE_KIND,
    sortByNewest,
    toPrintableObject,
    type PrintableImage,
    type PrintableObject,
  } from './lib/printables';

  const OPEN_TOPIC = 'printable-discovery:open';
  const READY_TOPIC = 'printable-discovery:ready';
  const MAKE_KIND = 2351;
  const DISCOVERY_LIMIT = 80;
  const FRIEND_LIMIT = 80;
  const MAKE_LIMIT = 40;
  const MAKER_LOOKUP_DELAY_MS = 250;
  const EMPTY_DEADLINE_MS = 6000;

  type Make = {
    id: string;
    pubkey: string;
    address: string;
    title: string;
    note: string;
    cover: PrintableImage | null;
    createdAt: number;
  };

  let printables = $state(new Map<string, PrintableObject>());
  let friendPrintables = $state(new Map<string, PrintableObject>());
  let makes = $state(new Map<string, Make>());
  let makers = $state(new Map<string, MakerProfile>());
  let status = $state('');
  let friendsStatus = $state('Sign in to see new prints from people you follow.');
  let makesStatus = $state('');
  let loading = $state(true);
  let friendsLoading = $state(false);
  let makesLoading = $state(true);

  const newest = $derived(sortByNewest(printables.values()));
  const featured = $derived.by(() => {
    const scored = newest.map((printable) => ({
      printable,
      score:
        printable.topics.length * 4 +
        (printable.cover ? 8 : 0) +
        Math.min(printable.summary.length, 160) / 40,
    }));
    return scored
      .sort((a, b) => b.score - a.score || b.printable.createdAt - a.printable.createdAt)
      .slice(0, 6);
  });
  const recent = $derived(newest.slice(0, 12));
  const fromFriends = $derived(sortByNewest(friendPrintables.values()).slice(0, 8));
  const freshMakes = $derived(
    [...makes.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6),
  );

  const hasInc = () => hasMethods('inc', 'emit', 'on');
  const hasOutboxSubscribe = () => hasMethods('outbox', 'subscribe');
  const hasOutboxQuery = () => hasMethods('outbox', 'query');
  const hasIntent = () => hasMethods('intent', 'open');
  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'getFollows', 'onChanged');

  let pendingMakers = new Set<string>();
  let makerTimer = 0;
  let closeDiscovery: (() => void) | undefined;
  let closeMakes: (() => void) | undefined;

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

  function parseImeta(tag: string[]): PrintableImage | null {
    const fields: Record<string, string> = {};
    for (const entry of tag.slice(1)) {
      const separator = entry.indexOf(' ');
      if (separator < 1) continue;
      const key = entry.slice(0, separator);
      if (!(key in fields)) fields[key] = entry.slice(separator + 1).trim();
    }
    return fields.url ? { url: fields.url, alt: fields.alt ?? '', mime: fields.m ?? '' } : null;
  }

  function toMake(event: NostrEvent): Make | null {
    if (event.kind !== MAKE_KIND) return null;
    const address = tagValue(event.tags, 'a');
    if (!address?.startsWith(`${PRINTABLE_KIND}:`)) return null;

    const cover = event.tags
      .filter((tag) => tag[0] === 'imeta')
      .map(parseImeta)
      .find((image): image is PrintableImage => image !== null);

    return {
      id: event.id,
      pubkey: event.pubkey,
      address,
      title: event.content.trim().split('\n')[0].slice(0, 80) || 'Fresh make',
      note: event.content.trim(),
      cover: cover ?? null,
      createdAt: event.created_at,
    };
  }

  function ingestPrintable(event: NostrEvent): void {
    const printable = toPrintableObject(event);
    if (!printable) return;
    const merged = collectPrintable(printables, printable);
    if (merged === printables) return;
    printables = merged;
    loading = false;
    scheduleMakerLookup(printable.pubkey);
  }

  function ingestMake(event: NostrEvent): void {
    const make = toMake(event);
    if (!make) return;
    const current = makes.get(make.id);
    if (current && current.createdAt >= make.createdAt) return;
    const next = new Map(makes);
    next.set(make.id, make);
    makes = next;
    makesLoading = false;
    scheduleMakerLookup(make.pubkey);
  }

  function openDiscovery(): (() => void) | undefined {
    if (!hasOutboxSubscribe()) {
      loading = false;
      status = 'This shell does not provide relay access, so discovery cannot load prints.';
      return undefined;
    }

    const subscription = outbox.subscribe([{ kinds: [PRINTABLE_KIND], limit: DISCOVERY_LIMIT }]);
    subscription.on('event', (result) => ingestPrintable(result.event));
    subscription.on('closed', (reason) => {
      loading = false;
      if (reason) status = 'The connection to the relays dropped. Reload to try again.';
    });

    const deadline = window.setTimeout(() => {
      loading = false;
    }, EMPTY_DEADLINE_MS);

    return () => {
      window.clearTimeout(deadline);
      subscription.close();
    };
  }

  function openMakes(): (() => void) | undefined {
    if (!hasOutboxSubscribe()) {
      makesLoading = false;
      return undefined;
    }

    const subscription = outbox.subscribe([{ kinds: [MAKE_KIND], limit: MAKE_LIMIT }]);
    subscription.on('event', (result) => ingestMake(result.event));
    subscription.on('closed', (reason) => {
      makesLoading = false;
      if (reason) makesStatus = 'Makes could not be refreshed.';
    });

    const deadline = window.setTimeout(() => {
      makesLoading = false;
    }, EMPTY_DEADLINE_MS);

    return () => {
      window.clearTimeout(deadline);
      subscription.close();
    };
  }

  async function loadFriends(pubkey: string): Promise<void> {
    friendPrintables = new Map();
    friendsStatus = '';

    if (!pubkey) {
      friendsLoading = false;
      friendsStatus = 'Sign in to see new prints from people you follow.';
      return;
    }
    if (!hasIdentity() || !hasOutboxQuery()) {
      friendsLoading = false;
      friendsStatus = 'This shell cannot provide your follows yet.';
      return;
    }

    friendsLoading = true;
    try {
      const follows = (await identity.getFollows(pubkey)).slice(0, 80);
      if (follows.length === 0) {
        friendsStatus = 'Follow makers on Nostr to personalize this section.';
        return;
      }

      const { events } = await outbox.query(
        [{ kinds: [PRINTABLE_KIND], authors: follows, limit: FRIEND_LIMIT }],
        { authors: follows, timeoutMs: 6000 },
      );

      let next = new Map<string, PrintableObject>();
      for (const { event } of events) {
        const printable = toPrintableObject(event);
        if (!printable) continue;
        next = collectPrintable(next, printable);
        scheduleMakerLookup(printable.pubkey);
      }
      friendPrintables = next;
      friendsStatus = next.size === 0 ? 'No followed makers have published prints here yet.' : '';
    } catch (error) {
      friendsStatus = error instanceof Error ? error.message : 'Could not load your follows.';
    } finally {
      friendsLoading = false;
    }
  }

  async function openPrintable(printable: PrintableObject): Promise<void> {
    if (!hasIntent()) {
      status = 'This shell cannot open prints.';
      return;
    }
    const result = await intent.open('printable-detail', { address: printable.address });
    if (!result.ok) status = result.error ?? 'Could not open that print.';
  }

  async function openAddress(address: string): Promise<void> {
    if (!hasIntent()) return;
    const result = await intent.open('printable-detail', { address });
    if (!result.ok) makesStatus = result.error ?? 'Could not open that print.';
  }

  function openSearch(query: string): void {
    if (!hasIntent()) return;
    void intent.open('printable-browse', query ? { query } : {});
  }

  function openTopic(topic: string): void {
    if (!hasIntent()) return;
    void intent.open('printable-browse', { tag: topic });
  }

  function applyIntent(): void {
    closeDiscovery?.();
    closeMakes?.();
    printables = new Map();
    makes = new Map();
    status = '';
    makesStatus = '';
    loading = true;
    makesLoading = true;
    closeDiscovery = openDiscovery();
    closeMakes = openMakes();
  }

  onMount(() => {
    closeDiscovery = openDiscovery();
    closeMakes = openMakes();

    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then(loadFriends)
        .catch(() => loadFriends(''));
      identitySubscription = identity.onChanged((pubkey) => {
        void loadFriends(pubkey);
      });
    }

    if (!hasInc()) {
      return () => {
        identitySubscription?.unsubscribe();
        closeDiscovery?.();
        closeMakes?.();
        window.clearTimeout(makerTimer);
      };
    }

    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
      closeDiscovery?.();
      closeMakes?.();
      window.clearTimeout(makerTimer);
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4" data-testid="discover-home">
  <section class="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
    <div class="grid content-center gap-4 py-4 sm:py-8">
      <div class="max-w-3xl">
        <p class="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          STLstr discovery
        </p>
        <h1 class="mt-2 text-4xl font-black leading-tight tracking-tight sm:text-6xl">
          Find something worth printing today.
        </h1>
        <p class="mt-4 max-w-2xl text-base text-base-content/70 sm:text-lg">
          Fresh models, community makes, and new work from makers you follow, all pulled through
          your shell.
        </p>
      </div>
      <div class="join w-full max-w-2xl" role="search">
        <input
          class="input join-item w-full"
          placeholder="Search phone stands, gridfinity, minis..."
          aria-label="Search prints"
          onkeydown={(event) => {
            if (event.key === 'Enter')
              openSearch((event.currentTarget as HTMLInputElement).value.trim());
          }}
        />
        <button
          type="button"
          class="btn btn-primary join-item"
          onclick={(event) => {
            const input = event.currentTarget.parentElement?.querySelector('input');
            openSearch(input?.value.trim() ?? '');
          }}
        >
          Search
        </button>
      </div>
      <div class="flex flex-wrap gap-2" aria-label="Popular discovery topics">
        {#each ['gridfinity', 'desk', 'workshop', 'miniatures', 'tools'] as topic (topic)}
          <button
            type="button"
            class="badge badge-primary badge-soft"
            onclick={() => openTopic(topic)}
          >
            #{topic}
          </button>
        {/each}
      </div>
    </div>

    <section class="grid content-start gap-3" aria-label="Fresh makes">
      <div class="flex items-end justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold">Fresh makes</h2>
          <p class="text-sm text-base-content/60">Real prints from the community.</p>
        </div>
      </div>
      {#if makesLoading && freshMakes.length === 0}
        <div class="grid gap-3">
          {#each [0, 1, 2] as item (item)}
            <div class="skeleton h-24 w-full"></div>
          {/each}
        </div>
      {:else if freshMakes.length === 0}
        <p class="text-sm text-base-content/60" data-testid="discover-makes-empty">
          No makes have reached these relays yet.
        </p>
      {:else}
        <div class="grid gap-3" data-testid="discover-makes">
          {#each freshMakes as make (make.id)}
            <article class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
              <button type="button" class="text-left" onclick={() => openAddress(make.address)}>
                <CoverImage cover={make.cover} title={make.title} class="aspect-square" />
              </button>
              <div class="min-w-0 content-center">
                <button
                  type="button"
                  class="line-clamp-2 text-left text-sm font-semibold"
                  onclick={() => openAddress(make.address)}
                >
                  {make.title}
                </button>
                <MakerLink
                  pubkey={make.pubkey}
                  profile={makers.get(make.pubkey)}
                  testId="open-maker"
                  buttonClass="link mt-1 flex w-fit items-center gap-2 text-xs text-base-content/65"
                  fallbackClass="mt-1 flex w-fit items-center gap-2 text-xs text-base-content/65"
                  labelClass="truncate"
                  onError={(message) => (makesStatus = message)}
                />
              </div>
            </article>
          {/each}
        </div>
      {/if}
      {#if makesStatus}
        <p class="text-sm text-base-content/60" aria-live="polite">{makesStatus}</p>
      {/if}
    </section>
  </section>

  <section class="mt-8 grid gap-4" aria-label="Featured printables">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-2xl font-bold">Featured now</h2>
        <p class="text-sm text-base-content/60">
          Recent designs with images, tags, and useful descriptions.
        </p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => openSearch('')}
        >Open search</button
      >
    </div>

    {#if loading && featured.length === 0}
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading featured prints">
        {#each [0, 1, 2, 3, 4, 5] as item (item)}
          <div class="grid gap-2">
            <div class="skeleton aspect-[4/3] w-full"></div>
            <div class="skeleton h-5 w-2/3"></div>
            <div class="skeleton h-3 w-full"></div>
          </div>
        {/each}
      </div>
    {:else if featured.length === 0}
      <p class="text-base-content/70" data-testid="discover-empty">
        No printables have been published to these relays yet. Be the first to share one.
      </p>
    {:else}
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="discover-featured">
        {#each featured as entry (entry.printable.address)}
          {@const printable = entry.printable}
          <article class="grid content-start gap-2" data-testid="discover-printable">
            <button
              type="button"
              class="grid gap-2 text-left"
              data-testid="open-printable"
              data-address={printable.address}
              onclick={() => openPrintable(printable)}
            >
              <CoverImage cover={printable.cover} title={printable.title} class="aspect-[4/3]" />
              <span class="text-lg font-bold" data-testid="printable-title">{printable.title}</span>
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
                {#each printable.topics.slice(0, 4) as topic (topic)}
                  <button
                    type="button"
                    class="badge badge-ghost badge-sm"
                    onclick={() => openTopic(topic)}
                  >
                    #{topic}
                  </button>
                {/each}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div class="grid content-start gap-4" aria-label="Newest designs">
      <h2 class="text-xl font-bold">Newest designs</h2>
      <div class="grid gap-3" data-testid="discover-recent">
        {#each recent as printable (printable.address)}
          <article class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <button type="button" class="text-left" onclick={() => openPrintable(printable)}>
              <CoverImage cover={printable.cover} title={printable.title} class="aspect-video" />
            </button>
            <div class="min-w-0 content-center">
              <button
                type="button"
                class="line-clamp-2 text-left font-semibold"
                onclick={() => openPrintable(printable)}
              >
                {printable.title}
              </button>
              <p class="line-clamp-1 text-sm text-base-content/60">{printable.summary}</p>
            </div>
          </article>
        {/each}
      </div>
    </div>

    <div class="grid content-start gap-4" aria-label="Prints from followed makers">
      <div>
        <h2 class="text-xl font-bold">From people you follow</h2>
        <p class="text-sm text-base-content/60">
          Personalized with NAP-IDENTITY when you are signed in.
        </p>
      </div>
      {#if friendsLoading}
        <div class="grid gap-3">
          {#each [0, 1, 2] as item (item)}
            <div class="skeleton h-24 w-full"></div>
          {/each}
        </div>
      {:else if fromFriends.length === 0}
        <p class="text-sm text-base-content/60" data-testid="discover-friends-empty">
          {friendsStatus}
        </p>
      {:else}
        <div class="grid gap-3" data-testid="discover-friends">
          {#each fromFriends as printable (printable.address)}
            <article class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
              <button type="button" class="text-left" onclick={() => openPrintable(printable)}>
                <CoverImage cover={printable.cover} title={printable.title} class="aspect-video" />
              </button>
              <div class="min-w-0 content-center">
                <button
                  type="button"
                  class="line-clamp-2 text-left font-semibold"
                  onclick={() => openPrintable(printable)}
                >
                  {printable.title}
                </button>
                <MakerLink
                  pubkey={printable.pubkey}
                  profile={makers.get(printable.pubkey)}
                  testId="open-maker"
                  buttonClass="link mt-1 flex w-fit items-center gap-2 text-xs text-base-content/65"
                  fallbackClass="mt-1 flex w-fit items-center gap-2 text-xs text-base-content/65"
                  labelClass="truncate"
                  onError={(message) => (friendsStatus = message)}
                />
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <section class="mt-10 grid gap-3" aria-label="Browse by idea">
    <h2 class="text-xl font-bold">Browse by idea</h2>
    <div class="flex flex-wrap gap-2">
      {#each ['organization', 'replacement-parts', 'accessibility', 'gaming', 'camera', 'kitchen', 'garden', 'cosplay'] as topic (topic)}
        <button type="button" class="btn btn-outline btn-sm" onclick={() => openTopic(topic)}>
          #{topic}
        </button>
      {/each}
    </div>
  </section>

  {#if status}
    <p class="mt-4 text-sm text-base-content/60" aria-live="polite" data-testid="discover-status">
      {status}
    </p>
  {/if}
</main>
