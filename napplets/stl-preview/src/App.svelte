<script lang="ts">
  import { inc, link, resource } from '@napplet/sdk';
  import { looksLikeStl, parseStl } from '@stlstr/napplet-kit/stl';
  import { onMount, tick } from 'svelte';
  import { createViewer, type Viewer } from './viewer';

  /**
   * Renders one STL file in 3D.
   *
   * The shell or calling napplet resolves any Nostr file event first. This viewer accepts
   * only NAP-RESOURCE fetch parameters, so it never needs relay access or part-event shape.
   */

  const OPEN_TOPIC = 'stl-preview:open';
  const READY_TOPIC = 'stl-preview:ready';

  /** Mirrors the shell's NAP-RESOURCE `MAX_BYTES`. */
  const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

  type FileMeta = {
    url: string;
    name: string;
    mime: string;
    sizeBytes: number;
  };

  type Phase = 'idle' | 'loading' | 'ready' | 'too-large' | 'unsupported' | 'error';

  let phase = $state<Phase>('idle');
  let status = $state('Waiting for an STL to preview...');
  let file = $state<FileMeta | null>(null);
  let triangles = $state(0);
  let canvas = $state<HTMLCanvasElement | null>(null);

  let viewer: Viewer | null = null;
  /** Guards against a stale fetch resolving after a newer STL has been delivered. */
  let loadToken = 0;

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

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
      return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'STL file';
    } catch {
      return 'STL file';
    }
  }

  function payloadString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  function readPayload(payload: unknown): FileMeta | null {
    if (!payload || typeof payload !== 'object') return null;

    const record = payload as Record<string, unknown>;
    const url = payloadString(record, 'url');
    if (!url) return null;

    const size = Number(payloadString(record, 'size'));
    return {
      url,
      name: payloadString(record, 'name') || basename(url),
      mime: payloadString(record, 'mime'),
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
    // Created lazily so an STL that never renders never claims a WebGL context, and kept
    // across redeliveries so switching files does not rebuild the context.
    viewer ??= createViewer(canvas);
    if (!viewer) throw new Error('This browser could not start WebGL for the 3D preview.');

    viewer.setMesh(mesh);
  }

  async function loadFile(meta: FileMeta): Promise<void> {
    const token = (loadToken += 1);
    const stale = () => token !== loadToken;

    file = meta;
    triangles = 0;
    phase = 'loading';
    status = 'Preparing the preview...';

    // Refuse before fetching, not after: the shell would reject these bytes mid-stream.
    if (meta.sizeBytes > MAX_PREVIEW_BYTES) {
      phase = 'too-large';
      status = `This STL is ${formatBytes(meta.sizeBytes)}, past the ${formatBytes(MAX_PREVIEW_BYTES)} the shell will fetch.`;
      return;
    }

    if (!hasResource()) {
      phase = 'unsupported';
      status = 'This shell cannot fetch file bytes, so the STL cannot be rendered here.';
      return;
    }

    try {
      status = 'Downloading the STL...';
      const blob = await resource.bytes(meta.url);
      if (stale()) return;

      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (stale()) return;

      if (!looksLikeStl(bytes)) {
        phase = 'unsupported';
        status = meta.mime
          ? `${meta.mime} files cannot be previewed here — STL only.`
          : 'This file is not an STL, so it cannot be previewed here.';
        return;
      }

      await render(bytes);
    } catch (error) {
      if (stale()) return;
      phase = 'error';
      status = error instanceof Error ? error.message : 'That STL could not be previewed.';
    }
  }

  function applyIntent(payload: unknown): void {
    const meta = readPayload(payload);
    if (!meta) {
      phase = 'error';
      status = 'The shell opened the STL viewer without a file URL.';
      return;
    }

    void loadFile(meta);
  }

  onMount(() => {
    if (!hasInc()) {
      phase = 'error';
      status = 'This shell cannot deliver the STL to preview.';
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
       moment a mesh is ready; it is collapsed rather than removed between files. -->
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
