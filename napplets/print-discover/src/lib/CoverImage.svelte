<script lang="ts">
  import { loadImageUrl } from '@stlstr/napplet-kit/images';
  import type { ObjectImage } from './objects';

  const {
    cover,
    title,
    class: className = '',
  }: { cover: ObjectImage | null; title: string; class?: string } = $props();

  let objectUrl = $state('');
  let settled = $state(false);
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

<div class={`overflow-hidden rounded-box bg-base-300 ${className}`}>
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
