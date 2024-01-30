<script lang="ts">
  import type { NDKUser } from "@nostr-dev-kit/ndk";
  import { Name } from "@nostr-dev-kit/ndk-svelte-components";
  export let user: NDKUser;
</script>

<a href={`#/user/${user.npub}`} class="truncate font-bold" {...$$props}>
  <Name {user} />
</a>
