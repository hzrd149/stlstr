<script lang="ts">
  import dayjs from "dayjs";
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { getTagValue } from "../../helpers/event";
  import { formatBytes } from "../../helpers/number";
  import FileDownloadButton from "../../components/FileDownloadButton.svelte";
  import FileMagnetButton from "../../components/FileMagnetButton.svelte";

  export let file: NDKEvent;
  let thumbnail: string | undefined = "";
  let link: string | undefined = undefined;
  $: type = getTagValue(file, "m") ?? "unknown";
  $: size = getTagValue(file, "size");
  $: magnet = getTagValue(file, "magnet");

  $: {
    if (type === "model/stl") {
      thumbnail = getTagValue(file, "thumb") || getTagValue(file, "image");
      link = `#/part/${file.encode()}`;
    } else if (type.startsWith("image/")) thumbnail = getTagValue(file, "url");
    else thumbnail = undefined;
  }
</script>

<div
  class="relative flex w-full flex-col divide-gray-200 rounded-lg border border-gray-200 bg-white p-2 text-gray-500 shadow-md dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 md:flex-row"
>
  <img
    class="h-96 w-full rounded-t-lg object-cover md:h-auto md:w-48 md:rounded-none md:rounded-s-lg"
    src={thumbnail}
    alt={getTagValue(file, "summary") ?? "File"}
  />
  <div class="flex w-full flex-col gap-2">
    <div class="flex items-center gap-2">
      {#if link}
        <a class="font-bold text-gray-900 dark:text-white" href={link}>
          {getTagValue(file, "name")}
        </a>
      {:else}
        <p class="font-bold text-gray-900 dark:text-white">
          {getTagValue(file, "name")}
        </p>
      {/if}
      <FileDownloadButton {file} />
      <FileMagnetButton {file} />
    </div>
    <div>
      <p>Size: {size ? formatBytes(parseInt(size)) : "unknown"}</p>
      <p>Created: {dayjs.unix(file.created_at ?? 0).format("lll")}</p>
    </div>
  </div>
</div>
