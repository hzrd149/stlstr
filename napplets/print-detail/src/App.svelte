<script lang="ts">
  import { count, identity, inc, intent, outbox, type NostrEvent } from '@napplet/sdk';
  import { onMount } from 'svelte';
  import Comments from '@stlstr/napplet-kit/components/Comments.svelte';
  import GalleryImage from '@stlstr/napplet-kit/components/GalleryImage.svelte';
  import Markdown from '@stlstr/napplet-kit/components/Markdown.svelte';
  import { threadFilter } from '@stlstr/napplet-kit/comments';
  import { tagValue } from '@stlstr/napplet-kit/tags';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import { parseImages, type ObjectImage } from '@stlstr/napplet-kit/images';

  /**
   * The object detail page.
   *
   * The gallery, part files, owner actions, and the NIP-22 comment thread are built here.
   * Makes and remixes from `.planning/object-detail-napplet.md` are still to come.
   *
   * The address arrives over the NAP-INTENT delivery seam as a targeted `inc.event` on
   * `printable-detail:open`. Subscribe FIRST, then emit `printable-detail:ready`.
   */

  const OPEN_TOPIC = 'printable-detail:open';
  const READY_TOPIC = 'printable-detail:ready';
  const STL_PREVIEW_ARCHETYPE = 'stl-preview';

  /**
   * The sections of the tabbed lower half. Adding one means adding an entry here and a
   * matching `role="tabpanel"` block below; makes, remixes, and collections all land here.
   */
  const TABS = [
    { id: 'description', label: 'Description' },
    { id: 'comments', label: 'Comments' },
  ] as const;

  type TabId = (typeof TABS)[number]['id'];

  type PartFile = {
    id: string;
    url: string;
    name: string;
    mime: string;
    sizeBytes: number;
  };

  let title = $state('');
  let summary = $state('');
  let parts = $state<PartFile[]>([]);
  let images = $state<ObjectImage[]>([]);
  let activeImage = $state(0);
  let status = $state('Waiting for a print to open...');
  let canPreview = $state(false);
  let activeTab = $state<TabId>('description');
  let commentCount = $state<number | null>(null);
  let commentsCounting = $state(false);

  /** Address and author of the object on screen, set once it loads. */
  let address = $state('');
  let owner = $state('');
  /**
   * The object event itself. The comment thread needs the whole event, not its address:
   * applesauce builds a comment's NIP-22 tags from the parent event it is given.
   *
   * `$state.raw` is required, not a preference. Applesauce's event helpers memoize onto the
   * event with symbol properties, and writing to a deep `$state` proxy from inside a
   * `$derived` throws `state_unsafe_mutation` — which killed the whole comment thread.
   */
  let object = $state.raw<NostrEvent | null>(null);
  /** Who is signed in, per NAP-IDENTITY. Empty when nobody is, which is the safe default. */
  let viewer = $state('');

  const cover = $derived(images[activeImage] ?? images[0] ?? null);

  /** The object's Markdown body, per NIP.md. */
  const description = $derived(object?.content.trim() ?? '');

  /**
   * The owner-only gate. NAP-IDENTITY is the sole source of truth for who is signed in, so
   * a shell that does not provide it can never show the edit action.
   */
  const isOwner = $derived(Boolean(viewer && owner && viewer === owner));

  const hasOutbox = () => hasMethods('outbox', 'query');
  const hasInc = () => hasMethods('inc', 'on', 'emit');
  const hasIntentOpen = () => hasMethods('intent', 'open');
  const hasIntentAvailable = () => hasMethods('intent', 'available');
  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'onChanged');
  const hasCount = () => hasMethods('count', 'query');

  /** File references this object marks as printable parts, in publication order. */
  function partIds(tags: string[][]): string[] {
    return tags.filter((tag) => tag[0] === 'e' && tag[3] === 'part' && tag[1]).map((tag) => tag[1]);
  }

  async function loadParts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const { events } = await outbox.query([{ ids }], { timeoutMs: 5000 });
    const byId = new Map(events.map((result) => [result.event.id, result.event]));

    // Preserve the object's own ordering rather than relay arrival order.
    parts = ids.flatMap((id) => {
      const event = byId.get(id);
      if (!event) return [];

      const size = Number(tagValue(event.tags, 'size'));
      return [
        {
          id,
          url: tagValue(event.tags, 'url'),
          name: tagValue(event.tags, 'name') || 'Part file',
          mime: tagValue(event.tags, 'm'),
          sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
        },
      ];
    });
  }

  async function loadCommentCount(scope: string): Promise<void> {
    if (!scope || !hasCount()) return;

    const requestedScope = scope;
    commentsCounting = true;

    try {
      const result = await count.query(threadFilter(requestedScope), {
        approximate: false,
      });
      if (address !== requestedScope) return;
      commentCount = result.ok && typeof result.count === 'number' ? result.count : null;
    } catch {
      if (address === requestedScope) commentCount = null;
    } finally {
      if (address === requestedScope) commentsCounting = false;
    }
  }

  function commentLabel(): string {
    if (commentCount !== null) return `Comments (${commentCount})`;
    if (commentsCounting) return 'Comments (...)';
    return 'Comments';
  }

  function incrementCommentCount(): void {
    if (commentCount !== null) commentCount += 1;
  }

  // The parameter is deliberately not named `address`: that would shadow the state below,
  // and the assignments at the end would land on the local instead of the owner gate.
  async function loadObject(requested: string): Promise<void> {
    const [kind, pubkey, ...rest] = requested.split(':');
    const identifier = rest.join(':');

    if (kind !== '33500' || !pubkey || !identifier) {
      status = 'The shell opened this page with an address it could not read.';
      return;
    }

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    status = 'Loading print...';
    parts = [];
    images = [];
    activeImage = 0;
    owner = '';
    address = '';
    object = null;
    commentCount = null;
    commentsCounting = false;

    try {
      const { events } = await outbox.query(
        [{ kinds: [33500], authors: [pubkey], '#d': [identifier], limit: 1 }],
        { timeoutMs: 5000 },
      );

      const newest = events
        .map((result) => result.event)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!newest) {
        status = 'This print has not been published to the relays we can reach.';
        return;
      }

      title = tagValue(newest.tags, 'title') || identifier;
      summary = tagValue(newest.tags, 'summary');
      images = parseImages(newest.tags);
      // The author of the event is the owner — not whoever the address claimed.
      owner = newest.pubkey;
      address = `33500:${newest.pubkey}:${identifier}`;
      object = newest;
      status = '';
      void loadCommentCount(address);
      await loadParts(partIds(newest.tags));
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this print.';
    }
  }

  function preview(part: PartFile): void {
    // Dispatched by archetype: this napplet never learns that the shell renders the
    // preview in a dialog, or which napplet handles it.
    void intent.open(STL_PREVIEW_ARCHETYPE, {
      url: part.url,
      name: part.name,
      mime: part.mime,
      size: part.sizeBytes ? String(part.sizeBytes) : '',
    });
  }

  function openPart(part: PartFile): void {
    void intent.open('part-detail', { fileId: part.id });
  }

  /** Owner-only: hands the object to whichever napplet fulfills the `printable-edit` role. */
  async function edit(): Promise<void> {
    if (!address || !hasIntentOpen()) return;
    const result = await intent.open('printable-edit', { address });
    if (!result.ok) status = result.error ?? 'Could not open the editor.';
  }

  function applyIntent(payload: unknown): void {
    const address = (payload as { address?: unknown } | undefined)?.address;
    if (typeof address !== 'string' || address.length === 0) {
      status = 'The shell opened this page without a print to show.';
      return;
    }

    void loadObject(address);
  }

  function formatBytes(bytes: number): string {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  onMount(() => {
    // Feature-detected, not assumed: a shell without a preview handler still renders the
    // file list, just without the button.
    if (hasIntentAvailable()) {
      void intent
        .available(STL_PREVIEW_ARCHETYPE)
        .then((availability) => {
          canPreview = availability.available;
        })
        .catch(() => {
          canPreview = false;
        });
    }

    // Read who is signed in now, then keep it current: signing in or out has to
    // re-evaluate the owner gate without a reload.
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
      status = 'This shell cannot deliver the print to show.';
      return () => identitySubscription?.unsubscribe();
    }

    // Subscribe BEFORE signalling readiness — the shell flushes on the ready signal.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <div class="grid gap-3 lg:grid-cols-5">
    <section class="grid content-start gap-2 lg:col-span-3" aria-label="Print gallery">
      {#if images.length > 0}
        <div class="aspect-video w-full overflow-hidden rounded-box bg-base-200">
          <GalleryImage image={cover} fallbackAlt={title} />
        </div>

        {#if images.length > 1}
          <div class="flex gap-2 overflow-x-auto" data-testid="object-thumbnails">
            {#each images as image, index (image.url)}
              <button
                type="button"
                class="h-20 w-28 shrink-0 overflow-hidden rounded-box bg-base-200 {index ===
                activeImage
                  ? 'ring-2 ring-primary'
                  : ''}"
                aria-label="Show image {index + 1} of {images.length}"
                aria-current={index === activeImage}
                onclick={() => (activeImage = index)}
              >
                <GalleryImage {image} fallbackAlt={title} fit="cover" />
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- No cover yet: a skeleton while loading, nothing once we know there are none. -->
        <div class="aspect-video w-full overflow-hidden rounded-box bg-base-200">
          {#if title}
            <div class="flex h-full w-full items-center justify-center text-base-content/50">
              This print has no images.
            </div>
          {:else}
            <div class="skeleton h-full w-full"></div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="grid content-start gap-3 lg:col-span-2" aria-label="Print actions">
      {#if title}
        <h1 class="text-2xl font-bold" data-testid="object-title">{title}</h1>
      {/if}
      {#if summary}
        <p class="text-base-content/70">{summary}</p>
      {/if}
      {#if status}
        <p class="text-sm text-base-content/60" aria-live="polite" data-testid="object-status">
          {status}
        </p>
      {/if}

      {#if parts.length > 0}
        <div class="divider my-0">Files</div>
        <ul class="grid gap-2" data-testid="object-parts">
          {#each parts as part (part.id)}
            <li
              class="flex items-center justify-between gap-2 rounded-box border border-base-300 p-2"
            >
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium">{part.name}</span>
                <span class="text-xs text-base-content/60">{formatBytes(part.sizeBytes)}</span>
              </span>
              <div class="flex shrink-0 flex-wrap justify-end gap-2">
                <button
                  class="btn btn-ghost btn-sm"
                  data-testid="part-details"
                  data-file-id={part.id}
                  onclick={() => openPart(part)}
                >
                  Details
                </button>
                {#if canPreview && part.url}
                  <button
                    class="btn btn-primary btn-sm"
                    data-testid="preview-part"
                    data-file-id={part.id}
                    onclick={() => preview(part)}
                  >
                    Preview
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if isOwner}
        <!-- Owner-only: rendered solely when NAP-IDENTITY says the viewer authored this. -->
        <div class="divider my-0"></div>
        <button type="button" class="btn btn-outline" data-testid="edit-object" onclick={edit}>
          Edit this print
        </button>
      {/if}
    </section>
  </div>

  {#if object}
    <!-- The tabbed lower half. Panels are hidden rather than unmounted, so the comment
         thread keeps its live subscription and drafts across tab switches. -->
    <div class="mt-6">
      <div role="tablist" class="tabs tabs-border" data-testid="object-tabs">
        {#each TABS as tab (tab.id)}
          <button
            type="button"
            role="tab"
            id="tab-{tab.id}"
            class="tab {activeTab === tab.id ? 'tab-active' : ''}"
            aria-selected={activeTab === tab.id}
            aria-controls="panel-{tab.id}"
            data-testid="object-tab"
            data-tab={tab.id}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.id === 'comments' ? commentLabel() : tab.label}
          </button>
        {/each}
      </div>

      <div
        id="panel-description"
        role="tabpanel"
        aria-labelledby="tab-description"
        class="pt-4"
        hidden={activeTab !== 'description'}
        data-testid="object-panel-description"
      >
        {#if description}
          <Markdown source={description} />
        {:else}
          <p class="text-sm text-base-content/70">This print has no description yet.</p>
        {/if}
      </div>

      <div
        id="panel-comments"
        role="tabpanel"
        aria-labelledby="tab-comments"
        class="pt-4"
        hidden={activeTab !== 'comments'}
        data-testid="object-panel-comments"
      >
        <Comments
          {object}
          {viewer}
          active={activeTab === 'comments'}
          onCommentPublished={incrementCommentCount}
        />
      </div>
    </div>
  {/if}
</main>
