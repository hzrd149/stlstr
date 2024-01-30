<script lang="ts">
  import { NDKKind, type NDKEvent } from "@nostr-dev-kit/ndk";
  import { getPartThumbnail } from "../../helpers/part";
  import { getTagValue } from "../../helpers/event";
  import dayjs from "dayjs";
  import { formatBytes } from "../../helpers/number";
  import UserLink from "../../components/UserLink.svelte";
  import { TabItem, Tabs } from "flowbite-svelte";
  import { ndk } from "../../services/ndk";
  import { THING_KIND } from "../../helpers/thing";
  import ThingCard from "../../components/ThingCard.svelte";
  import { onDestroy } from "svelte";
  import PartCard from "../../components/PartCard.svelte";
  import FileDownloadButton from "../../components/FileDownloadButton.svelte";
  import FileMagnetButton from "../../components/FileMagnetButton.svelte";

  export let part: NDKEvent;

  $: size = getTagValue(part, "size");

  const things = ndk.storeSubscribe([{ kinds: [THING_KIND], "#e": [part.id] }]);
  const parts = ndk.storeSubscribe([
    { kinds: [NDKKind.Media], "#e": [part.id] },
  ]);

  onDestroy(() => {
    things.unsubscribe();
    parts.unsubscribe();
  });
</script>

<div class="flex flex-wrap items-start gap-2">
  <img src={getPartThumbnail(part)} alt="thumbnail" class="w-40" />
  <div>
    <h1 class="text-lg font-bold">{getTagValue(part, "name")}</h1>
    <p>Created by: <UserLink user={part.author} class="truncate" /></p>

    <div class="text-sm">
      <p>Size: {size ? formatBytes(parseInt(size)) : "unknown"}</p>
      <p>Created: {dayjs.unix(part.created_at ?? 0).format("lll")}</p>
    </div>

    <p>{part.content}</p>
  </div>
  <div class="ml-auto flex gap-2">
    <FileDownloadButton file={part} />
    <FileMagnetButton file={part} />
  </div>
</div>

<Tabs style="underline">
  <TabItem open title="Things">
    {#each $things as thing}
      <ThingCard {thing} />
    {/each}
  </TabItem>
  <TabItem title="Variations">
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
