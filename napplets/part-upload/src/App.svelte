<script lang="ts">
  import {
    identity,
    inc,
    intent,
    outbox,
    upload,
    type NostrEvent,
    type NostrTag,
  } from '@napplet/sdk';
  import {
    FILE_KIND,
    formatBytes,
    nip94TagsFromUpload,
    readFileMeta,
  } from '@stlstr/napplet-kit/files';
  import { looksLikeStl } from '@stlstr/napplet-kit/stl';
  import { renderStlThumbnail } from '@stlstr/napplet-kit/stl-thumbnail';
  import { hasMethods } from '@stlstr/napplet-kit/capabilities';
  import { onDestroy, onMount } from 'svelte';

  const OPEN_TOPIC = 'part-upload:open';
  const CREATE_TOPIC = 'part-upload:create';
  const READY_TOPIC = 'part-upload:ready';
  const LIBRARY_ARCHETYPE = 'part-library';

  type UploadResult = Awaited<ReturnType<typeof upload.upload>>;
  type RowStatus =
    | 'ready'
    | 'hashing'
    | 'duplicate'
    | 'thumbnailing'
    | 'uploading'
    | 'publishing'
    | 'done'
    | 'error';
  type SelectedPart = {
    id: string;
    file: File;
    name: string;
    description: string;
    sha256: string;
    duplicateId: string;
    publishedId: string;
    thumbnailBlob: Blob | null;
    thumbnailUrl: string;
    thumbnailStatus: 'none' | 'rendering' | 'ready' | 'error';
    thumbnailPitch: number;
    thumbnailYaw: number;
    status: RowStatus;
    message: string;
  };

  let viewer = $state('');
  let identityReady = $state(false);
  let rows = $state<SelectedPart[]>([]);
  let status = $state('Select one or more files to publish as reusable parts.');
  let busy = $state(false);
  let thumbnailDialog = $state<HTMLDialogElement | null>(null);
  let editorRowId = $state('');
  let editorPitch = $state(0);
  let editorYaw = $state(0);
  let editorBlob = $state<Blob | null>(null);
  let editorUrl = $state('');
  let editorStatus = $state('');
  let editorBusy = $state(false);

  const signedIn = $derived(Boolean(viewer));
  const publishableRows = $derived(rows.filter((row) => row.status !== 'done'));
  const canPublish = $derived(signedIn && rows.length > 0 && !busy);

  const hasIdentity = () => hasMethods('identity', 'getPublicKey', 'onChanged');
  const hasInc = () => hasMethods('inc', 'on', 'emit');
  const hasOutbox = () => hasMethods('outbox', 'query', 'publish');
  const hasUpload = () => hasMethods('upload', 'upload');
  const hasIntent = () => hasMethods('intent', 'open');

  function rowId(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
  }

  function setRow(id: string, patch: Partial<SelectedPart>): void {
    rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  function removeRow(id: string): void {
    const removed = rows.find((row) => row.id === id);
    revokeObjectUrl(removed?.thumbnailUrl ?? '');
    rows = rows.filter((row) => row.id !== id);
  }

  function updateName(id: string, name: string): void {
    setRow(id, { name });
  }

  function updateDescription(id: string, description: string): void {
    setRow(id, { description });
  }

  function revokeObjectUrl(url: string): void {
    if (url) URL.revokeObjectURL(url);
  }

  function isStlFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return file.type === 'model/stl' || file.type === 'application/sla' || name.endsWith('.stl');
  }

  function thumbnailName(file: File): string {
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    return `${base}-thumbnail.png`;
  }

  async function renderThumbnail(rowId: string): Promise<void> {
    const row = rows.find((candidate) => candidate.id === rowId);
    if (!row || !isStlFile(row.file)) return;

    setRow(row.id, {
      thumbnailStatus: 'rendering',
      message: 'Rendering preview thumbnail...',
    });

    try {
      const bytes = new Uint8Array(await row.file.arrayBuffer());
      if (!looksLikeStl(bytes)) {
        setRow(row.id, { thumbnailStatus: 'none', message: 'Ready to publish.' });
        return;
      }

      const thumbnailBlob = await renderStlThumbnail(bytes, {
        width: 512,
        height: 512,
        rotationX: row.thumbnailPitch,
        rotationY: row.thumbnailYaw,
      });
      const thumbnailUrl = URL.createObjectURL(thumbnailBlob);
      const current = rows.find((candidate) => candidate.id === row.id);
      if (!current) {
        revokeObjectUrl(thumbnailUrl);
        return;
      }

      revokeObjectUrl(current.thumbnailUrl);
      setRow(row.id, {
        thumbnailBlob,
        thumbnailUrl,
        thumbnailStatus: 'ready',
        message: 'Thumbnail ready. Rotate it if the view needs adjustment.',
      });
    } catch (error) {
      setRow(row.id, {
        thumbnailBlob: null,
        thumbnailUrl: '',
        thumbnailStatus: 'error',
        message: error instanceof Error ? error.message : 'Could not render a thumbnail.',
      });
    }
  }

  async function renderEditorThumbnail(): Promise<void> {
    const row = rows.find((candidate) => candidate.id === editorRowId);
    if (!row) return;

    editorBusy = true;
    editorStatus = 'Rendering thumbnail...';
    try {
      const bytes = new Uint8Array(await row.file.arrayBuffer());
      if (!looksLikeStl(bytes)) {
        editorStatus = 'This file is not an STL that can be rendered here.';
        return;
      }

      const nextBlob = await renderStlThumbnail(bytes, {
        width: 512,
        height: 512,
        rotationX: editorPitch,
        rotationY: editorYaw,
      });
      const nextUrl = URL.createObjectURL(nextBlob);
      revokeObjectUrl(editorUrl);
      editorBlob = nextBlob;
      editorUrl = nextUrl;
      editorStatus = 'Rotate until the part reads clearly, then save.';
    } catch (error) {
      editorStatus = error instanceof Error ? error.message : 'Could not render the thumbnail.';
    } finally {
      editorBusy = false;
    }
  }

  function openThumbnailEditor(row: SelectedPart): void {
    if (!isStlFile(row.file) || row.status === 'done' || busy) return;
    editorRowId = row.id;
    editorPitch = row.thumbnailPitch;
    editorYaw = row.thumbnailYaw;
    editorBlob = row.thumbnailBlob;
    revokeObjectUrl(editorUrl);
    editorUrl = row.thumbnailBlob ? URL.createObjectURL(row.thumbnailBlob) : '';
    editorStatus = 'Rotate until the part reads clearly, then save.';
    thumbnailDialog?.showModal();
    if (!editorUrl) void renderEditorThumbnail();
  }

  function rotateEditor(pitchDelta: number, yawDelta: number): void {
    if (editorBusy) return;
    editorPitch += pitchDelta;
    editorYaw += yawDelta;
    void renderEditorThumbnail();
  }

  function resetEditor(): void {
    if (editorBusy) return;
    editorPitch = -Math.PI * 0.15;
    editorYaw = Math.PI * 0.25;
    void renderEditorThumbnail();
  }

  function closeThumbnailEditor(): void {
    if (thumbnailDialog?.open) thumbnailDialog.close();
    editorRowId = '';
    editorBlob = null;
    revokeObjectUrl(editorUrl);
    editorUrl = '';
    editorStatus = '';
    editorBusy = false;
  }

  function saveThumbnailEditor(): void {
    const row = rows.find((candidate) => candidate.id === editorRowId);
    if (!row || !editorBlob) return;

    const thumbnailUrl = URL.createObjectURL(editorBlob);
    revokeObjectUrl(row.thumbnailUrl);
    setRow(row.id, {
      thumbnailBlob: editorBlob,
      thumbnailUrl,
      thumbnailStatus: 'ready',
      thumbnailPitch: editorPitch,
      thumbnailYaw: editorYaw,
      message: 'Thumbnail saved.',
    });
    closeThumbnailEditor();
  }

  function hex(bytes: ArrayBuffer): string {
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(file: File): Promise<string> {
    return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  }

  async function findDuplicate(pubkey: string, hash: string): Promise<NostrEvent | null> {
    if (!hash || !hasOutbox()) return null;
    const { events } = await outbox.query(
      [{ kinds: [FILE_KIND], authors: [pubkey], '#x': [hash], limit: 1 }],
      { timeoutMs: 5000 },
    );
    return events.map((result) => result.event).find((event) => readFileMeta(event.tags)) ?? null;
  }

  async function prepareRow(row: SelectedPart, pubkey: string): Promise<void> {
    setRow(row.id, { status: 'hashing', message: 'Checking for duplicates...' });
    try {
      const hash = await sha256(row.file);
      const duplicate = await findDuplicate(pubkey, hash);
      if (duplicate) {
        setRow(row.id, {
          sha256: hash,
          duplicateId: duplicate.id,
          status: 'duplicate',
          message: 'This exact file is already in your library. It will be reused.',
        });
      } else {
        setRow(row.id, { sha256: hash, status: 'ready', message: 'Ready to publish.' });
      }
    } catch (error) {
      setRow(row.id, {
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not inspect this file.',
      });
    }
  }

  async function prepareRows(nextRows: SelectedPart[], pubkey: string): Promise<void> {
    if (!pubkey) return;
    for (const row of nextRows) await prepareRow(row, pubkey);
  }

  function onFileChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const nextRows = Array.from(input.files ?? []).map((file) => ({
      id: rowId(file),
      file,
      name: file.name,
      description: '',
      sha256: '',
      duplicateId: '',
      publishedId: '',
      thumbnailBlob: null,
      thumbnailUrl: '',
      thumbnailStatus: isStlFile(file) ? 'rendering' : 'none',
      thumbnailPitch: -Math.PI * 0.15,
      thumbnailYaw: Math.PI * 0.25,
      status: 'ready' as RowStatus,
      message: 'Ready to inspect.',
    }));
    rows = [...rows, ...nextRows];
    input.value = '';
    status = nextRows.length
      ? `${nextRows.length} file${nextRows.length === 1 ? '' : 's'} selected.`
      : 'Choose files to publish.';
    for (const row of nextRows) void renderThumbnail(row.id);
    void prepareRows(nextRows, viewer);
  }

  async function uploadFile(row: SelectedPart): Promise<UploadResult> {
    const result = await upload.upload({
      data: row.file,
      filename: row.name.trim() || row.file.name,
      mimeType: row.file.type || undefined,
      caption: row.name.trim() || row.file.name,
    });

    if (!result.ok || result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(result.error ?? `Upload failed for ${row.file.name}`);
    }
    if (!result.url) throw new Error(`Upload did not return a URL for ${row.file.name}`);
    return result;
  }

  async function uploadThumbnail(row: SelectedPart, thumbnail: Blob): Promise<UploadResult> {
    const name = thumbnailName(row.file);
    const file = new File([thumbnail], name, { type: thumbnail.type || 'image/png' });
    const result = await upload.upload({
      data: file,
      filename: name,
      mimeType: file.type,
      caption: `Rendered view of ${row.name.trim() || row.file.name}`,
    });

    if (!result.ok || result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(result.error ?? `Thumbnail upload failed for ${row.file.name}`);
    }
    if (!result.url) throw new Error(`Thumbnail upload did not return a URL for ${row.file.name}`);
    return result;
  }

  async function thumbnailTagsFor(row: SelectedPart): Promise<NostrTag[]> {
    if (!isStlFile(row.file)) return [];

    let thumbnail = row.thumbnailBlob;
    if (!thumbnail) {
      setRow(row.id, { status: 'thumbnailing', message: 'Rendering preview thumbnail...' });
      const bytes = new Uint8Array(await row.file.arrayBuffer());
      if (!looksLikeStl(bytes)) return [];
      thumbnail = await renderStlThumbnail(bytes, {
        width: 512,
        height: 512,
        rotationX: row.thumbnailPitch,
        rotationY: row.thumbnailYaw,
      });
    }

    setRow(row.id, { status: 'thumbnailing', message: 'Uploading preview thumbnail...' });
    const result = await uploadThumbnail(row, thumbnail);

    const tags: NostrTag[] = [];
    tags.push(result.sha256 ? ['thumb', result.url, result.sha256] : ['thumb', result.url]);
    tags.push(result.sha256 ? ['image', result.url, result.sha256] : ['image', result.url]);
    tags.push(['alt', `Rendered view of ${row.name.trim() || row.file.name}`]);
    if (result.blurhash) tags.push(['blurhash', result.blurhash]);
    return tags;
  }

  async function publishRow(row: SelectedPart): Promise<void> {
    if (row.status === 'done') return;

    if (row.duplicateId) {
      setRow(row.id, {
        status: 'done',
        publishedId: row.duplicateId,
        message: 'Reusing existing part.',
      });
      return;
    }

    const thumbnailTags = await thumbnailTagsFor(row);

    setRow(row.id, { status: 'uploading', message: 'Uploading file...' });
    const result = await uploadFile(row);
    if (row.sha256 && result.sha256 && row.sha256 !== result.sha256) {
      throw new Error('The uploaded file hash did not match the local file hash.');
    }

    setRow(row.id, { status: 'publishing', message: 'Publishing file metadata...' });
    const tags: NostrTag[] = [
      ...nip94TagsFromUpload(result, row.name.trim() || row.file.name, row.file.type),
      ...thumbnailTags,
    ];
    const published = await outbox.publish({
      kind: FILE_KIND,
      content: row.description.trim(),
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });

    if (!published.ok || !published.event) {
      throw new Error(published.error ?? `Failed to publish metadata for ${row.file.name}`);
    }

    setRow(row.id, { status: 'done', publishedId: published.event.id, message: 'Published.' });
  }

  async function publishAll(): Promise<void> {
    if (!signedIn) {
      status = 'Sign in before publishing parts.';
      return;
    }
    if (!hasOutbox() || !hasUpload()) {
      status = 'This shell does not provide publishing and upload access.';
      return;
    }

    busy = true;
    status = 'Publishing selected parts...';
    try {
      for (const row of publishableRows) {
        try {
          await publishRow(row);
        } catch (error) {
          setRow(row.id, {
            status: 'error',
            message: error instanceof Error ? error.message : 'Publishing failed.',
          });
        }
      }

      const failures = rows.filter((row) => row.status === 'error').length;
      if (failures) {
        status = `${failures} file${failures === 1 ? '' : 's'} need attention. Retry will skip completed rows.`;
        return;
      }

      status = 'Parts published.';
      if (hasIntent()) await intent.open(LIBRARY_ARCHETYPE, {});
    } finally {
      busy = false;
    }
  }

  function applyIntent(): void {
    status = 'Select one or more files to publish as reusable parts.';
  }

  function applyViewer(pubkey: string): void {
    viewer = pubkey;
    identityReady = true;
    if (pubkey)
      void prepareRows(
        rows.filter((row) => !row.sha256),
        pubkey,
      );
  }

  onMount(() => {
    let identitySubscription: { unsubscribe(): void } | null = null;
    if (hasIdentity()) {
      void identity
        .getPublicKey()
        .then(applyViewer)
        .catch(() => applyViewer(''));
      identitySubscription = identity.onChanged(applyViewer);
    } else {
      identityReady = true;
      status = 'This shell cannot tell us who is signed in, so parts cannot be published.';
    }

    if (!hasInc()) return () => identitySubscription?.unsubscribe();

    const openSubscription = inc.on(OPEN_TOPIC, applyIntent);
    const createSubscription = inc.on(CREATE_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      openSubscription.unsubscribe();
      createSubscription.unsubscribe();
      identitySubscription?.unsubscribe();
    };
  });

  onDestroy(() => {
    for (const row of rows) revokeObjectUrl(row.thumbnailUrl);
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="grid gap-4" aria-label="Upload parts">
    <div>
      <h1 class="text-2xl font-bold">Upload parts</h1>
      <p class="mt-1 text-sm text-base-content/70">
        Publish reusable file events. A print decides how each file is used when it references it.
      </p>
    </div>

    {#if identityReady && !signedIn}
      <div class="alert alert-warning" data-testid="upload-signed-out">
        <span>Sign in to upload parts to your library.</span>
      </div>
    {/if}

    <label class="fieldset">
      <span class="fieldset-legend">Select files</span>
      <input
        class="file-input w-full"
        type="file"
        multiple
        onchange={onFileChange}
        disabled={!signedIn || busy}
      />
      <span class="fieldset-label">STL, 3MF, PDFs, slicer profiles, and related print files.</span>
    </label>

    {#if rows.length > 0}
      <div class="divide-y divide-base-300" data-testid="upload-parts-list">
        {#each rows as row (row.id)}
          <article
            class="grid gap-3 py-3 md:grid-cols-[8rem_minmax(0,1fr)_11rem_auto]"
            data-testid="upload-part-row"
          >
            <div class="grid gap-2">
              <button
                type="button"
                class="grid aspect-square place-items-center overflow-hidden rounded-box bg-base-200 text-left"
                onclick={() => openThumbnailEditor(row)}
                disabled={!isStlFile(row.file) || row.status === 'done' || busy}
                aria-label={`Edit thumbnail for ${row.name || row.file.name}`}
                data-testid="edit-upload-thumbnail"
              >
                {#if row.thumbnailUrl}
                  <img
                    src={row.thumbnailUrl}
                    alt={`Thumbnail preview for ${row.name || row.file.name}`}
                    class="h-full w-full object-contain"
                    data-testid="upload-part-thumbnail"
                  />
                {:else if row.thumbnailStatus === 'rendering'}
                  <span class="loading loading-spinner loading-sm" aria-label="Rendering thumbnail"
                  ></span>
                {:else}
                  <span class="text-xs font-medium text-base-content/50">
                    {isStlFile(row.file)
                      ? '3D'
                      : row.file.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}
                  </span>
                {/if}
              </button>
              {#if isStlFile(row.file) && row.thumbnailStatus !== 'none'}
                <p class="text-center text-xs text-base-content/60">Click to rotate</p>
              {/if}
            </div>

            <div class="min-w-0">
              <label class="fieldset py-0">
                <span class="fieldset-legend">Display name</span>
                <input
                  class="input input-sm w-full"
                  value={row.name}
                  oninput={(event) =>
                    updateName(row.id, (event.currentTarget as HTMLInputElement).value)}
                  disabled={busy || row.status === 'done'}
                />
              </label>
              <textarea
                class="textarea textarea-sm mt-2 w-full"
                rows="2"
                placeholder="Optional file notes"
                value={row.description}
                oninput={(event) =>
                  updateDescription(row.id, (event.currentTarget as HTMLTextAreaElement).value)}
                disabled={busy || row.status === 'done'}
              ></textarea>
            </div>

            <div class="text-sm text-base-content/70">
              <div class="truncate font-medium">{row.file.name}</div>
              <div>{formatBytes(row.file.size)} · {row.file.type || 'unknown type'}</div>
              {#if row.sha256}
                <div class="mt-1 truncate text-xs">sha256 {row.sha256}</div>
              {/if}
            </div>

            <div class="flex flex-wrap items-start justify-end gap-2">
              <span
                class="badge"
                class:badge-success={row.status === 'done'}
                class:badge-warning={row.status === 'duplicate'}
                class:badge-error={row.status === 'error'}
                data-testid="upload-part-status"
              >
                {row.status}
              </span>
              {#if row.status !== 'done'}
                <button
                  type="button"
                  class="btn btn-outline btn-sm"
                  onclick={() => removeRow(row.id)}
                  disabled={busy}
                >
                  Remove
                </button>
              {/if}
            </div>

            {#if row.message}
              <p class="md:col-span-3 text-sm text-base-content/60" aria-live="polite">
                {row.message}
              </p>
            {/if}
          </article>
        {/each}
      </div>
    {:else}
      <div class="alert">No files selected yet.</div>
    {/if}

    <footer class="flex flex-col gap-3 pt-2 md:flex-row md:items-center md:justify-between">
      <p class="text-sm text-base-content/70" aria-live="polite" data-testid="upload-status">
        {status}
      </p>
      <button
        type="button"
        class="btn btn-primary"
        onclick={publishAll}
        disabled={!canPublish}
        data-testid="publish-parts"
      >
        {busy ? 'Publishing...' : 'Publish parts'}
      </button>
    </footer>
  </section>

  <dialog class="modal" bind:this={thumbnailDialog} onclose={closeThumbnailEditor}>
    <div class="modal-box max-w-2xl">
      <h2 class="text-lg font-bold">Set thumbnail view</h2>
      <p class="mt-1 text-sm text-base-content/70">
        This thumbnail is saved on the part event so lists can preview the part without loading the
        full model.
      </p>

      <div class="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_11rem]">
        <div class="grid aspect-square place-items-center overflow-hidden rounded-box bg-base-200">
          {#if editorUrl}
            <img
              src={editorUrl}
              alt="Current part thumbnail orientation"
              class="h-full w-full object-contain"
              data-testid="thumbnail-editor-preview"
            />
          {:else if editorBusy}
            <span class="loading loading-spinner loading-lg" aria-label="Rendering thumbnail"
            ></span>
          {:else}
            <span class="text-sm text-base-content/60">No thumbnail rendered yet.</span>
          {/if}
        </div>

        <div class="grid content-start gap-2">
          <button
            type="button"
            class="btn btn-outline"
            onclick={() => rotateEditor(-Math.PI / 12, 0)}
            disabled={editorBusy}
          >
            Tilt up
          </button>
          <button
            type="button"
            class="btn btn-outline"
            onclick={() => rotateEditor(Math.PI / 12, 0)}
            disabled={editorBusy}
          >
            Tilt down
          </button>
          <button
            type="button"
            class="btn btn-outline"
            onclick={() => rotateEditor(0, -Math.PI / 12)}
            disabled={editorBusy}
          >
            Rotate left
          </button>
          <button
            type="button"
            class="btn btn-outline"
            onclick={() => rotateEditor(0, Math.PI / 12)}
            disabled={editorBusy}
          >
            Rotate right
          </button>
          <button type="button" class="btn btn-ghost" onclick={resetEditor} disabled={editorBusy}>
            Reset view
          </button>
        </div>
      </div>

      {#if editorStatus}
        <p class="mt-3 text-sm text-base-content/70" aria-live="polite">{editorStatus}</p>
      {/if}

      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={closeThumbnailEditor}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          onclick={saveThumbnailEditor}
          disabled={!editorBlob || editorBusy}
        >
          Save thumbnail
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>Close</button>
    </form>
  </dialog>
</main>
