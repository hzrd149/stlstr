<script lang="ts">
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { Card } from "flowbite-svelte";
  import {
    getThingImage,
    getThingNaddr,
    getThingSummary,
    getThingTitle,
  } from "../helpers/thing";
  import { Name } from "@nostr-dev-kit/ndk-svelte-components";
  export let thing: NDKEvent;
</script>

<Card
  img={getThingImage(thing)}
  size="xs"
  href={`#/thing/${getThingNaddr(thing)}`}
>
  <div class="mb-2 overflow-hidden">
    <h5
      class="truncate text-lg font-bold tracking-tight text-gray-900 dark:text-white"
    >
      {getThingTitle(thing)}
    </h5>
    <p class="truncate text-xs"><Name user={thing.author} /></p>
  </div>
  <p class="mb-3 font-normal leading-tight text-gray-700 dark:text-gray-400">
    {getThingSummary(thing)}
  </p>
</Card>
