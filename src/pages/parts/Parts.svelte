<script lang="ts">
  import { ndk } from "../../services/ndk";
  import { NDKKind } from "@nostr-dev-kit/ndk";
  import { Button, Spinner } from "flowbite-svelte";
  import { onDestroy } from "svelte";
  import PartCard from "../../components/PartCard.svelte";

  const parts = ndk.storeSubscribe([
    { kinds: [NDKKind.Media], "#m": ["model/stl"] },
  ]);

  onDestroy(() => {
    parts.unsubscribe();
  });
</script>

<main>
  <div class="flex items-center gap-2">
    <h1 class="text-lg font-bold">Parts</h1>
    <Button href="#/parts/new" class="ml-auto">New Part</Button>
  </div>
  <div class="flex flex-wrap gap-2">
    {#if $parts.length === 0}
      <div class="text-center">
        <Spinner />
      </div>
    {/if}
    {#each $parts as part}
      <PartCard {part} />
    {/each}
  </div>
</main>
