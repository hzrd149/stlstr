<script lang="ts">
  import { Spinner } from "flowbite-svelte";

  export let message: string;
</script>

{#if message}
  <div
    class="bg-dark fixed bottom-0 left-0 right-0 top-0 flex items-center justify-center gap-2 bg-black/50"
  >
    <Spinner />
    <div class="text-lg text-white">{message}</div>
  </div>
{/if}
