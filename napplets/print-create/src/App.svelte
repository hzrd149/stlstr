<script lang="ts">
  import {
    identity,
    intent,
    outbox,
    storage,
    upload,
    type NostrEvent,
    type NostrTag,
  } from '@napplet/sdk';
  import {
    FILE_KIND,
    formatBytes,
    imetaFromNip94,
    isModelFile,
    nip94TagsFromUpload,
    readFileMeta,
    type FileMeta,
  } from '@stlstr/napplet-kit/files';
  import { looksLikeStl } from '@stlstr/napplet-kit/stl';
  import { renderStlThumbnail } from '@stlstr/napplet-kit/stl-thumbnail';
  import PartThumb from '@stlstr/napplet-kit/components/PartThumb.svelte';
  import { onDestroy, onMount } from 'svelte';

  type StepId = 'basics' | 'images' | 'files' | 'review';
  type FileRole = 'part' | 'instructions' | 'video' | 'preview' | 'aux';
  type UploadResult = Awaited<ReturnType<typeof upload.upload>>;
  type PublishedFile = { id: string; role: FileRole; filename: string };
  type ThumbnailStatus = 'none' | 'rendering' | 'ready' | 'error';
  type SelectedResource = {
    id: string;
    file: File;
    role: FileRole;
    description: string;
    thumbnailBlob: Blob | null;
    thumbnailUrl: string;
    thumbnailStatus: ThumbnailStatus;
  };
  type ExistingPart = { eventId: string; createdAt: number; meta: FileMeta; description: string };

  const DRAFT_KEY = 'printable-create:draft:v1';
  const EXISTING_PART_LIMIT = 200;
  const STEPS: Array<{ id: StepId; title: string; helper: string }> = [
    { id: 'basics', title: 'Basics', helper: 'Name and describe the print.' },
    { id: 'images', title: 'Images', helper: 'Add cover and gallery images.' },
    { id: 'files', title: 'Files', helper: 'Attach printable resources.' },
    { id: 'review', title: 'Review', helper: 'Publish the Nostr events.' },
  ];
  const CUSTOM_LICENSE = '__custom';
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
  const ROLE_LABELS: Record<FileRole, string> = {
    part: 'Part file',
    instructions: 'Instructions',
    video: 'Video',
    preview: 'Preview',
    aux: 'Auxiliary',
  };

  let currentStep = $state<StepId>('basics');
  let title = $state('');
  let slug = $state('');
  let summary = $state('');
  let description = $state('');
  let license = $state('CC-BY-4.0');
  let customLicense = $state(false);
  let tagsText = $state('');
  let sourceUrl = $state('');
  let imageFiles = $state<File[]>([]);
  let resources = $state<SelectedResource[]>([]);
  let existingParts = $state<ExistingPart[]>([]);
  let selectedExistingPartIds = $state<string[]>([]);
  let existingPartsLoading = $state(false);
  let existingPartsStatus = $state('');
  let partSearch = $state('');
  let currentPubkey = $state('');

  /**
   * Publishing needs a signer the shell holds. An empty pubkey means nobody is signed in,
   * so the action is disabled up front rather than failing at the end of a long form.
   */
  const signedIn = $derived(Boolean(currentPubkey));
  let status = $state('Start with the basics. Files are uploaded only when you publish.');
  let busy = $state(false);
  let publishedAddress = $state('');

  const currentIndex = $derived(STEPS.findIndex((step) => step.id === currentStep));
  const objectSlug = $derived(slugify(slug || title));
  const selectedExistingParts = $derived(
    existingParts.filter((part) => selectedExistingPartIds.includes(part.eventId)),
  );
  const visibleExistingParts = $derived(
    existingParts.filter((part) => {
      const needle = partSearch.trim().toLowerCase();
      return !needle || part.meta.name.toLowerCase().includes(needle);
    }),
  );

  const hasStorage = () => {
    const domain = getNappletNamespace().storage as Partial<typeof storage> | undefined;
    return typeof domain?.getItem === 'function' && typeof domain?.setItem === 'function';
  };
  const hasIdentity = () => {
    const domain = getNappletNamespace().identity as Partial<typeof identity> | undefined;
    return typeof domain?.getPublicKey === 'function';
  };
  const hasIntent = () => {
    const domain = getNappletNamespace().intent as Partial<typeof intent> | undefined;
    return typeof domain?.open === 'function';
  };
  const hasOutbox = () => {
    const domain = getNappletNamespace().outbox as Partial<typeof outbox> | undefined;
    return typeof domain?.query === 'function' && typeof domain?.publish === 'function';
  };

  function getNappletNamespace(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  function slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function onLicenseChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    customLicense = value === CUSTOM_LICENSE;
    license = customLicense ? '' : value;
  }

  function stepComplete(step: StepId): boolean {
    if (step === 'basics') return Boolean(title.trim() && objectSlug && description.trim());
    if (step === 'images') return imageFiles.length > 0;
    if (step === 'files') return resources.length + selectedExistingPartIds.length > 0;
    return stepComplete('basics') && stepComplete('images') && stepComplete('files');
  }

  function stepMessage(step: StepId): string {
    if (step === 'basics') return 'Add a title and description before continuing.';
    if (step === 'images') return 'Add at least one image. The first image is the cover.';
    if (step === 'files')
      return 'Add at least one printable part, instruction, video, or auxiliary file.';
    return 'Complete the previous steps before publishing.';
  }

  function goToStep(step: StepId): void {
    currentStep = step;
    status = STEPS.find((item) => item.id === step)?.helper ?? status;
  }

  function nextStep(): void {
    if (!stepComplete(currentStep)) {
      status = stepMessage(currentStep);
      return;
    }
    const next = STEPS[Math.min(currentIndex + 1, STEPS.length - 1)];
    goToStep(next.id);
  }

  function previousStep(): void {
    const previous = STEPS[Math.max(currentIndex - 1, 0)];
    goToStep(previous.id);
  }

  function onImageChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    imageFiles = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'));
    status = imageFiles.length
      ? `${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} selected.`
      : stepMessage('images');
  }

  function onResourceChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const next = Array.from(input.files ?? []).map((file) => {
      const role = inferRole(file);
      return {
        id: `${file.name}:${file.size}:${file.lastModified}`,
        file,
        role,
        description: '',
        thumbnailBlob: null,
        thumbnailUrl: '',
        thumbnailStatus: role === 'part' && isStlFile(file) ? 'rendering' : 'none',
      } satisfies SelectedResource;
    });
    resources = [...resources, ...next];
    for (const resource of next) void renderSelectedThumbnail(resource.id);
    input.value = '';
    status = resources.length
      ? `${resources.length} resource${resources.length === 1 ? '' : 's'} ready.`
      : stepMessage('files');
  }

  function inferRole(file: File): FileRole {
    const name = file.name.toLowerCase();
    if (file.type.startsWith('video/')) return 'video';
    if (file.type === 'application/pdf' || name.endsWith('.pdf') || name.endsWith('.html')) {
      return 'instructions';
    }
    if (['.stl', '.3mf', '.obj', '.step', '.stp', '.gcode'].some((ext) => name.endsWith(ext))) {
      return 'part';
    }
    return 'aux';
  }

  function isStlFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return file.type === 'model/stl' || file.type === 'application/sla' || name.endsWith('.stl');
  }

  function toExistingPart(event: NostrEvent): ExistingPart | null {
    const meta = readFileMeta(event.tags);
    if (!meta || !isModelFile(meta)) return null;
    return {
      eventId: event.id,
      createdAt: event.created_at,
      meta,
      description: event.content.trim(),
    };
  }

  function formatDate(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  async function loadExistingParts(pubkey: string): Promise<void> {
    if (!pubkey) {
      existingParts = [];
      selectedExistingPartIds = [];
      existingPartsStatus = '';
      return;
    }
    if (!hasOutbox()) {
      existingPartsStatus = 'This shell does not provide relay access for existing parts.';
      return;
    }

    existingPartsLoading = true;
    existingPartsStatus = 'Loading your existing parts...';
    try {
      const { events } = await outbox.query(
        [{ kinds: [FILE_KIND], authors: [pubkey], limit: EXISTING_PART_LIMIT }],
        { timeoutMs: 6000 },
      );
      if (currentPubkey !== pubkey) return;

      const unique = new Map<string, NostrEvent>();
      for (const { event } of events) unique.set(event.id, event);
      existingParts = [...unique.values()]
        .map(toExistingPart)
        .filter((part): part is ExistingPart => part !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
      selectedExistingPartIds = selectedExistingPartIds.filter((id) =>
        existingParts.some((part) => part.eventId === id),
      );
      existingPartsStatus = existingParts.length
        ? ''
        : 'No reusable model parts found on the relays we can reach.';
    } catch (error) {
      if (currentPubkey !== pubkey) return;
      existingPartsStatus =
        error instanceof Error ? error.message : 'Could not load existing parts.';
    } finally {
      if (currentPubkey === pubkey) existingPartsLoading = false;
    }
  }

  function toggleExistingPart(id: string): void {
    selectedExistingPartIds = selectedExistingPartIds.includes(id)
      ? selectedExistingPartIds.filter((selected) => selected !== id)
      : [...selectedExistingPartIds, id];
  }

  function revokeObjectUrl(url: string): void {
    if (url) URL.revokeObjectURL(url);
  }

  function updateResource(id: string, update: Partial<SelectedResource>): void {
    resources = resources.map((resource) =>
      resource.id === id ? { ...resource, ...update } : resource,
    );
  }

  async function renderSelectedThumbnail(id: string): Promise<void> {
    const resource = resources.find((candidate) => candidate.id === id);
    if (!resource || resource.role !== 'part' || !isStlFile(resource.file)) return;

    updateResource(id, { thumbnailStatus: 'rendering' });
    try {
      const bytes = new Uint8Array(await resource.file.arrayBuffer());
      if (!looksLikeStl(bytes)) {
        updateResource(id, { thumbnailStatus: 'none' });
        return;
      }

      const thumbnailBlob = await renderStlThumbnail(bytes, { width: 512, height: 512 });
      const thumbnailUrl = URL.createObjectURL(thumbnailBlob);
      const current = resources.find((candidate) => candidate.id === id);
      if (!current) {
        revokeObjectUrl(thumbnailUrl);
        return;
      }
      revokeObjectUrl(current.thumbnailUrl);
      updateResource(id, { thumbnailBlob, thumbnailUrl, thumbnailStatus: 'ready' });
    } catch {
      updateResource(id, { thumbnailBlob: null, thumbnailUrl: '', thumbnailStatus: 'error' });
    }
  }

  function removeResource(id: string): void {
    const removed = resources.find((resource) => resource.id === id);
    revokeObjectUrl(removed?.thumbnailUrl ?? '');
    resources = resources.filter((resource) => resource.id !== id);
  }

  function setResourceRole(id: string, role: FileRole): void {
    const resource = resources.find((candidate) => candidate.id === id);
    resources = resources.map((candidate) =>
      candidate.id === id ? { ...candidate, role } : candidate,
    );
    if (role === 'part' && resource && isStlFile(resource.file) && !resource.thumbnailBlob) {
      void renderSelectedThumbnail(id);
    }
  }

  function setResourceDescription(id: string, value: string): void {
    resources = resources.map((resource) =>
      resource.id === id ? { ...resource, description: value } : resource,
    );
  }

  function buildTags(): string[] {
    return tagsText
      .split(/[\n,]/)
      .map((tag) => tag.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean);
  }

  function appendTag(tags: NostrTag[], tag: NostrTag | null): void {
    if (tag) tags.push(tag);
  }

  function uploadResultToNip94(result: UploadResult, file: File): NostrTag[] {
    return nip94TagsFromUpload(result, file.name, file.type);
  }

  function uploadResultToImeta(result: UploadResult, file: File): NostrTag {
    return imetaFromNip94(uploadResultToNip94(result, file), file.name, result.blurhash);
  }

  async function uploadFile(file: File): Promise<UploadResult> {
    const result = await upload.upload({
      data: file,
      filename: file.name,
      mimeType: file.type || undefined,
      caption: file.name,
    });

    if (!result.ok || result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(result.error ?? `Upload failed for ${file.name}`);
    }
    if (!result.url) throw new Error(`Upload did not return a URL for ${file.name}`);
    return result;
  }

  function thumbnailName(file: File): string {
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    return `${base}-thumbnail.png`;
  }

  async function thumbnailTagsFor(resource: SelectedResource): Promise<NostrTag[]> {
    if (resource.role !== 'part' || !isStlFile(resource.file)) return [];

    try {
      let thumbnail = resource.thumbnailBlob;
      if (!thumbnail) {
        status = `Rendering thumbnail for ${resource.file.name}...`;
        const bytes = new Uint8Array(await resource.file.arrayBuffer());
        if (!looksLikeStl(bytes)) return [];
        thumbnail = await renderStlThumbnail(bytes, { width: 512, height: 512 });
      }
      const name = thumbnailName(resource.file);
      const file = new File([thumbnail], name, { type: thumbnail.type || 'image/png' });

      status = `Uploading thumbnail for ${resource.file.name}...`;
      const result = await uploadFile(file);
      if (!result.url) return [];

      const tags: NostrTag[] = [];
      const thumb: NostrTag = result.sha256
        ? ['thumb', result.url, result.sha256]
        : ['thumb', result.url];
      const image: NostrTag = result.sha256
        ? ['image', result.url, result.sha256]
        : ['image', result.url];
      tags.push(thumb, image, ['alt', `Rendered view of ${resource.file.name}`]);
      if (result.blurhash) tags.push(['blurhash', result.blurhash]);
      return tags;
    } catch {
      return [];
    }
  }

  async function publishResource(resource: SelectedResource): Promise<PublishedFile> {
    const thumbnailTags = await thumbnailTagsFor(resource);
    status = `Uploading ${resource.file.name}...`;
    const result = await uploadFile(resource.file);
    const tags = [...uploadResultToNip94(result, resource.file), ...thumbnailTags];

    status = `Publishing NIP-94 metadata for ${resource.file.name}...`;
    const published = await outbox.publish({
      kind: 1063,
      content: resource.description.trim() || resource.file.name,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });

    if (!published.ok || !published.event) {
      throw new Error(
        published.error ?? `Failed to publish file metadata for ${resource.file.name}`,
      );
    }

    return { id: published.event.id, role: resource.role, filename: resource.file.name };
  }

  async function publishObject(): Promise<void> {
    busy = true;
    publishedAddress = '';
    try {
      if (!stepComplete('review')) throw new Error(stepMessage('review'));

      status = 'Uploading images...';
      const imageTags: NostrTag[] = [];
      for (const file of imageFiles) {
        imageTags.push(uploadResultToImeta(await uploadFile(file), file));
      }

      const publishedFiles: PublishedFile[] = [];
      for (const resource of resources) publishedFiles.push(await publishResource(resource));
      for (const part of selectedExistingParts) {
        publishedFiles.push({ id: part.eventId, role: 'part', filename: part.meta.name });
      }

      const tags: NostrTag[] = [
        ['d', objectSlug],
        ['title', title.trim()],
        ['published_at', String(Math.floor(Date.now() / 1000))],
        ...imageTags,
      ];

      appendTag(tags, summary.trim() ? ['summary', summary.trim()] : null);
      appendTag(tags, license.trim() ? ['license', license.trim()] : null);
      appendTag(tags, sourceUrl.trim() ? ['i', sourceUrl.trim()] : null);
      for (const tag of buildTags()) tags.push(['t', tag]);
      for (const file of publishedFiles) tags.push(['e', file.id, '', file.role]);

      status = 'Publishing print...';
      const published = await outbox.publish({
        kind: 33500,
        content: description.trim(),
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });

      if (!published.ok || !published.event) {
        throw new Error(published.error ?? 'Failed to publish print.');
      }

      publishedAddress = `33500:${published.event.pubkey}:${objectSlug}`;
      status = `Published ${title.trim()}.`;
      if (hasStorage()) await storage.removeItem(DRAFT_KEY);
    } catch (error) {
      status = error instanceof Error ? error.message : 'Publishing failed.';
    } finally {
      busy = false;
    }
  }

  async function saveDraft(): Promise<void> {
    if (!hasStorage()) {
      status = 'Draft storage is not available in this shell.';
      return;
    }
    await storage.setItem(
      DRAFT_KEY,
      JSON.stringify({ title, slug, summary, description, license, tagsText, sourceUrl }),
    );
    status = 'Saved text fields. Files must be reselected before publishing.';
  }

  async function loadDraft(): Promise<void> {
    if (!hasStorage()) return;
    const raw = await storage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw) as Partial<Record<string, string>>;
    title = draft.title ?? title;
    slug = draft.slug ?? slug;
    summary = draft.summary ?? summary;
    description = draft.description ?? description;
    license = draft.license ?? license;
    customLicense = !LICENSE_OPTIONS.some((option) => option.id === license);
    tagsText = draft.tagsText ?? tagsText;
    sourceUrl = draft.sourceUrl ?? sourceUrl;
    status = 'Loaded saved text draft. Reselect files before publishing.';
  }

  async function openPublishedObject(): Promise<void> {
    if (!publishedAddress || !hasIntent()) return;
    await intent.open('printable-detail', { address: publishedAddress });
  }

  onMount(() => {
    // NAP-IDENTITY is the only source for who the user is, and it has two halves: the
    // question answered at mount, and the push that keeps it current. Without the
    // subscription this napplet would still think you were signed out after you logged in.
    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then((pubkey) => {
          currentPubkey = pubkey;
          void loadExistingParts(pubkey);
        })
        .catch(() => {
          currentPubkey = '';
          void loadExistingParts('');
        });
      identitySubscription = identity.onChanged((pubkey) => {
        currentPubkey = pubkey;
        void loadExistingParts(pubkey);
      });
    }

    void loadDraft();

    return () => identitySubscription?.unsubscribe();
  });

  onDestroy(() => {
    for (const resource of resources) revokeObjectUrl(resource.thumbnailUrl);
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <nav class="mb-4" aria-label="Create print steps">
    <ul class="steps steps-vertical w-full lg:steps-horizontal">
      {#each STEPS as step, index}
        <li class="step" class:step-primary={step.id === currentStep || stepComplete(step.id)}>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onclick={() => goToStep(step.id)}
            aria-current={step.id === currentStep ? 'step' : undefined}
            aria-label={`${index + 1}. ${step.title}: ${step.helper}`}
          >
            {step.title}
          </button>
        </li>
      {/each}
    </ul>
  </nav>

  <form class="grid gap-4" onsubmit={(event) => event.preventDefault()}>
    {#if currentStep === 'basics'}
      <section class="grid gap-4" aria-label="Print basics">
        <p class="text-sm text-base-content/70">Add the human-facing metadata for this print.</p>

        <label class="fieldset">
          <span class="fieldset-legend">Title</span>
          <input
            id="object-title"
            class="input w-full"
            bind:value={title}
            placeholder="Adjustable phone stand"
          />
        </label>

        <label class="fieldset">
          <span class="fieldset-legend">Summary</span>
          <input class="input w-full" bind:value={summary} placeholder="A short print tagline" />
        </label>

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

        <details class="collapse-arrow collapse border border-base-300 bg-base-200">
          <summary class="collapse-title text-sm font-medium">Advanced settings</summary>
          <div class="collapse-content">
            <label class="fieldset">
              <span class="fieldset-legend">Slug / d tag</span>
              <input
                class="input w-full"
                bind:value={slug}
                placeholder={slugify(title) || 'adjustable-phone-stand'}
              />
              <span class="fieldset-label">
                Identifies the print. Derived from the title unless you set it here.
              </span>
            </label>
          </div>
        </details>
      </section>
    {:else if currentStep === 'images'}
      <section class="grid gap-4" aria-label="Print images">
        <p class="text-sm text-base-content/70">
          Images stay inline as ordered imeta tags. The first image is the cover.
        </p>

        <label class="fieldset">
          <span class="fieldset-legend">Select images</span>
          <input
            class="file-input w-full"
            type="file"
            accept="image/*"
            multiple
            onchange={onImageChange}
          />
          <span class="fieldset-label"
            >Use the file picker order for cover and gallery sequencing.</span
          >
        </label>

        {#if imageFiles.length > 0}
          <ol class="list bg-base-200 rounded-box">
            {#each imageFiles as file, index}
              <li class="list-row">
                <div class="badge badge-primary">{index + 1}</div>
                <div class="grid">
                  <span>{index === 0 ? 'Cover image' : `Gallery image ${index}`}</span>
                  <span class="text-xs text-base-content/60"
                    >{file.name} · {Math.round(file.size / 1024)} KB</span
                  >
                </div>
              </li>
            {/each}
          </ol>
        {:else}
          <div class="alert">No images selected yet.</div>
        {/if}
      </section>
    {:else if currentStep === 'files'}
      <section class="grid gap-4" aria-label="Printable files and resources">
        <p class="text-sm text-base-content/70">
          Upload new resources or reuse parts you have already published. New STL parts get a
          rendered thumbnail when the browser can create one.
        </p>

        <label class="fieldset">
          <span class="fieldset-legend">Select parts and resources</span>
          <input class="file-input w-full" type="file" multiple onchange={onResourceChange} />
          <span class="fieldset-label"
            >STL, 3MF, PDF, videos, slicer profiles, support files, and related assets.</span
          >
        </label>

        {#if resources.length > 0}
          <div class="divide-y divide-base-300" data-testid="selected-resources-list">
            {#each resources as resource}
              <article class="grid gap-3 py-3 md:grid-cols-[4rem_minmax(0,1fr)_12rem_auto]">
                <div
                  class="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-box bg-base-200"
                >
                  {#if resource.thumbnailUrl}
                    <img
                      src={resource.thumbnailUrl}
                      alt={`Rendered preview of ${resource.file.name}`}
                      class="h-full w-full object-cover"
                      data-testid="selected-part-thumbnail"
                    />
                  {:else if resource.thumbnailStatus === 'rendering'}
                    <span
                      class="loading loading-spinner loading-sm"
                      aria-label="Rendering thumbnail"
                    ></span>
                  {:else}
                    <span class="text-xs font-medium text-base-content/50">
                      {isStlFile(resource.file)
                        ? '3D'
                        : resource.file.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}
                    </span>
                  {/if}
                </div>
                <div class="min-w-0">
                  <div class="truncate font-medium">{resource.file.name}</div>
                  <div class="text-xs text-base-content/60">
                    {formatBytes(resource.file.size)} · {ROLE_LABELS[resource.role]}
                    {#if resource.thumbnailStatus === 'ready'}
                      · thumbnail ready
                    {:else if resource.thumbnailStatus === 'error'}
                      · thumbnail unavailable
                    {/if}
                  </div>
                  <textarea
                    class="textarea mt-2 w-full"
                    rows="2"
                    placeholder="Optional file-specific print notes"
                    value={resource.description}
                    oninput={(event) =>
                      setResourceDescription(
                        resource.id,
                        (event.currentTarget as HTMLTextAreaElement).value,
                      )}
                  ></textarea>
                </div>
                <select
                  class="select w-full"
                  aria-label={`Role for ${resource.file.name}`}
                  value={resource.role}
                  onchange={(event) =>
                    setResourceRole(
                      resource.id,
                      (event.currentTarget as HTMLSelectElement).value as FileRole,
                    )}
                >
                  {#each Object.entries(ROLE_LABELS) as [role, label]}
                    <option value={role}>{label}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="btn btn-error btn-outline btn-sm"
                  onclick={() => removeResource(resource.id)}
                >
                  Remove
                </button>
              </article>
            {/each}
          </div>
        {:else}
          <div class="alert">No printable resources selected yet.</div>
        {/if}

        <div class="divider">Existing parts</div>

        <section class="grid gap-3" aria-label="Existing published parts">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold">Reuse published parts</h2>
              <p class="text-sm text-base-content/70">
                Selected parts are referenced directly. They are not uploaded again.
              </p>
            </div>
            <button
              type="button"
              class="btn btn-outline btn-sm"
              onclick={() => loadExistingParts(currentPubkey)}
              disabled={!signedIn || existingPartsLoading}
            >
              {existingPartsLoading ? 'Loading...' : 'Refresh parts'}
            </button>
          </div>

          {#if existingParts.length > 0}
            <input
              class="input w-full sm:w-80"
              placeholder="Filter existing parts"
              aria-label="Filter existing parts"
              bind:value={partSearch}
            />
          {/if}

          {#if existingPartsLoading && existingParts.length === 0}
            <div class="grid gap-2" aria-label="Loading existing parts">
              {#each [0, 1, 2] as placeholder (placeholder)}
                <div class="skeleton h-16 w-full"></div>
              {/each}
            </div>
          {:else if !signedIn}
            <div class="alert">Sign in to reuse your published parts.</div>
          {:else if existingParts.length === 0}
            <div class="alert">{existingPartsStatus || 'No existing model parts loaded yet.'}</div>
          {:else if visibleExistingParts.length === 0}
            <div class="alert">No existing parts match that filter.</div>
          {:else}
            <ul
              class="max-h-96 divide-y divide-base-300 overflow-y-auto pr-1"
              data-testid="existing-parts-list"
            >
              {#each visibleExistingParts as part (part.eventId)}
                {@const selected = selectedExistingPartIds.includes(part.eventId)}
                <li class="py-3" data-testid="existing-part-row">
                  <label class="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-primary mt-3"
                      checked={selected}
                      onchange={() => toggleExistingPart(part.eventId)}
                      aria-label={`Reuse ${part.meta.name}`}
                    />
                    <PartThumb file={part.meta} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium">{part.meta.name}</span>
                      <span class="block text-xs text-base-content/60">
                        {[
                          formatBytes(part.meta.sizeBytes),
                          part.meta.mime,
                          formatDate(part.createdAt),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {#if part.description}
                        <span class="mt-1 block line-clamp-2 text-sm text-base-content/70">
                          {part.description}
                        </span>
                      {/if}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}

          {#if selectedExistingParts.length > 0}
            <p class="text-sm text-base-content/70" data-testid="selected-existing-parts">
              {selectedExistingParts.length} existing part{selectedExistingParts.length === 1
                ? ''
                : 's'} selected for this print.
            </p>
          {/if}
        </section>
      </section>
    {:else}
      <section class="grid gap-4" aria-label="Review and publish">
        <p class="text-sm text-base-content/70">
          Review uploads, NIP-94 file events, and the final object event before publishing.
        </p>

        <dl class="grid gap-2 rounded-box bg-base-200 p-3">
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Print</dt>
            <dd>{title || 'Untitled'}</dd>
          </div>
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Address</dt>
            <dd class="break-all">33500:&lt;pubkey&gt;:{objectSlug || '<d>'}</dd>
          </div>
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Images</dt>
            <dd>{imageFiles.length} inline imeta tag{imageFiles.length === 1 ? '' : 's'}</dd>
          </div>
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Resources</dt>
            <dd>
              {resources.length} new upload{resources.length === 1 ? '' : 's'}, {selectedExistingParts.length}
              existing part{selectedExistingParts.length === 1 ? '' : 's'}
            </dd>
          </div>
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Tags</dt>
            <dd>{buildTags().join(', ') || 'None'}</dd>
          </div>
          <div class="grid gap-1 md:grid-cols-[8rem_1fr]">
            <dt>Source</dt>
            <dd>{sourceUrl || 'Nostr-native print'}</dd>
          </div>
        </dl>

        {#if publishedAddress}
          <div class="alert alert-success">
            <strong>Published address</strong>
            <span class="break-all">{publishedAddress}</span>
          </div>
        {/if}
      </section>
    {/if}
  </form>

  <footer
    class="mt-4 flex flex-col gap-3 pt-4 lg:flex-row lg:items-center lg:justify-between"
    aria-live="polite"
  >
    <p class="text-sm text-base-content/70">{status}</p>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn btn-outline" onclick={saveDraft} disabled={busy}
        >Save text draft</button
      >
      <button
        type="button"
        class="btn btn-outline"
        onclick={previousStep}
        disabled={busy || currentIndex === 0}
      >
        Back
      </button>
      {#if currentStep !== 'review'}
        <button type="button" class="btn btn-primary" onclick={nextStep} disabled={busy}
          >Continue</button
        >
      {:else}
        {#if !signedIn}
          <span class="text-sm text-base-content/70" data-testid="publish-needs-account">
            Sign in to publish this print.
          </span>
        {/if}
        {#if publishedAddress && hasIntent()}
          <button type="button" class="btn btn-outline" onclick={openPublishedObject}
            >Open print</button
          >
        {/if}
        <button
          type="button"
          class="btn btn-primary"
          onclick={publishObject}
          disabled={busy || !signedIn}
          data-testid="publish-object"
        >
          {busy ? 'Publishing...' : 'Publish print'}
        </button>
      {/if}
    </div>
  </footer>
</main>
