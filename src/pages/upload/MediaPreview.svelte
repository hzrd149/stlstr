<script lang="ts">
  import { Button, Card } from "flowbite-svelte";
  import { createEventDispatcher } from "svelte";

  export let file: File;
  $: type = file.type;
  let url = "";

  $: {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
  }

  const dispatch = createEventDispatcher();
</script>

<Card class="relative gap-2">
  {#if url && type.startsWith("image/")}
    <img src={url} alt={file.name} class="max-w-40" />
  {:else}
    <p>{type}</p>
  {/if}
  <Button color="alternative" size="sm" on:click={() => dispatch("remove")}
    >Remove</Button
  >
</Card>
