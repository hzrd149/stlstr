<script lang="ts">
  export let blob: Blob | undefined;

  let thumbnailURL: string | undefined = "";
  $: {
    if (thumbnailURL) URL.revokeObjectURL(thumbnailURL);
    thumbnailURL = blob ? URL.createObjectURL(blob) : undefined;
  }
</script>

<img src={thumbnailURL} alt="blob preview" class={$$props.class} />
