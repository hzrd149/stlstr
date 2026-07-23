<script lang="ts">
  import { inc, intent, outbox } from '@napplet/sdk';
  import { onMount } from 'svelte';

  /**
   * Placeholder part detail page.
   *
   * This owns the Nostr file-event lookup. The STL viewer only receives resource params,
   * so this page is the bridge from kind-1063 metadata to `stl-preview`.
   */

  const OPEN_TOPIC = 'part-detail:open';
  const READY_TOPIC = 'part-detail:ready';
  const STL_PREVIEW_ARCHETYPE = 'stl-preview';

  type FileMeta = {
    id: string;
    url: string;
    name: string;
    mime: string;
    sizeBytes: number;
    summary: string;
  };

  let fileId = $state('');
  let file = $state<FileMeta | null>(null);
  let status = $state('Waiting for a part to open...');
  let canPreview = $state(false);

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => {
    const domain = napplets().outbox as { query?: unknown } | undefined;
    return typeof domain?.query === 'function';
  };
  const hasInc = () => {
    const domain = napplets().inc as { on?: unknown; emit?: unknown } | undefined;
    return typeof domain?.on === 'function' && typeof domain.emit === 'function';
  };
  const hasIntentOpen = () => {
    const domain = napplets().intent as { open?: unknown } | undefined;
    return typeof domain?.open === 'function';
  };
  const hasIntentAvailable = () => {
    const domain = napplets().intent as { available?: unknown } | undefined;
    return typeof domain?.available === 'function';
  };

  function tagValue(tags: string[][], name: string): string {
    return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
  }

  function basename(url: string): string {
    try {
      const path = new URL(url).pathname;
      return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'Part file';
    } catch {
      return 'Part file';
    }
  }

  function formatBytes(bytes: number): string {
    if (!bytes) return 'Unknown size';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function loadPart(id: string): Promise<void> {
    fileId = id;
    file = null;
    status = 'Loading part...';

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    try {
      const { events } = await outbox.query([{ ids: [id], kinds: [1063], limit: 1 }], {
        timeoutMs: 5000,
      });
      const event = events.map((result) => result.event).find((candidate) => candidate);

      if (!event) {
        status = 'This part has not been published to the relays we can reach.';
        return;
      }

      const url = tagValue(event.tags, 'url');
      const size = Number(tagValue(event.tags, 'size'));
      file = {
        id,
        url,
        name: tagValue(event.tags, 'name') || tagValue(event.tags, 'alt') || basename(url),
        mime: tagValue(event.tags, 'm'),
        sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
        summary: event.content.trim(),
      };
      status = url ? '' : 'This part file does not name a downloadable URL yet.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this part.';
    }
  }

  function preview(): void {
    if (!file?.url || !hasIntentOpen()) return;
    void intent.open(STL_PREVIEW_ARCHETYPE, {
      url: file.url,
      name: file.name,
      mime: file.mime,
      size: file.sizeBytes ? String(file.sizeBytes) : '',
    });
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

    if (!hasInc()) {
      status = 'This shell cannot deliver the part to show.';
      return;
    }

    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => subscription.unsubscribe();
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="mx-auto grid max-w-3xl gap-4">
    <div class="rounded-box bg-base-200 p-5">
      <p class="text-sm font-semibold uppercase tracking-wide text-primary">Part file</p>
      <h1 class="mt-1 text-2xl font-bold" data-testid="part-title">
        {file?.name ?? 'Loading part...'}
      </h1>
      {#if status}
        <p class="mt-2 text-sm text-base-content/70" aria-live="polite" data-testid="part-status">
          {status}
        </p>
      {/if}
    </div>

    {#if file}
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-box border border-base-300 p-3">
          <p class="text-xs text-base-content/60">Type</p>
          <p class="font-medium">{file.mime || 'Unknown file type'}</p>
        </div>
        <div class="rounded-box border border-base-300 p-3">
          <p class="text-xs text-base-content/60">Size</p>
          <p class="font-medium">{formatBytes(file.sizeBytes)}</p>
        </div>
        <div class="rounded-box border border-base-300 p-3">
          <p class="text-xs text-base-content/60">Preview</p>
          <p class="font-medium">{file.url ? 'Available' : 'No URL'}</p>
        </div>
      </div>

      {#if file.summary}
        <section class="rounded-box border border-base-300 p-4">
          <h2 class="font-semibold">About this file</h2>
          <p class="mt-2 whitespace-pre-wrap text-sm text-base-content/75">{file.summary}</p>
        </section>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-primary"
          disabled={!file.url || !canPreview}
          onclick={preview}
          data-testid="part-stl-preview"
        >
          Preview STL
        </button>
      </div>
    {:else if fileId}
      <div class="skeleton h-32 w-full"></div>
    {/if}
  </section>
</main>
