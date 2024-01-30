<script lang="ts">
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { Button } from "flowbite-svelte";
  import { getTagValue } from "../helpers/event";
  import Download from "./icons/download.svelte";
  export let file: NDKEvent;
</script>

<Button
  class="ml-auto !p-2"
  size="xs"
  href={getTagValue(file, "url")}
  target="_blank"
  outline
  download={getTagValue(file, "name")}
  {...$$props}><Download class="mr-1 h-4 w-4" />Download</Button
>
