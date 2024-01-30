<script lang="ts">
  import { NDKKind, type NDKUser } from "@nostr-dev-kit/ndk";
  import { onDestroy } from "svelte";
  import { THING_KIND } from "../../helpers/thing";
  import { ndk } from "../../services/ndk";
  import { TabItem, Tabs } from "flowbite-svelte";
  import { Avatar, Name } from "@nostr-dev-kit/ndk-svelte-components";
  import PartCard from "../../components/PartCard.svelte";
  import ThingCard from "../../components/ThingCard.svelte";

  export let user: NDKUser;

  const things = ndk.storeSubscribe([
    { kinds: [THING_KIND], authors: [user.pubkey] },
  ]);
  const parts = ndk.storeSubscribe([
    { kinds: [NDKKind.Media], authors: [user.pubkey] },
  ]);

  onDestroy(() => {
    things.unsubscribe();
    parts.unsubscribe();
  });
</script>

<div class="flex gap-2">
  <Avatar {user} class="h-16 w-16 rounded-full" />
  <div>
    <Name {user} class="font-bold" />
    <p class="text-sm">{user.profile?.about}</p>
  </div>
</div>

<Tabs style="underline">
  <TabItem open title="Things">
    {#each $things as thing}
      <ThingCard {thing} />
    {/each}
  </TabItem>
  <TabItem title="Parts">
    {#each $parts as part}
      <PartCard {part} />
    {/each}
  </TabItem>
  <TabItem title="Lists">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      <b>Settings:</b>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
      incididunt ut labore et dolore magna aliqua.
    </p>
  </TabItem>
</Tabs>
