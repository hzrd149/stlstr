<script lang="ts">
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { Button } from "flowbite-svelte";
  import { getTagValue } from "../helpers/event";
  import Magnet from "./icons/magnet.svelte";
  export let file: NDKEvent;

  $: magnet = getTagValue(file, "magnet");
</script>

{#if magnet}
  <Button href={magnet} target="_blank" size="xs" class="!p-2">
    <Magnet class="h-4 w-4" /></Button
  >
{/if}
