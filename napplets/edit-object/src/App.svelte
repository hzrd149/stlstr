<script lang="ts">
  import {
    identity,
    inc,
    intent,
    outbox,
    storage,
    type NostrEvent,
    type NostrTag,
  } from '@napplet/sdk';
  import { onMount } from 'svelte';

  /**
   * Edit one printable object (`kind:33500`).
   *
   * The address arrives over the NAP-INTENT delivery seam as a targeted `inc.event` on
   * `edit-object:edit`. Subscribe FIRST, then emit `edit-object:ready`.
   *
   * Ownership is decided by NAP-IDENTITY and nothing else. The address in the payload is
   * untrusted — it crossed a sandbox boundary, and anyone can type any URL — so the owner
   * is taken from the loaded event's author and compared against the signed-in user. The
   * gate has to be right before replacement publishing exists, because publishing a
   * replacement is what would overwrite someone else's object.
   */

  const OPEN_TOPIC = 'edit-object:edit';
  const READY_TOPIC = 'edit-object:ready';
  const DRAFT_PREFIX = 'edit-object:draft:v1:';
  const CUSTOM_LICENSE = '__custom';
  const MUTABLE_TAGS = new Set(['d', 'title', 'summary', 'published_at', 'license', 'i', 't']);
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
  let owner = $state('');
  let address = $state('');
  let identifier = $state('');
  let viewer = $state('');
  let status = $state('Waiting for an object to open...');
  let busy = $state(false);
  let loaded = $state(false);
  let publishedAddress = $state('');
  let originalEvent = $state.raw<NostrEvent | null>(null);
  let preservedTags = $state.raw<NostrTag[]>([]);
  let draftLoaded = $state(false);

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

  function tagValue(tags: string[][], name: string): string {
    return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
  }

  function tagValues(tags: string[][], name: string): string[] {
    return tags
      .filter((tag) => tag[0] === name && tag[1])
      .map((tag) => tag[1].trim())
      .filter(Boolean);
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
      JSON.stringify({ title, summary, description, license, customLicense, tagsText, sourceUrl }),
    );
    status = 'Saved this edit draft.';
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
      }>;
      title = draft.title ?? title;
      summary = draft.summary ?? summary;
      description = draft.description ?? description;
      license = draft.license ?? license;
      customLicense =
        draft.customLicense ?? !LICENSE_OPTIONS.some((option) => option.id === license);
      tagsText = draft.tagsText ?? tagsText;
      sourceUrl = draft.sourceUrl ?? sourceUrl;
      draftLoaded = true;
      status = 'Loaded a saved edit draft.';
    } catch {
      status = 'Loaded the object, but the saved draft could not be read.';
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

    status = 'Loading object...';
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
        status = 'This object has not been published to the relays we can reach.';
        return;
      }

      title = tagValue(newest.tags, 'title') || requestedIdentifier;
      summary = tagValue(newest.tags, 'summary');
      license = tagValue(newest.tags, 'license');
      customLicense = Boolean(license && !LICENSE_OPTIONS.some((option) => option.id === license));
      tagsText = tagValues(newest.tags, 't').join(', ');
      sourceUrl = tagValue(newest.tags, 'i');
      description = newest.content;
      // The event's author is the owner — never the pubkey the payload asked for.
      owner = newest.pubkey;
      identifier = requestedIdentifier;
      address = `33500:${newest.pubkey}:${requestedIdentifier}`;
      originalEvent = newest;
      preservedTags = newest.tags.filter((tag) => !MUTABLE_TAGS.has(tag[0])) as NostrTag[];
      loaded = true;
      status = '';
      await loadDraft();
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this object.';
    }
  }

  function applyIntent(payload: unknown): void {
    const requested = (payload as { address?: unknown } | undefined)?.address;
    if (typeof requested !== 'string' || requested.length === 0) {
      status = 'The shell opened this page without an object to edit.';
      return;
    }
    void loadObject(requested);
  }

  /** Sends someone who cannot edit back to the page they can use. */
  async function viewObject(): Promise<void> {
    if (!address || !hasIntent()) return;
    await intent.open('object-detail', { address });
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

    busy = true;
    publishedAddress = '';
    status = 'Publishing replacement object...';

    try {
      const published = await outbox.publish({
        kind: 33500,
        content: nextDescription,
        tags: buildReplacementTags(),
        created_at: Math.floor(Date.now() / 1000),
      });

      if (!published.ok || !published.event) {
        throw new Error(published.error ?? 'Failed to publish replacement object.');
      }

      if (published.event.pubkey !== owner) {
        throw new Error('The shell published with a different account than the object owner.');
      }

      originalEvent = published.event;
      preservedTags = published.event.tags.filter((tag) => !MUTABLE_TAGS.has(tag[0])) as NostrTag[];
      publishedAddress = `33500:${published.event.pubkey}:${identifier}`;
      address = publishedAddress;
      status = `Updated ${nextTitle}.`;
      if (hasStorage()) await storage.removeItem(draftKey());
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
      status = 'This shell cannot deliver the object to edit.';
      return () => identitySubscription?.unsubscribe();
    }

    // Subscribe BEFORE signalling readiness — the shell flushes on the ready signal.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      identitySubscription?.unsubscribe();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="grid gap-4">
    {#if loaded && !isOwner}
      <div class="alert alert-warning" data-testid="edit-denied">
        <span>
          {viewer
            ? 'This object belongs to another maker, so it cannot be edited here.'
            : 'Sign in as the maker of this object to edit it.'}
        </span>
      </div>
      {#if hasIntent()}
        <button type="button" class="btn btn-outline w-fit" onclick={viewObject}>
          View this object instead
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
            <input class="input w-full" bind:value={summary} placeholder="A short object tagline" />
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

        <div class="rounded-box bg-base-200 p-3 text-sm text-base-content/70">
          Existing images, file references, remixes, and other non-edit metadata are preserved in
          this version. Image and file management is the next build step.
        </div>

        {#if publishedAddress}
          <div class="alert alert-success">
            <span>Published the replacement event.</span>
            {#if hasIntent()}
              <button type="button" class="btn btn-outline btn-sm" onclick={viewObject}>
                Open object
              </button>
            {/if}
          </div>
        {/if}

        <footer class="flex flex-col gap-3 pt-2 md:flex-row md:items-center md:justify-between">
          <p class="text-sm text-base-content/70">
            This keeps the same object address: 33500:&lt;maker&gt;:{identifier}
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-outline" onclick={saveDraft} disabled={busy}>
              Save draft
            </button>
            <button
              type="button"
              class="btn btn-primary"
              onclick={publishReplacement}
              disabled={busy}
            >
              {busy ? 'Publishing...' : 'Publish update'}
            </button>
          </div>
        </footer>
      </form>
    {/if}
  </section>
</main>
