<script lang="ts">
  import { inc, link, outbox, resource } from '@napplet/sdk';
  import { onMount, tick } from 'svelte';
  import { looksLikeStl, parseStl } from './stl';
  import { createViewer, type Viewer } from './viewer';

  /**
   * Renders one printable part in 3D.
   *
   * The file arrives over the NAP-INTENT delivery seam as a kind-1063 event id: NAP-INTENT
   * is outbound-only from a napplet's side, so the shell hands the payload over as a
   * targeted `inc.event` on `part-preview:open`. Subscribe FIRST, then emit
   * `part-preview:ready`, or the shell flushes into a napplet that is not listening yet.
   *
   * This napplet is always hosted in the shell's centered dialog rather than as a page, so
   * it must read at any size from a phone-height sheet to a desktop modal.
   */

  const OPEN_TOPIC = 'part-preview:open';
  const READY_TOPIC = 'part-preview:ready';

  /**
   * Mirrors the shell's NAP-RESOURCE `MAX_BYTES`. Real parts routinely exceed it, so this
   * is a designed state and not an error: check the published `size` before fetching, and
   * offer the download rather than starting a request destined to be refused mid-stream.
   */
  const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

  type FileMeta = {
    url: string;
    name: string;
    mime: string;
    sizeBytes: number;
  };

  type Phase = 'idle' | 'loading' | 'ready' | 'too-large' | 'unsupported' | 'error';

  let phase = $state<Phase>('idle');
  let status = $state('Waiting for a part to preview...');
  let file = $state<FileMeta | null>(null);
  let triangles = $state(0);
  let canvas = $state<HTMLCanvasElement | null>(null);

  let viewer: Viewer | null = null;
  /** Guards against a stale fetch resolving after a newer part has been delivered. */
  let loadToken = 0;

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => typeof napplets().outbox === 'object';
  const hasResource = () => typeof napplets().resource === 'object';
  const hasInc = () => typeof napplets().inc === 'object';
  const hasLink = () => typeof napplets().link === 'object';

  function formatBytes(bytes: number): string {
    if (!bytes) return 'unknown size';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function basename(url: string): string {
    try {
      const path = new URL(url).pathname;
      return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'part file';
    } catch {
      return 'part file';
    }
  }

  /** Reads the NIP-94 tags a kind-1063 file event carries. */
  function readFileMeta(tags: string[][]): FileMeta | null {
    const value = (name: string) => tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';

    const url = value('url');
    if (!url) return null;

    const size = Number(value('size'));
    return {
      url,
      name: value('name') || value('alt') || basename(url),
      mime: value('m'),
      sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    };
  }

  function download(): void {
    if (!file) return;
    if (hasLink()) void link.open(file.url, { label: file.name });
  }

  async function render(bytes: Uint8Array): Promise<void> {
    const mesh = parseStl(bytes);

    // Show the canvas before handing it a mesh: the viewer sizes its drawing buffer from
    // the element's layout box, which is zero while the container is still hidden.
    phase = 'ready';
    status = '';
    triangles = mesh.triangleCount;
    await tick();

    if (!canvas) throw new Error('The preview surface is unavailable.');
    // Created lazily so a part that never renders never claims a WebGL context, and kept
    // across redeliveries so switching parts does not rebuild the context.
    viewer ??= createViewer(canvas);
    if (!viewer) throw new Error('This browser could not start WebGL for the 3D preview.');

    viewer.setMesh(mesh);
  }

  async function loadFile(fileId: string): Promise<void> {
    const token = (loadToken += 1);
    const stale = () => token !== loadToken;

    file = null;
    triangles = 0;
    phase = 'loading';
    status = 'Looking up the file...';

    if (!hasOutbox()) {
      phase = 'error';
      status = 'This shell does not provide relay access.';
      return;
    }

    try {
      const { events } = await outbox.query([{ ids: [fileId] }], { timeoutMs: 5000 });
      if (stale()) return;

      const event = events.map((result) => result.event).find((candidate) => candidate);
      if (!event) {
        phase = 'error';
        status = 'That file could not be found on the relays.';
        return;
      }

      const meta = readFileMeta(event.tags);
      if (!meta) {
        phase = 'error';
        status = 'That file event does not name a URL to fetch.';
        return;
      }
      file = meta;

      // Refuse before fetching, not after: the shell would reject these bytes mid-stream.
      if (meta.sizeBytes > MAX_PREVIEW_BYTES) {
        phase = 'too-large';
        status = `This part is ${formatBytes(meta.sizeBytes)}, past the ${formatBytes(MAX_PREVIEW_BYTES)} the shell will fetch.`;
        return;
      }

      if (!hasResource()) {
        phase = 'unsupported';
        status = 'This shell cannot fetch file bytes, so the part cannot be rendered here.';
        return;
      }

      status = 'Downloading the part...';
      const blob = await resource.bytes(meta.url);
      if (stale()) return;

      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (stale()) return;

      if (!looksLikeStl(bytes)) {
        phase = 'unsupported';
        status = meta.mime
          ? `${meta.mime} files cannot be previewed yet — STL only for now.`
          : 'This file is not an STL, so it cannot be previewed yet.';
        return;
      }

      await render(bytes);
    } catch (error) {
      if (stale()) return;
      phase = 'error';
      status = error instanceof Error ? error.message : 'That part could not be previewed.';
    }
  }

  function applyIntent(payload: unknown): void {
    const fileId = (payload as { fileId?: unknown } | undefined)?.fileId;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      phase = 'error';
      status = 'The shell opened the preview without a file to show.';
      return;
    }

    void loadFile(fileId);
  }

  onMount(() => {
    if (!hasInc()) {
      phase = 'error';
      status = 'This shell cannot deliver the part to preview.';
      return;
    }

    // Subscribe BEFORE signalling readiness — the shell flushes on the ready signal.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      viewer?.dispose();
      viewer = null;
    };
  });
</script>

<main class="flex h-full min-h-0 w-full flex-col bg-base-100">
  <!-- The canvas container is always mounted so the viewer has a real layout box the
       moment a mesh is ready; it is collapsed rather than removed between parts. -->
  <div class="relative min-h-0 flex-1" class:hidden={phase !== 'ready'}>
    <canvas
      bind:this={canvas}
      class="h-full w-full cursor-grab touch-none active:cursor-grabbing"
      data-testid="preview-canvas"
      aria-label={file ? `3D preview of ${file.name}` : '3D preview'}
    ></canvas>

    <button class="btn btn-ghost btn-xs absolute right-2 top-2" onclick={() => viewer?.resetView()}>
      Reset view
    </button>
  </div>

  {#if phase !== 'ready'}
    <div class="grid min-h-0 flex-1 place-content-center gap-3 p-6 text-center">
      {#if phase === 'loading'}
        <span class="loading loading-spinner loading-lg justify-self-center"></span>
      {/if}

      <p class="text-base-content/70" aria-live="polite" data-testid="preview-status">{status}</p>

      {#if file && (phase === 'too-large' || phase === 'unsupported')}
        <button
          class="btn btn-primary btn-sm justify-self-center"
          disabled={!hasLink()}
          onclick={download}
          data-testid="preview-download"
        >
          Download {file.name}
        </button>
      {/if}
    </div>
  {/if}

  {#if file}
    <footer
      class="flex flex-wrap items-center justify-between gap-2 border-t border-base-300 px-4 py-2 text-sm"
    >
      <span class="min-w-0 truncate font-medium" data-testid="preview-name">{file.name}</span>
      <span class="text-base-content/60">
        {formatBytes(file.sizeBytes)}
        {#if triangles}
          · {triangles.toLocaleString()} triangles
        {/if}
      </span>
    </footer>
  {/if}
</main>
