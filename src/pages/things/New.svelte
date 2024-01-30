<script lang="ts">
  import {
    Badge,
    Button,
    Fileupload,
    Input,
    Label,
    Select,
    Spinner,
    Textarea,
  } from "flowbite-svelte";
  import PartFile from "../upload/PartFile.svelte";
  import MediaPreview from "../upload/MediaPreview.svelte";
  import { stl2png } from "../../services/stl-to-png";
  import { readFile } from "../../services/file-reader";
  import { NDKEvent, NDKKind } from "@nostr-dev-kit/ndk";
  import { uploadFile } from "../../services/satellite-cdn";
  import { ndk } from "../../services/ndk";
  import dayjs from "dayjs";
  import { THING_KIND } from "../../helpers/thing";
  import { push } from "svelte-spa-router";
  import { getThingNaddr } from "../../helpers/thing";
  import LoadingOverlay from "../../components/LoadingOverlay.svelte";
  import { buildPartEventFromUpload } from "../../helpers/part";

  let mediaInput: HTMLInputElement;
  let thumbnailInput: HTMLInputElement;

  let tagInput = "";
  $: tags = tagInput
    .split(",")
    .map((t) => t.toLowerCase().trim().replaceAll(/\s/g, "-"))
    .filter(Boolean);

  let name = "";
  let description = "";
  let thumbnail: File;
  let parts: File[] = [];
  let thumbnails = new Map<File, Blob>();
  let media: File[] = [];

  let thumbnailURL: string | undefined = "";
  $: {
    if (thumbnailURL) URL.revokeObjectURL(thumbnailURL);
    thumbnailURL = thumbnail ? URL.createObjectURL(thumbnail) : undefined;
  }

  function handleThumbnail(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    if (target.files?.[0]) thumbnail = target.files[0];
  }
  async function handleFilesChange(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const newFiles = Array.from(target.files ?? []);
    parts = parts.concat(newFiles);

    for (const file of newFiles) {
      const buffer = await readFile(file);
      const png = await stl2png(buffer);
      thumbnails.set(file, png);
    }
    thumbnails = thumbnails;
  }
  function removeFile(file: File) {
    parts = parts.filter((f) => f !== file);
  }
  function handleMedia(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    media = media.concat(Array.from(target.files ?? []));
  }
  function removeMedia(file: File) {
    media = media.filter((f) => f !== file);
  }

  let loading = "";

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!thumbnail) return alert("No thumbnail set");
    if (parts.length === 0) return alert("No files selected");
    if (!ndk.signer) return alert("Login first");

    loading = "Uploading Thumbnails...";
    const partThumbnailURLs = new Map<File, string>();
    for (const [part, blob] of thumbnails) {
      const file = new File([blob], "thumbnail.png");
      const res = await uploadFile(file);
      partThumbnailURLs.set(part, res.url);
    }

    loading = "Uploading Parts...";
    let partEvents: NDKEvent[] = [];
    for (const part of parts) {
      const res = await uploadFile(part);
      const thumb = partThumbnailURLs.get(part);
      const event = buildPartEventFromUpload(res, thumb);
      await event.sign();
      partEvents.push(event);
    }

    loading = "Uploading Media...";
    let mediaEvents: NDKEvent[] = [];
    for (const file of media) {
      const res = await uploadFile(file);
      const event = new NDKEvent(ndk);
      event.kind = NDKKind.Media;
      event.content = "";
      event.created_at = dayjs().unix();
      event.tags.push(["name", res.name]);
      event.tags.push(["url", res.url]);
      event.tags.push(["m", res.type]);
      event.tags.push(["x", res.sha256]);
      event.tags.push(["size", String(res.size)]);
      event.tags.push(["magnet", res.magnet]);
      event.tags.push(["i", res.infohash]);
      event.tags.push(["alt", `${res.type} file`]);
      await event.sign();
      mediaEvents.push(event);
    }

    loading = "Uploading Cover...";
    const coverURL: string = (await uploadFile(thumbnail)).url;

    loading = "Publishing...";
    const thing = new NDKEvent(ndk);
    thing.kind = THING_KIND;
    thing.content = description;
    thing.tags.push(["title", name]);
    thing.tags.push(["image", coverURL]);
    thing.tags.push(["created", String(dayjs().unix())]);
    for (const tag of tags) thing.tags.push(["t", tag]);
    for (const event of mediaEvents)
      thing.tags.push(["e", event.id, "", "media"]);
    for (const event of partEvents)
      thing.tags.push(["e", event.id, "", "part"]);

    for (const event of partEvents) await event.publish();
    for (const event of mediaEvents) await event.publish();
    await thing.publish();

    loading = "";
    await push(`/thing/${getThingNaddr(thing)}`);
  }
</script>

<h2>Parts:</h2>
{#each parts as file}
  <PartFile
    {file}
    on:remove={() => removeFile(file)}
    thumbnail={thumbnails.get(file)}
  />
{/each}
<Fileupload accept="model/stl" multiple on:change={handleFilesChange} />

<form class="flex flex-col gap-2" on:submit={submit}>
  <div class="flex gap-2">
    <div class="flex shrink-0 flex-col gap-2">
      {#if thumbnailURL}
        <img class="h-40 w-40 rounded-lg" alt="thumbnail" src={thumbnailURL} />
      {/if}
      <input
        class="hidden"
        type="file"
        accept="image/*,"
        bind:this={thumbnailInput}
        on:change={handleThumbnail}
      />
      <Button class="whitespace-pre" on:click={() => thumbnailInput.click()}
        >Set Thumbnail</Button
      >
    </div>

    <div class="flex w-full flex-col gap-2">
      <div class="flex gap-2">
        <div class="w-full">
          <Label for="name" class="mb-2 block">Name</Label>
          <Input id="name" autocomplete="off" required bind:value={name} />
        </div>
        <div class="w-full">
          <Label for="category" class="mb-2 block">Category</Label>
          <Select id="category" disabled></Select>
        </div>
      </div>

      <div class="w-full">
        <Label for="description" class="mb-2 block">Description</Label>
        <Textarea id="description" rows="6" bind:value={description} />
      </div>
    </div>
  </div>
  <div class="w-full">
    <Label for="tags" class="mb-2 block">Tags</Label>
    <Input id="tags" bind:value={tagInput} required autocomplete="off" />
  </div>
  <div class="flex gap-1">
    {#each tags as tag}
      <Badge>{tag}</Badge>
    {/each}
  </div>
  {#if media.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each media as file}
        <MediaPreview {file} on:remove={() => removeMedia(file)} />
      {/each}
    </div>
  {/if}
  <input
    class="hidden"
    type="file"
    accept="image/*,video/*"
    bind:this={mediaInput}
    on:change={handleMedia}
    multiple
  />
  <div class="flex justify-between gap-2">
    <Button color="alternative" on:click={() => mediaInput.click()}
      >Add Media</Button
    >
    <Button type="submit">Upload</Button>
  </div>
</form>

<LoadingOverlay message={loading} />
