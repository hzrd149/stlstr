<script lang="ts">
  import dayjs from "dayjs";

  export let timestamp: number | undefined;
</script>

{#if timestamp}
  <time datetime={dayjs.unix(timestamp).toISOString()}
    >{dayjs.unix(timestamp).format("ll")}</time
  >
{/if}
