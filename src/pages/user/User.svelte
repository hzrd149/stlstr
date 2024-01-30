<script lang="ts">
  import { NDKUser } from "@nostr-dev-kit/ndk";
  import { ndk } from "../../services/ndk";
  import { nip19 } from "nostr-tools";
  import { Spinner } from "flowbite-svelte";
  import Page from "./Page.svelte";
  import { onMount } from "svelte";

  export let params: Record<string, string> = {};

  let user: NDKUser | undefined | null = undefined;

  onMount(async () => {
    if (!params.id) return;

    const decode = nip19.decode(params.id);
    switch (decode.type) {
      case "npub":
        user = await ndk.getUser({ pubkey: decode.data });
        break;
      case "nprofile":
        user = await ndk.getUser({
          pubkey: decode.data.pubkey,
          relayUrls: decode.data.relays,
        });
        break;
      default:
        user = null;
        break;
    }
    if (user) await user.fetchProfile();
  });
</script>

<main>
  {#if user === undefined}
    <div class="text-center">
      <Spinner />
    </div>
  {:else if user === null}
    <h2 class="text-center">Could not find user</h2>
  {:else}
    <Page {user} />
  {/if}
</main>
