<script lang="ts">
  import { loadImageUrl } from '@stlstr/napplet-kit/images';
  import type { ObjectImage } from './objects';

  /**
   * A card's cover art. Three states: pending (skeleton), loaded (image), unavailable
   * (a neutral placeholder). A missing cover is normal, so it never reads as an error.
   */

  const { cover, title }: { cover: ObjectImage | null; title: string } = $props();

  let objectUrl = $state('');
  let settled = $state(false);

  /**
   * The URL to revoke, tracked outside `$state` so teardown never reads reactive state
   * inside the effect that writes it.
   */
  let ownedUrl = '';

  function release(): void {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    ownedUrl = '';
  }

  $effect(() => {
    const url = cover?.url ?? '';
    let stale = false;

    release();
    objectUrl = '';
    settled = !url;

    if (url) {
      void loadImageUrl(url).then((next) => {
        // The card may have been recycled onto another object while this was in flight.
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

<div class="aspect-video w-full overflow-hidden rounded-box bg-base-300">
  {#if objectUrl}
    <img
      src={objectUrl}
      alt={cover?.alt || title}
      loading="lazy"
      class="h-full w-full object-cover"
    />
  {:else if settled}
    <div
      class="flex h-full w-full items-center justify-center text-sm text-base-content/50"
      aria-hidden="true"
    >
      No preview
    </div>
  {:else}
    <div class="skeleton h-full w-full"></div>
  {/if}
</div>
