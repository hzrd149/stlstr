<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isModelFile, type FileMeta } from '../files';
  import { loadImageUrl } from '../images';

  /**
   * The preview image for one file.
   *
   * Per NIP.md a printable file's preview is published as a `thumb` tag on its `kind:1063`
   * event, because the file itself has none: an STL is raw geometry, and rendering one to
   * fill a list would mean fetching and parsing every file on the page — impossible for
   * files above the shell's resource ceiling, which is most real parts.
   *
   * So a missing thumbnail is an ordinary state, not an error. Older files predate the
   * tag, and formats like slicer profiles have no meaningful visual form at all. Those get
   * a type-derived placeholder rather than a broken image or a gap.
   */

  let { file, size = 'w-16 h-16' }: { file: FileMeta; size?: string } = $props();

  let objectUrl = $state('');
  let failed = $state(false);

  /** What to show when there is no thumbnail: a hint at the kind of file, not a render. */
  const placeholder = $derived(isModelFile(file) ? '3D' : extension(file.name) || 'FILE');

  function extension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? name
          .slice(dot + 1)
          .toUpperCase()
          .slice(0, 4)
      : '';
  }

  function revoke(url: string): void {
    if (url) URL.revokeObjectURL(url);
  }

  $effect(() => {
    const url = file.thumb;
    if (!url) return;

    let cancelled = false;
    void loadImageUrl(url).then((loaded) => {
      // The row may have been replaced or filtered out while the fetch was in flight.
      if (cancelled) {
        revoke(loaded);
        return;
      }
      if (loaded) objectUrl = loaded;
      else failed = true;
    });

    return () => {
      cancelled = true;
    };
  });

  // The object URL outlives the effect that created it, so it is released with the
  // component rather than on every re-run.
  onDestroy(() => revoke(objectUrl));
</script>

<div
  class="{size} grid shrink-0 place-items-center overflow-hidden rounded-box bg-base-200"
  data-testid="part-thumb"
>
  {#if objectUrl}
    <img src={objectUrl} alt={file.alt || file.name} class="h-full w-full object-cover" />
  {:else if file.thumb && !failed}
    <div class="skeleton h-full w-full" data-testid="part-thumb-loading"></div>
  {:else}
    <span class="text-xs font-medium text-base-content/50" data-testid="part-thumb-placeholder">
      {placeholder}
    </span>
  {/if}
</div>
