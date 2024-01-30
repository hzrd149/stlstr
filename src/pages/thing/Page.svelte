<script lang="ts">
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { onMount } from "svelte";
  import {
    getThingDateCreated,
    getThingFileIds,
    getThingImage,
    getThingTitle,
  } from "../../helpers/thing";
  import { ndk } from "../../services/ndk";
  import { Badge, Gallery, TabItem, Tabs } from "flowbite-svelte";
  import { getTagValue } from "../../helpers/event";
  import File from "./File.svelte";
  import { Avatar, Name } from "@nostr-dev-kit/ndk-svelte-components";
  import dayjs from "dayjs";
  import UserLink from "../../components/UserLink.svelte";
  import Timestamp from "../../components/Timestamp.svelte";

  export let thing: NDKEvent;
  let files: NDKEvent[] = [];

  $: created = getThingDateCreated(thing);
  $: hashtags = thing.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  $: parts = files.filter((e) => getTagValue(e, "m") === "model/stl");
  $: images = files.filter((e) => getTagValue(e, "m")?.startsWith("image/"));
  $: videos = files.filter((e) => getTagValue(e, "m")?.startsWith("image/"));
  $: galleryImages = images.map((e) => ({ src: getTagValue(e, "url", true) }));

  let focusImage = getThingImage(thing);

  onMount(async () => {
    const ids = getThingFileIds(thing);
    console.log(ids);

    files = Array.from(await ndk.fetchEvents([{ ids }]));
  });
</script>

<div class="flex gap-2">
  <a href={`#/user/${thing.author.npub}`}>
    <Avatar user={thing.author} class="h-16 w-16 rounded-full" />
  </a>
  <div>
    <h1 class="text-lg font-bold">{getThingTitle(thing)}</h1>
    <p class="text-gray-500 dark:text-gray-400">
      <UserLink user={thing.author} />
      <Timestamp timestamp={thing.created_at} />
    </p>
  </div>
</div>
<div class="flex flex-col gap-4">
  <img src={focusImage} class="mx-auto max-h-80 rounded-lg" alt="focused" />
  <Gallery class="grid-cols-5" items={galleryImages} />
</div>

<Tabs style="underline">
  <TabItem open title="Description">
    <h3>Description</h3>
    <p class="text-md whitespace-pre text-gray-500 dark:text-gray-400">
      {thing.content}
    </p>
    <h3 class="my-2">Tags</h3>
    <div class="flex gap-2">
      {#each hashtags as tag}
        <Badge>{tag}</Badge>
      {/each}
    </div>
  </TabItem>
  <TabItem title="Files">
    {#each parts as part}
      <File file={part} />
    {/each}
  </TabItem>
  <TabItem title="Other">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      <b>Settings:</b>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
      incididunt ut labore et dolore magna aliqua.
    </p>
  </TabItem>
  <TabItem title="Comments">
    <p class="text-sm text-gray-500 dark:text-gray-400">
      <b>Users:</b>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
      incididunt ut labore et dolore magna aliqua.
    </p>
  </TabItem>
</Tabs>
