<script lang="ts">
  import { count, identity, inc, intent, outbox, resource, type NostrEvent } from '@napplet/sdk';
  import Comments from '@stlstr/napplet-kit/components/Comments.svelte';
  import PartThumb from '@stlstr/napplet-kit/components/PartThumb.svelte';
  import { eventThreadFilter } from '@stlstr/napplet-kit/comments';
  import { tagValue } from '@stlstr/napplet-kit/tags';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import {
    FILE_KIND,
    OBJECT_KIND,
    fileIdsFor,
    formatBytes,
    isPreviewable,
    readFileMeta,
    type FileMeta,
  } from '@stlstr/napplet-kit/files';
  import { fetchMakers, makerDisplayName, type MakerProfile } from '@stlstr/napplet-kit/profiles';
  import { looksLikeStl, parseStl } from '@stlstr/napplet-kit/stl';
  import { createViewer, type Viewer } from '@stlstr/napplet-kit/stl-viewer';
  import { onMount, tick } from 'svelte';

  /**
   * Part detail page for one NIP-94 file event.
   *
   * The page owns the file-event lookup, the NIP-22 file comment thread, and the reverse
   * object lookup that answers "which printables include this part?". The STL viewer only
   * receives resource params, so preview remains a NAP-INTENT handoff.
   */

  const OPEN_TOPIC = 'part-detail:open';
  const READY_TOPIC = 'part-detail:ready';
  const STL_PREVIEW_ARCHETYPE = 'stl-preview';
  const DETAIL_ARCHETYPE = 'printable-detail';

  const TABS = [
    { id: 'details', label: 'Details' },
    { id: 'comments', label: 'Comments' },
    { id: 'included', label: 'Included in' },
  ] as const;

  type TabId = (typeof TABS)[number]['id'];

  type PartFile = {
    eventId: string;
    createdAt: number;
    meta: FileMeta;
    description: string;
  };

  type Usage = {
    address: string;
    title: string;
    summary: string;
    pubkey: string;
    role: string;
    createdAt: number;
  };

  type PreviewPhase = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

  let fileId = $state('');
  let file = $state<PartFile | null>(null);
  let fileEvent = $state.raw<NostrEvent | null>(null);
  let status = $state('Waiting for a part to open...');
  let viewer = $state('');
  let canPreview = $state(false);
  let activeTab = $state<TabId>('details');
  let commentCount = $state<number | null>(null);
  let commentsCounting = $state(false);
  let usages = $state<Usage[]>([]);
  let usageLoading = $state(false);
  let usageLoaded = $state(false);
  let makers = $state(new Map<string, MakerProfile>());
  let previewPhase = $state<PreviewPhase>('idle');
  let previewStatus = $state('');
  let triangles = $state(0);
  let canvas = $state<HTMLCanvasElement | null>(null);

  let stlViewer: Viewer | null = null;
  let loadToken = 0;

  const canPreviewFile = $derived(Boolean(file && canPreview && isPreviewable(file.meta)));

  const hasOutbox = () => hasMethods('outbox', 'query');
  const hasInc = () => hasMethods('inc', 'on', 'emit');
  const hasIntentOpen = () => hasMethods('intent', 'open');
  const hasIntentAvailable = () => hasMethods('intent', 'available');
  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'onChanged');
  const hasCount = () => hasMethods('count', 'query');
  const hasResource = () => hasMethods('resource', 'bytes');

  function roleFor(event: NostrEvent, id: string): string {
    return event.tags.find((tag) => tag[0] === 'e' && tag[1] === id)?.[3]?.trim() ?? '';
  }

  function formatDate(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function roleLabel(role: string): string {
    switch (role) {
      case 'part':
        return 'Part';
      case 'instructions':
        return 'Instructions';
      case 'video':
        return 'Video';
      case 'preview':
        return 'Preview';
      case 'aux':
        return 'Auxiliary';
      default:
        return 'Referenced file';
    }
  }

  async function loadCommentCount(event: NostrEvent): Promise<void> {
    if (!hasCount()) return;

    const requested = event.id;
    commentsCounting = true;

    try {
      const result = await count.query(eventThreadFilter(event), { approximate: false });
      if (fileEvent?.id !== requested) return;
      commentCount = result.ok && typeof result.count === 'number' ? result.count : null;
    } catch {
      if (fileEvent?.id === requested) commentCount = null;
    } finally {
      if (fileEvent?.id === requested) commentsCounting = false;
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

  async function loadMakers(pubkeys: string[]): Promise<void> {
    const resolved = await fetchMakers(pubkeys);
    const next = new Map(makers);
    for (const maker of resolved) next.set(maker.pubkey, maker);
    makers = next;
  }

  async function renderPreview(bytes: Uint8Array): Promise<void> {
    const mesh = parseStl(bytes);
    previewPhase = 'ready';
    previewStatus = '';
    triangles = mesh.triangleCount;
    await tick();

    if (!canvas) throw new Error('The preview surface is unavailable.');
    stlViewer ??= createViewer(canvas);
    if (!stlViewer) throw new Error('This browser could not start WebGL for the 3D preview.');
    stlViewer.setMesh(mesh);
  }

  async function loadInlinePreview(part: PartFile): Promise<void> {
    const token = (loadToken += 1);
    const stale = () => token !== loadToken;

    stlViewer?.dispose();
    stlViewer = null;
    triangles = 0;

    if (!isPreviewable(part.meta)) {
      previewPhase = 'unsupported';
      previewStatus = 'This file is not an STL that can be previewed here.';
      return;
    }

    if (!hasResource()) {
      previewPhase = 'unsupported';
      previewStatus = 'This shell cannot fetch file bytes, so the STL cannot be rendered here.';
      return;
    }

    previewPhase = 'loading';
    previewStatus = 'Preparing the 3D preview...';

    try {
      const blob = await resource.bytes(part.meta.url);
      if (stale()) return;

      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (stale()) return;

      if (!looksLikeStl(bytes)) {
        previewPhase = 'unsupported';
        previewStatus = part.meta.mime
          ? `${part.meta.mime} files cannot be previewed here — STL only.`
          : 'This file is not an STL, so it cannot be previewed here.';
        return;
      }

      await renderPreview(bytes);
    } catch (error) {
      if (stale()) return;
      previewPhase = 'error';
      previewStatus = error instanceof Error ? error.message : 'That STL could not be previewed.';
    }
  }

  async function loadUsage(id: string): Promise<void> {
    if (!hasOutbox()) return;

    usageLoading = true;
    usageLoaded = false;
    usages = [];

    try {
      const { events } = await outbox.query([{ kinds: [OBJECT_KIND], '#e': [id] }], {
        timeoutMs: 6000,
      });
      if (fileId !== id) return;

      const newest = new Map<string, Usage>();
      for (const { event } of events) {
        if (!fileIdsFor(event).includes(id)) continue;
        const identifier = tagValue(event.tags, 'd');
        if (!identifier) continue;

        const address = `${OBJECT_KIND}:${event.pubkey}:${identifier}`;
        const current = newest.get(address);
        if (current && current.createdAt >= event.created_at) continue;

        newest.set(address, {
          address,
          title: tagValue(event.tags, 'title') || identifier,
          summary: tagValue(event.tags, 'summary'),
          pubkey: event.pubkey,
          role: roleFor(event, id),
          createdAt: event.created_at,
        });
      }

      usages = [...newest.values()].sort((a, b) => b.createdAt - a.createdAt);
      usageLoaded = true;
      void loadMakers(usages.map((usage) => usage.pubkey));
    } catch {
      if (fileId === id) usageLoaded = false;
    } finally {
      if (fileId === id) usageLoading = false;
    }
  }

  async function loadPart(id: string): Promise<void> {
    fileId = id;
    file = null;
    fileEvent = null;
    previewPhase = 'idle';
    previewStatus = '';
    triangles = 0;
    loadToken += 1;
    stlViewer?.dispose();
    stlViewer = null;
    usages = [];
    usageLoaded = false;
    usageLoading = false;
    commentCount = null;
    commentsCounting = false;
    activeTab = 'details';
    status = 'Loading part...';

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    try {
      const { events } = await outbox.query([{ ids: [id], kinds: [FILE_KIND], limit: 1 }], {
        timeoutMs: 5000,
      });
      const event = events.map((result) => result.event).find((candidate) => candidate);

      if (!event) {
        status = 'This part has not been published to the relays we can reach.';
        return;
      }

      const meta = readFileMeta(event.tags);
      if (!meta) {
        status = 'This part file does not name a downloadable URL yet.';
        fileEvent = event;
        return;
      }

      fileEvent = event;
      file = {
        eventId: event.id,
        createdAt: event.created_at,
        meta,
        description: event.content.trim(),
      };
      status = '';
      void loadInlinePreview(file);
      void loadCommentCount(event);
      void loadUsage(event.id);
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this part.';
    }
  }

  function preview(): void {
    if (!file?.meta.url || !hasIntentOpen()) return;
    void intent.open(STL_PREVIEW_ARCHETYPE, {
      url: file.meta.url,
      name: file.meta.name,
      mime: file.meta.mime,
      size: file.meta.sizeBytes ? String(file.meta.sizeBytes) : '',
    });
  }

  async function openObject(entry: Usage): Promise<void> {
    if (!hasIntentOpen()) return;
    const result = await intent.open(DETAIL_ARCHETYPE, { address: entry.address });
    if (!result.ok) status = result.error ?? 'Could not open that print.';
  }

  function applyIntent(payload: unknown): void {
    const id = (payload as { fileId?: unknown } | undefined)?.fileId;
    if (typeof id !== 'string' || id.length === 0) {
      status = 'The shell opened this page without a part to show.';
      return;
    }

    void loadPart(id);
  }

  onMount(() => {
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
      status = 'This shell cannot deliver the part to show.';
      return () => identitySubscription?.unsubscribe();
    }

    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
      stlViewer?.dispose();
      stlViewer = null;
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]" aria-label="Part details">
    <div class="min-w-0">
      <div class="flex min-w-0 gap-4">
        {#if file}
          <PartThumb file={file.meta} size="h-24 w-24 sm:h-32 sm:w-32" />
        {:else}
          <div class="skeleton h-24 w-24 shrink-0 rounded-box sm:h-32 sm:w-32"></div>
        {/if}

        <div class="min-w-0 content-center">
          <p class="text-sm font-semibold uppercase tracking-wide text-primary">Part file</p>
          <h1 class="mt-1 truncate text-2xl font-bold" data-testid="part-title">
            {file?.meta.name ?? 'Loading part...'}
          </h1>
          {#if file}
            <p class="mt-1 text-sm text-base-content/70">
              {[formatBytes(file.meta.sizeBytes), file.meta.mime, formatDate(file.createdAt)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          {/if}
          {#if status}
            <p class="mt-2 text-sm text-base-content/70" aria-live="polite" data-testid="part-status">
              {status}
            </p>
          {/if}
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-start justify-start gap-2 lg:justify-end">
      <button
        type="button"
        class="btn btn-primary"
        disabled={!canPreviewFile}
        onclick={preview}
        data-testid="part-stl-preview"
      >
        Preview STL
      </button>
    </div>
  </section>

  {#if file}
    <section class="mt-6 overflow-hidden rounded-box bg-base-200" aria-label="3D part preview">
      <div class="relative aspect-video min-h-64" class:hidden={previewPhase !== 'ready'}>
        <canvas
          bind:this={canvas}
          class="h-full w-full cursor-grab touch-none active:cursor-grabbing"
          data-testid="part-preview-canvas"
          aria-label="3D preview of {file.meta.name}"
        ></canvas>

        <button
          type="button"
          class="btn btn-ghost btn-xs absolute right-2 top-2"
          onclick={() => stlViewer?.resetView()}
        >
          Reset view
        </button>
      </div>

      {#if previewPhase !== 'ready'}
        <div class="grid aspect-video min-h-64 place-content-center gap-3 p-6 text-center">
          {#if previewPhase === 'loading'}
            <span class="loading loading-spinner loading-lg justify-self-center"></span>
          {:else}
            <PartThumb file={file.meta} size="h-24 w-24 justify-self-center sm:h-32 sm:w-32" />
          {/if}
          {#if previewStatus}
            <p class="text-sm text-base-content/70" aria-live="polite" data-testid="part-preview-status">
              {previewStatus}
            </p>
          {/if}
        </div>
      {/if}

      {#if previewPhase === 'ready'}
        <footer class="flex flex-wrap items-center justify-between gap-2 border-t border-base-300 px-4 py-2 text-sm">
          <span class="min-w-0 truncate font-medium">{file.meta.name}</span>
          <span class="text-base-content/60">
            {formatBytes(file.meta.sizeBytes)}
            {#if triangles}
              · {triangles.toLocaleString()} triangles
            {/if}
          </span>
        </footer>
      {/if}
    </section>
  {/if}

  {#if fileEvent}
    <div class="mt-6">
      <div role="tablist" class="tabs tabs-border" data-testid="part-tabs">
        {#each TABS as tab (tab.id)}
          <button
            type="button"
            role="tab"
            id="tab-{tab.id}"
            class="tab {activeTab === tab.id ? 'tab-active' : ''}"
            aria-selected={activeTab === tab.id}
            aria-controls="panel-{tab.id}"
            data-testid="part-tab"
            data-tab={tab.id}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.id === 'comments' ? commentLabel() : tab.label}
          </button>
        {/each}
      </div>

      <div
        id="panel-details"
        role="tabpanel"
        aria-labelledby="tab-details"
        class="pt-4"
        hidden={activeTab !== 'details'}
        data-testid="part-panel-details"
      >
        {#if file}
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-box border border-base-300 p-3">
              <p class="text-xs text-base-content/60">Type</p>
              <p class="font-medium">{file.meta.mime || 'Unknown file type'}</p>
            </div>
            <div class="rounded-box border border-base-300 p-3">
              <p class="text-xs text-base-content/60">Size</p>
              <p class="font-medium">{formatBytes(file.meta.sizeBytes) || 'Unknown size'}</p>
            </div>
            <div class="rounded-box border border-base-300 p-3">
              <p class="text-xs text-base-content/60">Preview</p>
              <p class="font-medium">{canPreviewFile ? 'Available' : 'Not available'}</p>
            </div>
          </div>

          {#if file.description}
            <section class="mt-4">
              <h2 class="font-semibold">About this file</h2>
              <p class="mt-2 whitespace-pre-wrap text-sm text-base-content/75">
                {file.description}
              </p>
            </section>
          {:else}
            <p class="mt-4 text-sm text-base-content/70">This part has no description yet.</p>
          {/if}
        {/if}
      </div>

      <div
        id="panel-comments"
        role="tabpanel"
        aria-labelledby="tab-comments"
        class="pt-4"
        hidden={activeTab !== 'comments'}
        data-testid="part-panel-comments"
      >
        <Comments
          object={fileEvent}
          {viewer}
          active={activeTab === 'comments'}
          placeholder="Ask about fit, print settings, or file compatibility..."
          emptyText="No comments yet. Be the first to ask about this part."
          onCommentPublished={incrementCommentCount}
        />
      </div>

      <div
        id="panel-included"
        role="tabpanel"
        aria-labelledby="tab-included"
        class="pt-4"
        hidden={activeTab !== 'included'}
        data-testid="part-panel-included"
      >
        {#if usageLoading && usages.length === 0}
          <div class="grid gap-2" aria-label="Loading printables that include this part">
            {#each [0, 1] as row (row)}
              <div class="skeleton h-16 w-full"></div>
            {/each}
          </div>
        {:else if usageLoaded && usages.length === 0}
          <p class="text-sm text-base-content/70" data-testid="part-included-empty">
            No prints on the relays we can reach reference this part yet. That is not proof none do.
          </p>
        {:else if usages.length > 0}
          <ul class="grid gap-2" data-testid="part-included-list">
            {#each usages as entry (entry.address)}
              <li class="rounded-box border border-base-300 p-3" data-testid="part-included-row">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <button
                      type="button"
                      class="link text-left font-medium"
                      data-testid="open-included-print"
                      data-address={entry.address}
                      onclick={() => openObject(entry)}
                    >
                      {entry.title}
                    </button>
                    {#if entry.summary}
                      <p class="mt-1 line-clamp-2 text-sm text-base-content/70">{entry.summary}</p>
                    {/if}
                    <p class="mt-1 text-xs text-base-content/60">
                      by {makerDisplayName(makers.get(entry.pubkey))}
                    </p>
                  </div>
                  <span class="badge badge-ghost badge-sm">{roleLabel(entry.role)}</span>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-base-content/70">Looking for prints that include this part...</p>
        {/if}
      </div>
    </div>
  {:else if fileId}
    <div class="mt-4 skeleton h-32 w-full"></div>
  {/if}
</main>
