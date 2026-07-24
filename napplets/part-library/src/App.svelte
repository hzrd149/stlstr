<script lang="ts">
  import { identity, inc, intent, link, outbox, type NostrEvent } from '@napplet/sdk';
  import {
    FILE_KIND,
    OBJECT_KIND,
    fileIdsFor,
    formatBytes,
    isModelFile,
    isPreviewable,
    readFileMeta,
    type FileMeta,
  } from '@stlstr/napplet-kit/files';
  import { fetchMakers, makerDisplayName, type MakerProfile } from '@stlstr/napplet-kit/profiles';
  import { tagValue } from '@stlstr/napplet-kit/tags';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import PartThumb from '@stlstr/napplet-kit/components/PartThumb.svelte';
  import { buildSlicerBridgeUri, isSlicerOpenableFile } from '@stlstr/napplet-kit/slicers';
  import { onMount } from 'svelte';

  /**
   * The signed-in user's own part files.
   *
   * Every file is an independent NIP-94 `kind:1063` event (see NIP.md). Until now they were
   * only ever created as a side effect of publishing an object, which made them invisible
   * to the person who owns them: unreachable except through whichever object happens to
   * reference them, and impossible to audit or reuse.
   *
   * The role a file plays — `part`, `instructions`, `aux` — lives on the referencing
   * object's `e` tag, not on the file event, because the same file can be a part in one
   * object and an auxiliary in another. So this page cannot group or filter by role. It
   * shows files, and answers "what uses this" by querying the other direction.
   */

  const OPEN_TOPIC = 'part-library:open';
  const READY_TOPIC = 'part-library:ready';
  const PREVIEW_ARCHETYPE = 'stl-preview';
  const UPLOAD_ARCHETYPE = 'part-upload';
  const DETAIL_ARCHETYPE = 'printable-detail';

  /** How many files to pull. Pagination is a follow-up. */
  const LIBRARY_LIMIT = 200;

  /**
   * File ids per usage query. `#e` takes a set, so usage for the whole library resolves in
   * a handful of round trips rather than one per file — but an unbounded filter is a good
   * way to have a relay refuse the whole request.
   */
  const USAGE_BATCH = 50;

  type LibraryFile = {
    eventId: string;
    createdAt: number;
    meta: FileMeta;
    description: string;
  };

  /** One object that references a file. May belong to someone else — see `loadUsage`. */
  type Usage = {
    address: string;
    title: string;
    pubkey: string;
  };

  let viewer = $state('');
  let identityReady = $state(false);
  let files = $state<LibraryFile[]>([]);
  let usage = $state(new Map<string, Usage[]>());
  let makers = $state(new Map<string, MakerProfile>());
  let expanded = $state('');
  let loading = $state(false);
  let usageLoaded = $state(false);
  let status = $state('');
  let search = $state('');
  let modelsOnly = $state(false);
  let canPreview = $state(false);
  let canUpload = $state(false);

  const signedIn = $derived(Boolean(viewer));

  const visible = $derived(
    files.filter((file) => {
      if (modelsOnly && !isModelFile(file.meta)) return false;
      const needle = search.trim().toLowerCase();
      return !needle || file.meta.name.toLowerCase().includes(needle);
    }),
  );

  /**
   * How many library entries share each file's bytes. More than one means the same file was
   * published as several events — harmless to the relays, confusing to a human, and worth
   * surfacing since this page is the only place it is visible.
   */
  const duplicateCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const file of files) {
      if (!file.meta.sha256) continue;
      counts.set(file.meta.sha256, (counts.get(file.meta.sha256) ?? 0) + 1);
    }
    return counts;
  });

  const hasInc = () => hasMethods('inc', 'emit', 'on');
  const hasOutbox = () => hasMethods('outbox', 'query');
  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'onChanged');
  const hasIntentOpen = () => hasMethods('intent', 'open');
  const hasIntentAvailable = () => hasMethods('intent', 'available');
  const hasLink = () => hasMethods('link', 'open');

  function toLibraryFile(event: NostrEvent): LibraryFile | null {
    const meta = readFileMeta(event.tags);
    if (!meta) return null;
    return {
      eventId: event.id,
      createdAt: event.created_at,
      meta,
      description: event.content.trim(),
    };
  }

  function formatDate(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  // ---------------------------------------------------------------- loading

  async function loadLibrary(pubkey: string): Promise<void> {
    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    loading = true;
    usageLoaded = false;
    usage = new Map();
    expanded = '';

    try {
      const { events } = await outbox.query(
        [{ kinds: [FILE_KIND], authors: [pubkey], limit: LIBRARY_LIMIT }],
        { timeoutMs: 6000 },
      );

      // The same event can arrive from several relays.
      const unique = new Map<string, NostrEvent>();
      for (const { event } of events) unique.set(event.id, event);

      // Guard against a slow query for a previous account landing after a switch.
      if (viewer !== pubkey) return;

      files = [...unique.values()]
        .map(toLibraryFile)
        .filter((file): file is LibraryFile => file !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
      status = '';

      await loadUsage(pubkey);
    } catch (error) {
      if (viewer !== pubkey) return;
      status = error instanceof Error ? error.message : 'Could not load your parts.';
    } finally {
      if (viewer === pubkey) loading = false;
    }
  }

  /**
   * Resolves which objects reference these files, per NIP.md's "find objects using a
   * specific file event" query.
   *
   * Deliberately **not** author-scoped. Files are meant to be shared — the NIP asks clients
   * to let objects reference other people's file events — so a stranger's object appearing
   * here is correct, and is exactly what someone needs to know before removing a file.
   *
   * What it finds is bounded by the relays the shell reads. An empty result means "nothing
   * we can see", never "nothing exists", and the UI says so rather than implying proof.
   */
  async function loadUsage(pubkey: string): Promise<void> {
    const ids = files.map((file) => file.eventId);
    if (ids.length === 0) {
      usageLoaded = true;
      return;
    }

    const collected = new Map<string, Usage[]>();
    const referrers = new Set<string>();

    try {
      for (let start = 0; start < ids.length; start += USAGE_BATCH) {
        const batch = ids.slice(start, start + USAGE_BATCH);
        const { events } = await outbox.query([{ kinds: [OBJECT_KIND], '#e': batch }], {
          timeoutMs: 6000,
        });
        if (viewer !== pubkey) return;

        const inBatch = new Set(batch);
        const seen = new Set<string>();

        for (const { event } of events) {
          const identifier = tagValue(event.tags, 'd');
          if (!identifier) continue;

          const address = `${OBJECT_KIND}:${event.pubkey}:${identifier}`;
          // Addressable events arrive in several revisions; one entry per address.
          if (seen.has(address)) continue;
          seen.add(address);

          const entry: Usage = {
            address,
            title: tagValue(event.tags, 'title') || identifier,
            pubkey: event.pubkey,
          };

          // One object can reference several of the files in this batch.
          for (const fileId of fileIdsFor(event)) {
            if (!inBatch.has(fileId)) continue;
            collected.set(fileId, [...(collected.get(fileId) ?? []), entry]);
          }
          if (event.pubkey !== pubkey) referrers.add(event.pubkey);
        }
      }

      usage = collected;
      usageLoaded = true;
      if (referrers.size > 0) void loadMakers([...referrers]);
    } catch {
      // Usage is supplementary to the list. A failure leaves the badges absent rather than
      // showing a zero, which would read as "safe to remove".
      usageLoaded = false;
    }
  }

  /** Names for the other people whose objects use these files. */
  async function loadMakers(pubkeys: string[]): Promise<void> {
    const resolved = await fetchMakers(pubkeys);
    const next = new Map(makers);
    for (const maker of resolved) next.set(maker.pubkey, maker);
    makers = next;
  }

  // ---------------------------------------------------------------- actions

  function usageFor(file: LibraryFile): Usage[] {
    return usage.get(file.eventId) ?? [];
  }

  function toggleUsage(file: LibraryFile): void {
    expanded = expanded === file.eventId ? '' : file.eventId;
  }

  function preview(file: LibraryFile): void {
    // Dispatched by archetype: this napplet never learns which napplet renders a preview,
    // or that the shell shows it in a dialog.
    //
    // The viewer takes resource parameters rather than an event id — it has no relay
    // access of its own — so the caller passes what it already read off the `kind:1063`.
    void intent.open(PREVIEW_ARCHETYPE, {
      url: file.meta.url,
      name: file.meta.name,
      mime: file.meta.mime,
      size: String(file.meta.sizeBytes),
    });
  }

  function download(file: LibraryFile): void {
    if (hasLink()) void link.open(file.meta.url, { label: file.meta.name });
  }

  function openInSlicer(file: LibraryFile): void {
    if (!hasLink()) return;
    const uri = buildSlicerBridgeUri([file.meta]);
    if (uri) void link.open(uri, { label: `Open ${file.meta.name} in slicer` });
  }

  async function openObject(entry: Usage): Promise<void> {
    if (!hasIntentOpen()) return;
    const result = await intent.open(DETAIL_ARCHETYPE, { address: entry.address });
    if (!result.ok) status = result.error ?? 'Could not open that object.';
  }

  async function openUpload(): Promise<void> {
    if (!hasIntentOpen()) return;
    const result = await intent.open(UPLOAD_ARCHETYPE, {});
    if (!result.ok) status = result.error ?? 'Could not open the uploader.';
  }

  // ---------------------------------------------------------------- lifecycle

  function applyViewer(pubkey: string): void {
    if (pubkey === viewer) return;
    viewer = pubkey;
    files = [];
    usage = new Map();
    expanded = '';
    status = '';
    if (pubkey) void loadLibrary(pubkey);
  }

  onMount(() => {
    // Feature-detected, not assumed: a shell with no preview or upload handler still shows
    // the library, just without those actions.
    if (hasIntentAvailable()) {
      void intent
        .available(PREVIEW_ARCHETYPE)
        .then((availability) => (canPreview = availability.available))
        .catch(() => (canPreview = false));
      void intent
        .available(UPLOAD_ARCHETYPE)
        .then((availability) => (canUpload = availability.available))
        .catch(() => (canUpload = false));
    }

    // NAP-IDENTITY is the only source for who the user is, and it has two halves: the
    // answer at mount and the push that keeps it current. Without the subscription this
    // page would still show the previous account's files after a switch.
    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then((pubkey) => {
          identityReady = true;
          applyViewer(pubkey);
        })
        .catch(() => {
          identityReady = true;
          applyViewer('');
        });
      identitySubscription = identity.onChanged((pubkey) => {
        identityReady = true;
        applyViewer(pubkey);
      });
    } else {
      identityReady = true;
      status = 'This shell cannot tell us who is signed in, so your parts cannot be listed.';
    }

    if (!hasInc()) return () => identitySubscription?.unsubscribe();

    // Subscribe BEFORE signalling readiness, or the shell flushes into a dead listener.
    const subscription = inc.on(OPEN_TOPIC, () => {});
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold">Your parts</h1>
      <p class="text-sm text-base-content/70">
        Files you have published, and the objects that use them.
      </p>
    </div>
    {#if canUpload && signedIn}
      <button type="button" class="btn btn-primary" data-testid="upload-part" onclick={openUpload}>
        Upload a part
      </button>
    {/if}
  </header>

  {#if signedIn && files.length > 0}
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <input
        class="input w-full sm:w-80"
        placeholder="Filter by file name"
        aria-label="Filter parts by file name"
        bind:value={search}
      />
      <label class="label cursor-pointer gap-2">
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={modelsOnly}
          data-testid="models-only"
        />
        <span class="label-text">Models only</span>
      </label>
    </div>
  {/if}

  {#if !identityReady}
    <section class="mt-4 grid gap-2" aria-label="Loading parts">
      {#each [0, 1, 2] as placeholder (placeholder)}
        <div class="skeleton h-16 w-full"></div>
      {/each}
    </section>
  {:else if !signedIn}
    <p class="mt-6 text-base-content/70" data-testid="parts-signed-out">
      Sign in to see the parts you have published.
    </p>
  {:else if loading && files.length === 0}
    <section class="mt-4 grid gap-2" aria-label="Loading parts">
      {#each [0, 1, 2] as placeholder (placeholder)}
        <div class="skeleton h-16 w-full"></div>
      {/each}
    </section>
  {:else if files.length === 0}
    <p class="mt-6 text-base-content/70" data-testid="parts-empty">
      You have not published any parts to these relays yet.
    </p>
  {:else if visible.length === 0}
    <p class="mt-6 text-base-content/70" data-testid="parts-filtered-empty">
      No parts match that filter.
    </p>
  {:else}
    <ul class="mt-4 grid gap-2" data-testid="parts-list">
      {#each visible as file (file.eventId)}
        {@const uses = usageFor(file)}
        {@const duplicates = duplicateCounts.get(file.meta.sha256) ?? 1}
        <li class="rounded-box border border-base-300 p-3" data-testid="part-row">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 gap-3">
              <PartThumb file={file.meta} />
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate font-medium" data-testid="part-name">{file.meta.name}</span>
                  {#if duplicates > 1}
                    <!-- Same bytes, several events. Only visible from here, so it is named
                         rather than silently rendered as unrelated rows. -->
                    <span class="badge badge-warning badge-sm" data-testid="part-duplicate">
                      {duplicates} copies
                    </span>
                  {/if}
                </div>
                <div class="text-xs text-base-content/60">
                  {[formatBytes(file.meta.sizeBytes), file.meta.mime, formatDate(file.createdAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {#if file.description}
                  <p class="mt-1 line-clamp-2 text-sm text-base-content/70">{file.description}</p>
                {/if}
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              {#if usageLoaded}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="part-usage-toggle"
                  aria-expanded={expanded === file.eventId}
                  onclick={() => toggleUsage(file)}
                >
                  {uses.length === 0 ? 'Not used' : `Used in ${uses.length}`}
                </button>
              {/if}
              {#if canPreview && isPreviewable(file.meta)}
                <button
                  type="button"
                  class="btn btn-outline btn-sm"
                  data-testid="preview-part"
                  data-file-id={file.eventId}
                  onclick={() => preview(file)}
                >
                  Preview
                </button>
              {/if}
              {#if hasLink()}
                {#if isSlicerOpenableFile(file.meta)}
                  <button
                    type="button"
                    class="btn btn-outline btn-sm"
                    data-testid="open-in-slicer"
                    onclick={() => openInSlicer(file)}
                  >
                    Open in slicer
                  </button>
                {/if}
                <button
                  type="button"
                  class="btn btn-outline btn-sm"
                  data-testid="download-part"
                  onclick={() => download(file)}
                >
                  Download
                </button>
              {/if}
            </div>
          </div>

          {#if expanded === file.eventId}
            <div class="mt-3 border-t border-base-300 pt-3" data-testid="part-usage">
              {#if uses.length === 0}
                <p class="text-sm text-base-content/70">
                  No object on the relays we can reach references this file. That is not proof none
                  does.
                </p>
              {:else}
                <ul class="grid gap-1">
                  {#each uses as entry (entry.address)}
                    <li class="flex flex-wrap items-center gap-2 text-sm">
                      <button
                        type="button"
                        class="link"
                        data-testid="open-usage"
                        data-address={entry.address}
                        onclick={() => openObject(entry)}
                      >
                        {entry.title}
                      </button>
                      {#if entry.pubkey !== viewer}
                        <!-- Someone else's object. Correct and expected — the NIP asks
                             clients to allow it — but it must never look like the user's. -->
                        <span class="badge badge-ghost badge-sm" data-testid="usage-other-author">
                          by {makerDisplayName(makers.get(entry.pubkey))}
                        </span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if status}
    <p class="mt-4 text-sm text-base-content/60" aria-live="polite" data-testid="parts-status">
      {status}
    </p>
  {/if}
</main>
