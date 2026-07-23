<script lang="ts">
  import {
    identity,
    inc,
    intent,
    outbox,
    resource,
    storage,
    upload,
    type NostrEvent,
    type NostrTag,
  } from '@napplet/sdk';
  import { tagValue } from '@stlstr/napplet-kit/tags';
  import { onMount } from 'svelte';

  type UploadResult = Awaited<ReturnType<typeof upload.upload>>;
  type ImageDraft = {
    id: string;
    url: string;
    alt: string;
    mime: string;
    file: File | null;
    previewUrl: string;
    originalFields: string[];
  };

  /**
   * Edit one printable object (`kind:33500`).
   *
   * The address arrives over the NAP-INTENT delivery seam as a targeted `inc.event` on
   * `printable-edit:edit`. Subscribe FIRST, then emit `printable-edit:ready`.
   *
   * Ownership is decided by NAP-IDENTITY and nothing else. The address in the payload is
   * untrusted — it crossed a sandbox boundary, and anyone can type any URL — so the owner
   * is taken from the loaded event's author and compared against the signed-in user. The
   * gate has to be right before replacement publishing exists, because publishing a
   * replacement is what would overwrite someone else's object.
   */

  const OPEN_TOPIC = 'printable-edit:edit';
  const READY_TOPIC = 'printable-edit:ready';
  const DRAFT_PREFIX = 'printable-edit:draft:v1:';
  const CUSTOM_LICENSE = '__custom';
  const MUTABLE_TAGS = new Set([
    'd',
    'title',
    'summary',
    'published_at',
    'license',
    'i',
    't',
    'imeta',
  ]);
  const LICENSE_OPTIONS: Array<{ id: string; label: string }> = [
    { id: 'CC0-1.0', label: 'CC0 1.0 — public domain' },
    { id: 'CC-BY-4.0', label: 'CC BY 4.0 — credit required' },
    { id: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0 — credit, share alike' },
    { id: 'CC-BY-NC-4.0', label: 'CC BY-NC 4.0 — credit, noncommercial' },
    { id: 'CC-BY-NC-SA-4.0', label: 'CC BY-NC-SA 4.0 — credit, noncommercial, share alike' },
    { id: 'CC-BY-ND-4.0', label: 'CC BY-ND 4.0 — credit, no derivatives' },
    { id: 'CC-BY-NC-ND-4.0', label: 'CC BY-NC-ND 4.0 — credit, noncommercial, no derivatives' },
    { id: 'MIT', label: 'MIT' },
    { id: 'Apache-2.0', label: 'Apache 2.0' },
    { id: 'GPL-3.0-or-later', label: 'GPL 3.0 or later' },
  ];

  let title = $state('');
  let summary = $state('');
  let license = $state('');
  let customLicense = $state(false);
  let tagsText = $state('');
  let sourceUrl = $state('');
  let description = $state('');
  let images = $state<ImageDraft[]>([]);
  let owner = $state('');
  let address = $state('');
  let identifier = $state('');
  let viewer = $state('');
  let status = $state('Waiting for a print to open...');
  let busy = $state(false);
  /** A publish succeeded and the shell is navigating away; the form must stay locked. */
  let leaving = $state(false);
  let loaded = $state(false);
  let publishedAddress = $state('');
  let originalEvent = $state.raw<NostrEvent | null>(null);
  let preservedTags = $state.raw<NostrTag[]>([]);
  let draftLoaded = $state(false);
  let imageSequence = 0;

  /** An empty viewer means nobody is signed in, so the editor stays closed. */
  const isOwner = $derived(Boolean(viewer && owner && viewer === owner));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => {
    const domain = napplets().outbox as Partial<typeof outbox> | undefined;
    return typeof domain?.query === 'function' && typeof domain?.publish === 'function';
  };
  const hasInc = () => {
    const domain = napplets().inc as Partial<typeof inc> | undefined;
    return typeof domain?.on === 'function' && typeof domain?.emit === 'function';
  };
  const hasIntent = () => {
    const domain = napplets().intent as Partial<typeof intent> | undefined;
    return typeof domain?.open === 'function';
  };
  const hasIdentity = () => {
    const domain = napplets().identity as Partial<typeof identity> | undefined;
    return typeof domain?.getPublicKey === 'function' && typeof domain?.onChanged === 'function';
  };
  const hasStorage = () => {
    const domain = napplets().storage as Partial<typeof storage> | undefined;
    return (
      typeof domain?.getItem === 'function' &&
      typeof domain?.setItem === 'function' &&
      typeof domain?.removeItem === 'function'
    );
  };
  const hasUpload = () => {
    const domain = napplets().upload as Partial<typeof upload> | undefined;
    return typeof domain?.upload === 'function';
  };
  const hasResource = () => {
    const domain = napplets().resource as Partial<typeof resource> | undefined;
    return typeof domain?.bytes === 'function';
  };

  function tagValues(tags: string[][], name: string): string[] {
    return tags
      .filter((tag) => tag[0] === name && tag[1])
      .map((tag) => tag[1].trim())
      .filter(Boolean);
  }

  function parseImetaField(entry: string): [string, string] | null {
    const separator = entry.indexOf(' ');
    if (separator < 1) return null;
    return [entry.slice(0, separator), entry.slice(separator + 1).trim()];
  }

  function imetaValue(fields: string[], name: string): string {
    for (const entry of fields) {
      const parsed = parseImetaField(entry);
      if (parsed?.[0] === name) return parsed[1];
    }
    return '';
  }

  function parseImageTags(tags: string[][]): ImageDraft[] {
    return tags
      .filter((tag) => tag[0] === 'imeta')
      .map((tag, index) => {
        const fields = tag.slice(1);
        const url = imetaValue(fields, 'url');
        if (!url) return null;
        return {
          id: `existing:${index}:${url}`,
          url,
          alt: imetaValue(fields, 'alt'),
          mime: imetaValue(fields, 'm'),
          file: null,
          previewUrl: '',
          originalFields: fields,
        };
      })
      .filter((image): image is ImageDraft => image !== null);
  }

  function buildTopicTags(): string[] {
    return tagsText
      .split(/[\n,]/)
      .map((tag) => tag.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean);
  }

  function appendTag(tags: NostrTag[], tag: NostrTag | null): void {
    if (tag) tags.push(tag);
  }

  function revokePreview(url: string): void {
    if (url) URL.revokeObjectURL(url);
  }

  function resetImages(next: ImageDraft[]): void {
    for (const image of images) revokePreview(image.previewUrl);
    images = next;
  }

  async function loadImagePreview(image: ImageDraft): Promise<void> {
    if (!image.url || image.file || !hasResource()) return;

    try {
      const blob = await resource.bytes(image.url);
      if (!blob.type.startsWith('image/')) return;
      const previewUrl = URL.createObjectURL(blob);
      const previous = images.find((candidate) => candidate.id === image.id)?.previewUrl ?? '';
      if (!images.some((candidate) => candidate.id === image.id)) {
        revokePreview(previewUrl);
        return;
      }
      images = images.map((candidate) =>
        candidate.id === image.id ? { ...candidate, previewUrl } : candidate,
      );
      revokePreview(previous);
    } catch {
      // A blocked or unavailable preview should not prevent metadata editing.
    }
  }

  function loadImagePreviews(): void {
    for (const image of images) void loadImagePreview(image);
  }

  function addImageFiles(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const selected = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (selected.length === 0) {
      status = 'Choose image files to add to the print.';
      return;
    }

    const next = selected.map((file) => ({
      id: `new:${file.name}:${file.size}:${file.lastModified}:${imageSequence++}`,
      url: '',
      alt: file.name,
      mime: file.type,
      file,
      previewUrl: URL.createObjectURL(file),
      originalFields: [],
    }));
    images = [...images, ...next];
    input.value = '';
    status = `${selected.length} image${selected.length === 1 ? '' : 's'} added.`;
  }

  function removeImage(id: string): void {
    const removed = images.find((image) => image.id === id);
    revokePreview(removed?.previewUrl ?? '');
    images = images.filter((image) => image.id !== id);
  }

  function moveImage(id: string, offset: number): void {
    const from = images.findIndex((image) => image.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= images.length) return;
    const next = [...images];
    const [image] = next.splice(from, 1);
    next.splice(to, 0, image);
    images = next;
  }

  function makeCover(id: string): void {
    const selected = images.find((image) => image.id === id);
    if (!selected) return;
    images = [selected, ...images.filter((image) => image.id !== id)];
  }

  function setImageAlt(id: string, value: string): void {
    images = images.map((image) => (image.id === id ? { ...image, alt: value } : image));
  }

  function imageDraftTags(): string[][] {
    return images.filter((image) => !image.file).map((image) => buildExistingImeta(image));
  }

  function onLicenseChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    customLicense = value === CUSTOM_LICENSE;
    license = customLicense ? '' : value;
  }

  function draftKey(): string {
    return `${DRAFT_PREFIX}${address}`;
  }

  async function saveDraft(): Promise<void> {
    if (!loaded || !address) return;
    if (!hasStorage()) {
      status = 'Draft storage is not available in this shell.';
      return;
    }

    await storage.setItem(
      draftKey(),
      JSON.stringify({
        title,
        summary,
        description,
        license,
        customLicense,
        tagsText,
        sourceUrl,
        images: imageDraftTags(),
      }),
    );
    status = 'Saved this edit draft. New image files must be reselected before publishing.';
  }

  async function loadDraft(): Promise<void> {
    if (!address || !hasStorage()) return;
    const raw = await storage.getItem(draftKey());
    if (!raw) return;

    try {
      const draft = JSON.parse(raw) as Partial<{
        title: string;
        summary: string;
        description: string;
        license: string;
        customLicense: boolean;
        tagsText: string;
        sourceUrl: string;
        images: string[][];
      }>;
      title = draft.title ?? title;
      summary = draft.summary ?? summary;
      description = draft.description ?? description;
      license = draft.license ?? license;
      customLicense =
        draft.customLicense ?? !LICENSE_OPTIONS.some((option) => option.id === license);
      tagsText = draft.tagsText ?? tagsText;
      sourceUrl = draft.sourceUrl ?? sourceUrl;
      if (Array.isArray(draft.images)) {
        resetImages(parseImageTags(draft.images));
        loadImagePreviews();
      }
      draftLoaded = true;
      status = 'Loaded a saved edit draft.';
    } catch {
      status = 'Loaded the print, but the saved draft could not be read.';
    }
  }

  async function loadObject(requested: string): Promise<void> {
    const [kind, pubkey, ...rest] = requested.split(':');
    const requestedIdentifier = rest.join(':');

    if (kind !== '33500' || !pubkey || !requestedIdentifier) {
      status = 'The shell opened this page with an address it could not read.';
      return;
    }

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    status = 'Loading print...';
    publishedAddress = '';
    draftLoaded = false;

    try {
      const { events } = await outbox.query(
        [{ kinds: [33500], authors: [pubkey], '#d': [requestedIdentifier], limit: 1 }],
        { timeoutMs: 5000 },
      );

      const newest = events
        .map((result) => result.event)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!newest) {
        status = 'This print has not been published to the relays we can reach.';
        return;
      }

      title = tagValue(newest.tags, 'title') || requestedIdentifier;
      summary = tagValue(newest.tags, 'summary');
      license = tagValue(newest.tags, 'license');
      customLicense = Boolean(license && !LICENSE_OPTIONS.some((option) => option.id === license));
      tagsText = tagValues(newest.tags, 't').join(', ');
      sourceUrl = tagValue(newest.tags, 'i');
      description = newest.content;
      resetImages(parseImageTags(newest.tags));
      // The event's author is the owner — never the pubkey the payload asked for.
      owner = newest.pubkey;
      identifier = requestedIdentifier;
      address = `33500:${newest.pubkey}:${requestedIdentifier}`;
      originalEvent = newest;
      preservedTags = newest.tags.filter((tag) => !MUTABLE_TAGS.has(tag[0])) as NostrTag[];
      loaded = true;
      status = '';
      loadImagePreviews();
      await loadDraft();
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this print.';
    }
  }

  function applyIntent(payload: unknown): void {
    const requested = (payload as { address?: unknown } | undefined)?.address;
    if (typeof requested !== 'string' || requested.length === 0) {
      status = 'The shell opened this page without a print to edit.';
      return;
    }
    void loadObject(requested);
  }

  /**
   * Opens the print's detail page. Used both to send someone who cannot edit to the
   * page they can use, and to leave here once an edit is published.
   *
   * Reports whether the shell actually took the navigation, so callers can stay put
   * and keep offering the manual route instead of assuming they are gone.
   */
  async function viewObject(): Promise<boolean> {
    if (!address || !hasIntent()) return false;
    const result = await intent.open('printable-detail', { address });
    if (!result.ok) status = result.error ?? 'Could not open that print.';
    return result.ok;
  }

  function buildReplacementTags(): NostrTag[] {
    if (!originalEvent) return [];

    const publishedAt =
      tagValue(originalEvent.tags, 'published_at') || String(originalEvent.created_at);
    const tags: NostrTag[] = [
      ['d', identifier],
      ['title', title.trim()],
      ['published_at', publishedAt],
    ];

    appendTag(tags, summary.trim() ? ['summary', summary.trim()] : null);
    appendTag(tags, license.trim() ? ['license', license.trim()] : null);
    appendTag(tags, sourceUrl.trim() ? ['i', sourceUrl.trim()] : null);
    for (const tag of buildTopicTags()) tags.push(['t', tag]);
    tags.push(...preservedTags);
    return tags;
  }

  function uploadResultToNip94(result: UploadResult, file: File): NostrTag[] {
    if (Array.isArray(result.nip94) && result.nip94.length > 0) return result.nip94;

    const tags: NostrTag[] = [];
    appendTag(tags, result.url ? ['url', result.url] : null);
    appendTag(tags, ['m', result.mimeType ?? file.type ?? 'application/octet-stream']);
    appendTag(tags, result.sha256 ? ['x', result.sha256] : null);
    appendTag(tags, result.originalSha256 ? ['ox', result.originalSha256] : null);
    appendTag(tags, result.size != null ? ['size', String(result.size)] : null);
    if (result.dimensions)
      tags.push(['dim', `${result.dimensions.width}x${result.dimensions.height}`]);
    for (const fallbackUrl of result.fallbackUrls ?? []) tags.push(['fallback', fallbackUrl]);
    return tags;
  }

  function uploadResultToImeta(result: UploadResult, image: ImageDraft): NostrTag {
    if (!image.file) return buildExistingImeta(image);

    const fields = uploadResultToNip94(result, image.file)
      .filter(([name]) => name !== 'ox')
      .map(([name, value]) => `${name} ${value}`);

    if (result.blurhash) fields.push(`blurhash ${result.blurhash}`);
    fields.push(`alt ${image.alt.trim() || image.file.name}`);
    return ['imeta', ...fields];
  }

  function buildExistingImeta(image: ImageDraft): NostrTag {
    const fields = image.originalFields.filter((entry) => {
      const parsed = parseImetaField(entry);
      return parsed?.[0] !== 'alt';
    });

    if (!fields.some((entry) => parseImetaField(entry)?.[0] === 'url') && image.url) {
      fields.push(`url ${image.url}`);
    }
    if (!fields.some((entry) => parseImetaField(entry)?.[0] === 'm') && image.mime) {
      fields.push(`m ${image.mime}`);
    }
    if (image.alt.trim()) fields.push(`alt ${image.alt.trim()}`);
    return ['imeta', ...fields];
  }

  async function uploadImage(image: ImageDraft): Promise<NostrTag> {
    if (!image.file) return buildExistingImeta(image);
    if (!hasUpload()) throw new Error('This shell does not provide image uploads.');

    status = `Uploading ${image.file.name}...`;
    const result = await upload.upload({
      data: image.file,
      filename: image.file.name,
      mimeType: image.file.type || undefined,
      caption: image.alt.trim() || image.file.name,
    });

    if (!result.ok || result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(result.error ?? `Upload failed for ${image.file.name}`);
    }
    if (!result.url) throw new Error(`Upload did not return a URL for ${image.file.name}`);
    return uploadResultToImeta(result, image);
  }

  async function buildReplacementTagsWithImages(): Promise<NostrTag[]> {
    const tags = buildReplacementTags();
    const imageTags: NostrTag[] = [];
    for (const image of images) imageTags.push(await uploadImage(image));
    return [...tags.slice(0, 3), ...imageTags, ...tags.slice(3)];
  }

  async function publishReplacement(): Promise<void> {
    if (!loaded || !isOwner || !originalEvent) return;

    const nextTitle = title.trim();
    const nextDescription = description.trim();
    if (!nextTitle) {
      status = 'Add a title before publishing.';
      return;
    }
    if (!nextDescription) {
      status = 'Add a description before publishing.';
      return;
    }
    if (images.length === 0) {
      status = 'Add at least one image. The first image is the cover.';
      return;
    }

    busy = true;
    publishedAddress = '';
    status = 'Publishing replacement print...';

    try {
      const published = await outbox.publish({
        kind: 33500,
        content: nextDescription,
        tags: await buildReplacementTagsWithImages(),
        created_at: Math.floor(Date.now() / 1000),
      });

      if (!published.ok || !published.event) {
        throw new Error(published.error ?? 'Failed to publish replacement print.');
      }

      if (published.event.pubkey !== owner) {
        throw new Error('The shell published with a different account than the print owner.');
      }

      originalEvent = published.event;
      resetImages(parseImageTags(published.event.tags));
      loadImagePreviews();
      preservedTags = published.event.tags.filter((tag) => !MUTABLE_TAGS.has(tag[0])) as NostrTag[];
      publishedAddress = `33500:${published.event.pubkey}:${identifier}`;
      address = publishedAddress;
      status = `Updated ${nextTitle}.`;
      if (hasStorage()) await storage.removeItem(draftKey());

      // The edit is complete: images uploaded, the replacement is on the relays, and
      // the draft is cleared. Hand the user to the print rather than leaving them on
      // a form they are finished with. This unmounts the frame, so it goes last, and
      // a shell that cannot route the intent falls back to the button below.
      leaving = true;
      if (!(await viewObject())) leaving = false;
    } catch (error) {
      status = error instanceof Error ? error.message : 'Publishing failed.';
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    // NAP-IDENTITY has two halves: the answer at mount, and the push that keeps it
    // current. Without the subscription, signing in would leave the gate shut.
    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then((pubkey) => {
          viewer = pubkey;
        })
        .catch(() => {
          viewer = '';
        });
      identitySubscription = identity.onChanged((pubkey) => {
        viewer = pubkey;
      });
    }

    if (!hasInc()) {
      status = 'This shell cannot deliver the print to edit.';
      return () => identitySubscription?.unsubscribe();
    }

    // Subscribe BEFORE signalling readiness — the shell flushes on the ready signal.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
      for (const image of images) revokePreview(image.previewUrl);
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="grid gap-4">
    {#if loaded && !isOwner}
      <div class="alert alert-warning" data-testid="edit-denied">
        <span>
          {viewer
            ? 'This print belongs to another maker, so it cannot be edited here.'
            : 'Sign in as the maker of this print to edit it.'}
        </span>
      </div>
      {#if hasIntent()}
        <button type="button" class="btn btn-outline w-fit" onclick={viewObject}>
          View this print instead
        </button>
      {/if}
    {/if}

    {#if status}
      <p class="text-sm text-base-content/60" aria-live="polite" data-testid="edit-status">
        {status}
      </p>
    {/if}

    {#if loaded && isOwner}
      <form class="grid gap-4" data-testid="edit-form" onsubmit={(event) => event.preventDefault()}>
        {#if draftLoaded}
          <div class="alert alert-info">
            <span>A saved draft is loaded. Publishing will replace the current object event.</span>
          </div>
        {/if}

        <div class="grid gap-4 md:grid-cols-2">
          <label class="fieldset">
            <span class="fieldset-legend">Title</span>
            <input class="input w-full" bind:value={title} placeholder="Adjustable phone stand" />
          </label>
          <label class="fieldset">
            <span class="fieldset-legend">Summary</span>
            <input class="input w-full" bind:value={summary} placeholder="A short print tagline" />
          </label>
        </div>

        <label class="fieldset">
          <span class="fieldset-legend">Description and print instructions</span>
          <textarea
            class="textarea w-full"
            bind:value={description}
            rows="9"
            placeholder="Markdown description, print orientation, assembly notes, attribution, and settings."
          ></textarea>
        </label>

        <div class="grid gap-4 md:grid-cols-2">
          <div class="fieldset">
            <span class="fieldset-legend">License</span>
            <select
              class="select w-full"
              aria-label="License"
              value={customLicense ? CUSTOM_LICENSE : license}
              onchange={onLicenseChange}
            >
              <option value="">No license set</option>
              {#each LICENSE_OPTIONS as option}
                <option value={option.id}>{option.label}</option>
              {/each}
              <option value={CUSTOM_LICENSE}>Other (SPDX identifier)</option>
            </select>
            {#if customLicense}
              <input
                class="input w-full"
                aria-label="Custom SPDX license identifier"
                bind:value={license}
                placeholder="GPL-3.0-or-later"
              />
            {/if}
          </div>
          <label class="fieldset">
            <span class="fieldset-legend">Tags</span>
            <input class="input w-full" bind:value={tagsText} placeholder="desk, organizer, pla" />
          </label>
        </div>

        <label class="fieldset">
          <span class="fieldset-legend">Imported source URL</span>
          <input
            class="input w-full"
            bind:value={sourceUrl}
            placeholder="https://www.printables.com/model/..."
          />
        </label>

        <section class="grid gap-3" aria-label="Print images">
          <div>
            <h2 class="text-sm font-medium">Images</h2>
            <p class="text-sm text-base-content/70">
              Images publish as ordered imeta tags. The first image is the print cover.
            </p>
          </div>

          <label class="fieldset">
            <span class="fieldset-legend">Add gallery images</span>
            <input
              class="file-input w-full"
              type="file"
              accept="image/*"
              multiple
              onchange={addImageFiles}
              disabled={busy}
            />
            <span class="fieldset-label">
              New files upload when you publish. Existing images are reused unless removed.
            </span>
          </label>

          {#if images.length > 0}
            <ol class="grid gap-3">
              {#each images as image, index (image.id)}
                <li class="grid gap-3 rounded-box bg-base-200 p-3 md:grid-cols-[8rem_1fr_auto]">
                  <div class="aspect-video overflow-hidden rounded-box bg-base-300">
                    {#if image.previewUrl}
                      <img
                        src={image.previewUrl}
                        alt={image.alt || title || `Object image ${index + 1}`}
                        class="h-full w-full object-cover"
                      />
                    {:else}
                      <div
                        class="grid h-full place-items-center px-3 text-center text-xs text-base-content/60"
                      >
                        Preview unavailable
                      </div>
                    {/if}
                  </div>

                  <div class="grid gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="badge" class:badge-primary={index === 0}>
                        {index === 0 ? 'Cover' : `Image ${index + 1}`}
                      </span>
                      <span class="text-xs text-base-content/60">
                        {image.file
                          ? `${image.file.name} · ${Math.round(image.file.size / 1024)} KB`
                          : image.url}
                      </span>
                    </div>
                    <label class="fieldset py-0">
                      <span class="fieldset-legend">Alt text</span>
                      <input
                        class="input input-sm w-full"
                        value={image.alt}
                        placeholder="Short image description"
                        oninput={(event) =>
                          setImageAlt(image.id, (event.currentTarget as HTMLInputElement).value)}
                        disabled={busy}
                      />
                    </label>
                  </div>

                  <div class="flex flex-wrap gap-2 md:flex-col">
                    {#if index !== 0}
                      <button
                        type="button"
                        class="btn btn-outline btn-sm"
                        onclick={() => makeCover(image.id)}
                        disabled={busy}
                      >
                        Make cover
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="btn btn-outline btn-sm"
                      onclick={() => moveImage(image.id, -1)}
                      disabled={busy || index === 0}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      class="btn btn-outline btn-sm"
                      onclick={() => moveImage(image.id, 1)}
                      disabled={busy || index === images.length - 1}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      class="btn btn-error btn-outline btn-sm"
                      onclick={() => removeImage(image.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <div class="alert">
              <span
                >Add at least one image before publishing. The first image becomes the cover.</span
              >
            </div>
          {/if}
        </section>

        <div class="rounded-box bg-base-200 p-3 text-sm text-base-content/70">
          File references, remixes, and other non-edit metadata are preserved in this version.
        </div>

        {#if publishedAddress}
          <!-- Normally the shell has already navigated by the time this renders; it
               stays for shells that cannot route the intent, or where it failed. -->
          <div class="alert alert-success">
            <span>Published the replacement event.</span>
            {#if hasIntent() && !leaving}
              <button type="button" class="btn btn-outline btn-sm" onclick={viewObject}>
                Open print
              </button>
            {/if}
          </div>
        {/if}

        <footer class="flex flex-col gap-3 pt-2 md:flex-row md:items-center md:justify-between">
          <p class="text-sm text-base-content/70">
            This keeps the same print address: 33500:&lt;maker&gt;:{identifier}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn btn-outline"
              onclick={saveDraft}
              disabled={busy || leaving}
            >
              Save draft
            </button>
            <button
              type="button"
              class="btn btn-primary"
              onclick={publishReplacement}
              disabled={busy || leaving}
            >
              {busy ? 'Publishing...' : leaving ? 'Opening print...' : 'Publish update'}
            </button>
          </div>
        </footer>
      </form>
    {/if}
  </section>
</main>
