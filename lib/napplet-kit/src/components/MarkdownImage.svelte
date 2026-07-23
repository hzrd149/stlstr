<script lang="ts">
  import { loadImageUrl } from '../images';

  /**
   * An image embedded in a Markdown description.
   *
   * Loaded through NAP-RESOURCE like every other image here, which is also what satisfies
   * NIP.md's "clients MAY defer, proxy, or refuse remote images": the shell makes the
   * request, so a description cannot use an `<img src>` to disclose the reader's IP address
   * to a host the author picked.
   *
   * Unlike the gallery this sizes to the image's intrinsic dimensions, capped — a screenshot
   * inside a paragraph should not be stretched to the column width.
   */

  const { src, alt }: { src: string; alt: string } = $props();

  let objectUrl = $state('');
  let settled = $state(false);

  /** Tracked outside `$state` so teardown never reads reactive state it also writes. */
  let ownedUrl = '';

  $effect(() => {
    const url = src;
    let stale = false;

    void loadImageUrl(url).then((next) => {
      if (stale) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      ownedUrl = next;
      objectUrl = next;
      settled = true;
    });

    return () => {
      stale = true;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
      ownedUrl = '';
    };
  });
</script>

{#if objectUrl}
  <img src={objectUrl} {alt} class="my-2 max-h-96 max-w-full rounded-box" />
{:else if settled}
  <!-- Bytes never arrived. The alt text is the useful thing to show. -->
  <span class="text-sm text-base-content/60">{alt || 'Image unavailable'}</span>
{:else}
  <span class="skeleton my-2 inline-block h-32 w-48 rounded-box"></span>
{/if}
