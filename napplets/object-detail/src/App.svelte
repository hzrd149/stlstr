<script lang="ts">
  import { identity, inc, intent, outbox, type NostrEvent } from '@napplet/sdk';
  import { onMount } from 'svelte';
  import Comments from './lib/Comments.svelte';
  import GalleryImage from './lib/GalleryImage.svelte';
  import { parseImages, type ObjectImage } from './lib/object';

  /**
   * The object detail page.
   *
   * The gallery, part files, owner actions, and the NIP-22 comment thread are built here.
   * Makes and remixes from `.planning/object-detail-napplet.md` are still to come.
   *
   * The address arrives over the NAP-INTENT delivery seam as a targeted `inc.event` on
   * `object-detail:open`. Subscribe FIRST, then emit `object-detail:ready`.
   */

  const OPEN_TOPIC = 'object-detail:open';
  const READY_TOPIC = 'object-detail:ready';
  const PREVIEW_ARCHETYPE = 'part-preview';

  type PartFile = {
    id: string;
    name: string;
    sizeBytes: number;
  };

  let title = $state('');
  let summary = $state('');
  let parts = $state<PartFile[]>([]);
  let images = $state<ObjectImage[]>([]);
  let activeImage = $state(0);
  let status = $state('Waiting for an object to open...');
  let canPreview = $state(false);

  /** Address and author of the object on screen, set once it loads. */
  let address = $state('');
  let owner = $state('');
  /**
   * The object event itself. The comment thread needs the whole event, not its address:
   * applesauce builds a comment's NIP-22 tags from the parent event it is given.
   */
  let object = $state<NostrEvent | null>(null);
  /** Who is signed in, per NAP-IDENTITY. Empty when nobody is, which is the safe default. */
  let viewer = $state('');

  const cover = $derived(images[activeImage] ?? images[0] ?? null);

  /**
   * The owner-only gate. NAP-IDENTITY is the sole source of truth for who is signed in, so
   * a shell that does not provide it can never show the edit action.
   */
  const isOwner = $derived(Boolean(viewer && owner && viewer === owner));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => typeof napplets().outbox === 'object';
  const hasInc = () => typeof napplets().inc === 'object';
  const hasIntent = () => typeof napplets().intent === 'object';
  const hasIdentity = () => typeof napplets().identity === 'object';

  function tagValue(tags: string[][], name: string): string {
    return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
  }

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
          name: tagValue(event.tags, 'name') || 'Part file',
          sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
        },
      ];
    });
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

    status = 'Loading object...';
    parts = [];
    images = [];
    activeImage = 0;
    owner = '';
    address = '';
    object = null;

    try {
      const { events } = await outbox.query(
        [{ kinds: [33500], authors: [pubkey], '#d': [identifier], limit: 1 }],
        { timeoutMs: 5000 },
      );

      const newest = events
        .map((result) => result.event)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!newest) {
        status = 'This object has not been published to the relays we can reach.';
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
      await loadParts(partIds(newest.tags));
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this object.';
    }
  }

  function preview(part: PartFile): void {
    // Dispatched by archetype: this napplet never learns that the shell renders the
    // preview in a dialog, or which napplet handles it.
    void intent.open(PREVIEW_ARCHETYPE, { fileId: part.id });
  }

  /** Owner-only: hands the object to whichever napplet fulfills the `edit-object` role. */
  async function edit(): Promise<void> {
    if (!address || !hasIntent()) return;
    const result = await intent.open('edit-object', { address });
    if (!result.ok) status = result.error ?? 'Could not open the editor.';
  }

  function applyIntent(payload: unknown): void {
    const address = (payload as { address?: unknown } | undefined)?.address;
    if (typeof address !== 'string' || address.length === 0) {
      status = 'The shell opened this page without an object to show.';
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
    if (hasIntent()) {
      void intent
        .available(PREVIEW_ARCHETYPE)
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
      status = 'This shell cannot deliver the object to show.';
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
    <section class="grid content-start gap-2 lg:col-span-3" aria-label="Object gallery">
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
              This object has no images.
            </div>
          {:else}
            <div class="skeleton h-full w-full"></div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="grid content-start gap-3 lg:col-span-2" aria-label="Object actions">
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
              {#if canPreview}
                <button
                  class="btn btn-primary btn-sm"
                  data-testid="preview-part"
                  data-file-id={part.id}
                  onclick={() => preview(part)}
                >
                  Preview
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if isOwner}
        <!-- Owner-only: rendered solely when NAP-IDENTITY says the viewer authored this. -->
        <div class="divider my-0"></div>
        <button type="button" class="btn btn-outline" data-testid="edit-object" onclick={edit}>
          Edit this object
        </button>
      {/if}
    </section>
  </div>

  {#if object}
    <!-- Mounted only once the object resolved: the thread is scoped to it. -->
    <div class="mt-6">
      <Comments {object} {viewer} />
    </div>
  {/if}
</main>
