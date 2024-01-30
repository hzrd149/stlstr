<script lang="ts">
  import {
    Button,
    Fileupload,
    Helper,
    Input,
    Label,
    Textarea,
  } from "flowbite-svelte";
  import { push } from "svelte-spa-router";

  import LoadingOverlay from "../../components/LoadingOverlay.svelte";
  import { stl2png } from "../../services/stl-to-png";
  import { readFile } from "../../services/file-reader";
  import BlobPreviewImage from "../../components/BlobPreviewImage.svelte";
  import { formatBytes } from "../../helpers/number";
  import { ndk } from "../../services/ndk";
  import { uploadFile } from "../../services/satellite-cdn";
  import { buildPartEventFromUpload } from "../../helpers/part";

  let files: FileList | undefined;
  $: file = files?.[0];

  let name = "";
  let description = "";
  let thumbnail: Blob | undefined = undefined;

  $: {
    if (file) {
      name = file.name;
      readFile(file).then((buffer) => {
        stl2png(buffer).then((blob) => (thumbnail = blob));
      });
    }
  }

  let loading = "";
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!file) return alert("Select file first");
    if (!thumbnail) return alert("Missing thumbnail");
    if (!ndk.signer) return alert("Login first");

    loading = "Uploading Thumbnails...";
    const thumbnailFile = new File([thumbnail], "thumbnail.png");
    const thumbRes = await uploadFile(thumbnailFile);
    const thumbnailURL = thumbRes.url;

    loading = "Uploading Part...";
    const newFile = name !== file.name ? new File([file], name) : file;
    const partRes = await uploadFile(newFile);
    const event = buildPartEventFromUpload(partRes, thumbnailURL);
    event.content = description;

    loading = "Signing...";
    await event.sign();

    loading = "Publishing...";
    await event.publish();

    push(`#/part/${event.encode()}`);
  }
</script>

<form class="flex flex-col gap-2" on:submit={submit}>
  <Fileupload accept="model/stl" bind:files />
  <div class="flex items-start gap-2">
    {#if thumbnail}
      <BlobPreviewImage blob={thumbnail} class="h-auto min-w-20 max-w-64" />
    {/if}
    {#if file}
      <div class="flex w-full flex-col gap-2">
        <div class="flex w-full gap-2">
          <div class="w-full">
            <Label for="name" class="mb-2 block">Name</Label>
            <Input id="name" autocomplete="off" required bind:value={name} />
            <Helper class="text-sm">Should end in .stl</Helper>
          </div>
          <div class="w-28">
            <Label for="name" class="mb-2 block">Size</Label>
            <Input
              id="name"
              autocomplete="off"
              readonly
              value={formatBytes(file.size)}
            />
          </div>
        </div>
        <div class="w-full">
          <Label for="description" class="mb-2 block">Description</Label>
          <Textarea id="description" rows="6" bind:value={description} />
        </div>
      </div>
    {/if}
  </div>
  <div class="flex justify-end gap-2">
    <Button type="submit">Upload</Button>
  </div>
</form>

<LoadingOverlay message={loading} />
