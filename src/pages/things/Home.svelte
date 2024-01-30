<script lang="ts">
  import { ndk } from "../../services/ndk";
  import { Button, Spinner } from "flowbite-svelte";
  import { onDestroy } from "svelte";
  import { THING_KIND } from "../../helpers/thing";
  import ThingCard from "../../components/ThingCard.svelte";

  const things = ndk.storeSubscribe([{ kinds: [THING_KIND] }]);

  onDestroy(() => {
    things.unsubscribe();
  });
</script>

<main>
  <div class="flex items-center gap-2">
    <h1 class="text-lg font-bold">Things</h1>
    <Button href="#/things/new" class="ml-auto">New Thing</Button>
  </div>
  {#if $things.length === 0}
    <div class="text-center">
      <Spinner />
    </div>
  {/if}
  {#each $things as thing}
    <ThingCard {thing} />
  {/each}
</main>
