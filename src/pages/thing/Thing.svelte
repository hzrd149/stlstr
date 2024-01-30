<script lang="ts">
  import { NDKEvent } from "@nostr-dev-kit/ndk";
  import { ndk } from "../../services/ndk";
  import { nip19 } from "nostr-tools";
  import { Spinner } from "flowbite-svelte";
  import Page from "./Page.svelte";
  import { onMount } from "svelte";
  import { THING_KIND } from "../../helpers/thing";

  export let params: Record<string, string> = {};

  let event: NDKEvent | undefined | null = undefined;

  onMount(async () => {
    if (!params.naddr) return;

    const decode = nip19.decode(params.naddr);
    if (decode.type === "naddr" && decode.data.kind === THING_KIND) {
      event = await ndk.fetchEvent({
        kinds: [decode.data.kind],
        authors: [decode.data.pubkey],
        "#d": [decode.data.identifier],
      });
      console.log(event);
    }
  });
</script>

<main>
  {#if event === undefined}
    <div class="text-center">
      <Spinner />
    </div>
  {:else if event === null}
    <h2 class="text-center">Failed to load event</h2>
  {:else}
    <Page thing={event} />
  {/if}
</main>
