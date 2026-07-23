<script lang="ts">
  import { loadImageUrl } from './images';
  import type { ObjectImage } from './object';

  /**
   * One image from the gallery, fetched through NAP-RESOURCE.
   *
   * Three states: pending (skeleton), loaded (image), unavailable (the `alt` text, which is
   * the most useful thing to show when bytes never arrive).
   */

  const {
    image,
    fallbackAlt = '',
    fit = 'contain',
  }: { image: ObjectImage | null; fallbackAlt?: string; fit?: 'contain' | 'cover' } = $props();

  let objectUrl = $state('');
  let settled = $state(false);

  /** Tracked outside `$state` so teardown never reads reactive state it also writes. */
  let ownedUrl = '';

  function release(): void {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    ownedUrl = '';
  }

  $effect(() => {
    const url = image?.url ?? '';
    let stale = false;

    release();
    objectUrl = '';
    settled = !url;

    if (url) {
      void loadImageUrl(url).then((next) => {
        if (stale) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        ownedUrl = next;
        objectUrl = next;
        settled = true;
      });
    }

    return () => {
      stale = true;
      release();
    };
  });
</script>

{#if objectUrl}
  <img
    src={objectUrl}
    alt={image?.alt || fallbackAlt}
    class="h-full w-full {fit === 'cover' ? 'object-cover' : 'object-contain'}"
  />
{:else if settled}
  <div
    class="flex h-full w-full items-center justify-center p-2 text-center text-sm text-base-content/50"
  >
    {image?.alt || 'No preview available'}
  </div>
{:else}
  <div class="skeleton h-full w-full"></div>
{/if}
