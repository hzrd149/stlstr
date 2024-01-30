<script lang="ts">
  import { NDKEvent, NDKKind } from "@nostr-dev-kit/ndk";
  import { ndk } from "../../services/ndk";
  import { nip19 } from "nostr-tools";
  import { Spinner } from "flowbite-svelte";
  import { onMount } from "svelte";
  import Page from "./Page.svelte";

  export let params: Record<string, string> = {};

  let part: NDKEvent | undefined | null = undefined;

  onMount(async () => {
    if (!params.id) return;

    const decode = nip19.decode(params.id);
    switch (decode.type) {
      case "nevent":
        if (decode.data.kind && decode.data.kind !== NDKKind.Media) {
          part = null;
          break;
        }
        part = await ndk.fetchEvent(decode.data.id);
        break;
      default:
        part = null;
        break;
    }
    console.log(part);
  });
</script>

<main>
  {#if part === undefined}
    <div class="text-center">
      <Spinner />
    </div>
  {:else if part === null}
    <h2 class="text-center">Failed to load event</h2>
  {:else}
    <Page {part} />
  {/if}
</main>
