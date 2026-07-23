<script lang="ts">
  import { count, identity, inc, intent, outbox, type NostrEvent } from '@napplet/sdk';
  import { onMount } from 'svelte';
  import Comments from '@stlstr/napplet-kit/components/Comments.svelte';
  import GalleryImage from '@stlstr/napplet-kit/components/GalleryImage.svelte';
  import MakerLink from '@stlstr/napplet-kit/components/MakerLink.svelte';
  import Markdown from '@stlstr/napplet-kit/components/Markdown.svelte';
  import { eventThreadFilter } from '@stlstr/napplet-kit/comments';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import { MAKE_KIND, OBJECT_KIND } from '@stlstr/napplet-kit/files';
  import { parseImages, type ObjectImage } from '@stlstr/napplet-kit/images';
  import { fetchMakers, type MakerProfile } from '@stlstr/napplet-kit/profiles';
  import { tagValue } from '@stlstr/napplet-kit/tags';

  /**
   * Make detail page for one kind:2351 make event (see NIP.md, "Make").
   *
   * A make is a regular, immutable event: this page only reads it. It owns the make lookup,
   * the make's NIP-22 comment thread, the maker profile, and the reverse lookup of the
   * parent printable named in the make's `a` tag. Opening the parent print or the maker
   * profile is a NAP-INTENT handoff — this napplet never navigates the shell itself.
   */

  const OPEN_TOPIC = 'make-detail:open';
  const READY_TOPIC = 'make-detail:ready';
  const DETAIL_ARCHETYPE = 'printable-detail';

  const TABS = [
    { id: 'notes', label: 'Notes' },
    { id: 'comments', label: 'Comments' },
  ] as const;

  type TabId = (typeof TABS)[number]['id'];

  let eventId = $state('');
  let makeEvent = $state.raw<NostrEvent | null>(null);
  let images = $state<ObjectImage[]>([]);
  let notes = $state('');
  let status = $state('Waiting for a make to open...');
  let activeTab = $state<TabId>('notes');
  let viewer = $state('');
  let commentCount = $state<number | null>(null);
  let commentsCounting = $state(false);

  let parentAddress = $state('');
  let parentTitle = $state('');
  let maker = $state<MakerProfile | undefined>(undefined);

  const cover = $derived(images[0] ?? null);
  const rest = $derived(images.slice(1));

  const hasOutbox = () => hasMethods('outbox', 'query');
  const hasInc = () => hasMethods('inc', 'on', 'emit');
  const hasIntentOpen = () => hasMethods('intent', 'open');
  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'onChanged');
  const hasCount = () => hasMethods('count', 'query');

  function formatDate(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /** The `a` tag names the printable this make was made from (NIP.md requires it). */
  function parentAddressOf(event: NostrEvent): string {
    const address = event.tags.find((tag) => tag[0] === 'a')?.[1]?.trim() ?? '';
    return address.startsWith(`${OBJECT_KIND}:`) ? address : '';
  }

  function commentLabel(): string {
    if (commentCount !== null) return `Comments (${commentCount})`;
    if (commentsCounting) return 'Comments (...)';
    return 'Comments';
  }

  function incrementCommentCount(): void {
    if (commentCount !== null) commentCount += 1;
  }

  async function loadCommentCount(event: NostrEvent): Promise<void> {
    if (!hasCount()) return;

    const requested = event.id;
    commentsCounting = true;

    try {
      const result = await count.query(eventThreadFilter(event), { approximate: false });
      if (makeEvent?.id !== requested) return;
      commentCount = result.ok && typeof result.count === 'number' ? result.count : null;
    } catch {
      if (makeEvent?.id === requested) commentCount = null;
    } finally {
      if (makeEvent?.id === requested) commentsCounting = false;
    }
  }

  async function loadMaker(pubkey: string): Promise<void> {
    const [resolved] = await fetchMakers([pubkey]);
    if (makeEvent?.pubkey === pubkey) maker = resolved;
  }

  /** Resolves the parent printable's title for the "made from" link. */
  async function loadParent(address: string): Promise<void> {
    parentAddress = address;
    parentTitle = '';
    if (!hasOutbox()) return;

    const [, pubkey, ...rest] = address.split(':');
    const identifier = rest.join(':');
    if (!pubkey || !identifier) return;

    try {
      const { events } = await outbox.query(
        [{ kinds: [OBJECT_KIND], authors: [pubkey], '#d': [identifier], limit: 1 }],
        { timeoutMs: 5000 },
      );
      const event = events.map((result) => result.event).find((candidate) => candidate);
      if (parentAddress !== address) return;
      parentTitle = event ? tagValue(event.tags, 'title') || identifier : identifier;
    } catch {
      if (parentAddress === address) parentTitle = identifier;
    }
  }

  async function loadMake(id: string): Promise<void> {
    eventId = id;
    makeEvent = null;
    images = [];
    notes = '';
    parentAddress = '';
    parentTitle = '';
    maker = undefined;
    commentCount = null;
    commentsCounting = false;
    activeTab = 'notes';
    status = 'Loading make...';

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    try {
      const { events } = await outbox.query([{ ids: [id], kinds: [MAKE_KIND], limit: 1 }], {
        timeoutMs: 5000,
      });
      const event = events.map((result) => result.event).find((candidate) => candidate);
      if (eventId !== id) return;

      if (!event) {
        status = 'This make has not been published to the relays we can reach.';
        return;
      }

      makeEvent = event;
      images = parseImages(event.tags);
      notes = event.content.trim();
      status = '';

      const address = parentAddressOf(event);
      if (address) void loadParent(address);
      void loadMaker(event.pubkey);
      void loadCommentCount(event);
    } catch (error) {
      if (eventId === id) status = error instanceof Error ? error.message : 'Could not load this make.';
    }
  }

  async function openParent(): Promise<void> {
    if (!parentAddress || !hasIntentOpen()) return;
    const result = await intent.open(DETAIL_ARCHETYPE, { address: parentAddress });
    if (!result.ok) status = result.error ?? 'Could not open that print.';
  }

  function applyIntent(payload: unknown): void {
    const id = (payload as { eventId?: unknown } | undefined)?.eventId;
    if (typeof id !== 'string' || id.length === 0) {
      status = 'The shell opened this page without a make to show.';
      return;
    }

    void loadMake(id);
  }

  onMount(() => {
    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then((pubkey) => {
          viewer = pubkey;
        })
        .catch(() => {
          viewer = '';
        });
      identitySubscription = identity.onChanged((pubkey) => {
        viewer = pubkey;
      });
    }

    if (!hasInc()) {
      status = 'This shell cannot deliver the make to show.';
      return () => identitySubscription?.unsubscribe();
    }

    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="mx-auto max-w-3xl">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold uppercase tracking-wide text-primary">Make</p>
        {#if parentAddress}
          <p class="mt-1 text-sm text-base-content/70">
            Made from
            <button
              type="button"
              class="link link-hover font-medium"
              data-testid="make-parent-link"
              data-address={parentAddress}
              onclick={openParent}
            >
              {parentTitle || 'a printable object'}
            </button>
          </p>
        {/if}
      </div>

      {#if makeEvent}
        <div class="flex items-center gap-3">
          <MakerLink pubkey={makeEvent.pubkey} profile={maker} testId="make-maker" />
          <span class="text-sm text-base-content/60">{formatDate(makeEvent.created_at)}</span>
        </div>
      {/if}
    </header>

    {#if status}
      <p class="mt-3 text-sm text-base-content/70" aria-live="polite" data-testid="make-status">
        {status}
      </p>
    {/if}

    {#if makeEvent}
      {#if cover}
        <section class="mt-4" aria-label="Make photos">
          <div class="overflow-hidden rounded-box bg-base-200">
            <div class="grid aspect-video place-items-center">
              <GalleryImage image={cover} fit="cover" />
            </div>
          </div>
          {#if rest.length > 0}
            <div class="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="make-gallery-rest">
              {#each rest as image, index (image.url + index)}
                <div class="aspect-square overflow-hidden rounded-box bg-base-200">
                  <GalleryImage {image} fit="cover" />
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <div class="mt-6">
        <div role="tablist" class="tabs tabs-border" data-testid="make-tabs">
          {#each TABS as tab (tab.id)}
            <button
              type="button"
              role="tab"
              id="tab-{tab.id}"
              class="tab {activeTab === tab.id ? 'tab-active' : ''}"
              aria-selected={activeTab === tab.id}
              aria-controls="panel-{tab.id}"
              data-testid="make-tab"
              data-tab={tab.id}
              onclick={() => (activeTab = tab.id)}
            >
              {tab.id === 'comments' ? commentLabel() : tab.label}
            </button>
          {/each}
        </div>

        <div
          id="panel-notes"
          role="tabpanel"
          aria-labelledby="tab-notes"
          class="pt-4"
          hidden={activeTab !== 'notes'}
          data-testid="make-panel-notes"
        >
          {#if notes}
            <Markdown source={notes} />
          {:else}
            <p class="text-sm text-base-content/70">This make has no notes.</p>
          {/if}
        </div>

        <div
          id="panel-comments"
          role="tabpanel"
          aria-labelledby="tab-comments"
          class="pt-4"
          hidden={activeTab !== 'comments'}
          data-testid="make-panel-comments"
        >
          <Comments
            object={makeEvent}
            {viewer}
            active={activeTab === 'comments'}
            placeholder="Ask the maker about settings, materials, or how it turned out..."
            emptyText="No comments yet. Be the first to reply to this make."
            onCommentPublished={incrementCommentCount}
          />
        </div>
      </div>
    {:else if eventId}
      <div class="mt-4 skeleton h-64 w-full"></div>
    {/if}
  </section>
</main>
