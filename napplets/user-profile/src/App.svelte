<script lang="ts">
  import { inc, intent, outbox } from '@napplet/sdk';
  import { onMount } from 'svelte';
  import CoverImage from './lib/CoverImage.svelte';
  import { loadImageUrl } from '@stlstr/napplet-kit/images';
  import {
    collectObject,
    OBJECT_KIND,
    sortByNewest,
    toPrintableObject,
    type PrintableObject,
  } from './lib/objects';

  /**
   * Renders one user's profile (kind 0) and the printable objects they have published.
   *
   * The pubkey arrives over the NAP-INTENT delivery seam: NAP-INTENT's SDK surface is
   * outbound only, so the shell hands the payload over as a targeted `inc.event` on
   * `profile:open`. The cold-start guard is ordering — subscribe FIRST, then emit
   * `profile:ready`, or the shell flushes into a napplet that is not listening yet.
   */

  const OPEN_TOPIC = 'profile:open';
  const READY_TOPIC = 'profile:ready';

  /** How many of the maker's objects to pull. Pagination is a follow-up. */
  const OBJECT_LIMIT = 60;

  /** Relays that hold nothing for this maker never close, so the empty state needs a deadline. */
  const OBJECT_DEADLINE_MS = 6000;

  type ProfileMetadata = {
    name?: string;
    display_name?: string;
    about?: string;
    picture?: string;
    nip05?: string;
    website?: string;
  };

  let pubkey = $state('');
  let profile = $state<ProfileMetadata | null>(null);
  let pictureUrl = $state('');
  let status = $state('Waiting for a profile to open...');
  let loading = $state(false);

  let objects = $state(new Map<string, PrintableObject>());
  let objectsLoading = $state(false);
  let objectsStatus = $state('');

  const published = $derived(sortByNewest(objects.values()));

  const displayName = $derived(
    profile?.display_name?.trim() || profile?.name?.trim() || 'Unnamed maker',
  );
  const initial = $derived(displayName.slice(0, 1).toUpperCase());

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutboxQuery = () => {
    const domain = napplets().outbox as { query?: unknown } | undefined;
    return typeof domain?.query === 'function';
  };
  const hasOutboxSubscribe = () => {
    const domain = napplets().outbox as { subscribe?: unknown } | undefined;
    return typeof domain?.subscribe === 'function';
  };
  const hasIntent = () => {
    const domain = napplets().intent as { open?: unknown } | undefined;
    return typeof domain?.open === 'function';
  };
  const hasInc = () => {
    const domain = napplets().inc as { emit?: unknown; on?: unknown } | undefined;
    return typeof domain?.emit === 'function' && typeof domain?.on === 'function';
  };

  function revokePicture(): void {
    if (!pictureUrl) return;
    URL.revokeObjectURL(pictureUrl);
    pictureUrl = '';
  }

  function parseProfile(content: string): ProfileMetadata | null {
    try {
      const parsed: unknown = JSON.parse(content);
      return parsed && typeof parsed === 'object' ? (parsed as ProfileMetadata) : null;
    } catch {
      return null;
    }
  }

  /** Avatars are fetched through NAP-RESOURCE, never a bare <img src>. */
  async function loadPicture(url: string | undefined): Promise<void> {
    revokePicture();
    if (!url) return;

    // A blocked or broken avatar is not an error worth showing; the initial stands in.
    pictureUrl = await loadImageUrl(url);
  }

  async function loadProfile(nextPubkey: string): Promise<void> {
    profile = null;
    revokePicture();

    if (!hasOutboxQuery()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    loading = true;
    status = 'Loading profile...';

    try {
      const { events } = await outbox.query([{ kinds: [0], authors: [nextPubkey], limit: 1 }], {
        timeoutMs: 4000,
      });

      const newest = events
        .map((result) => result.event)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!newest) {
        status = 'No profile has been published for this maker yet.';
        return;
      }

      profile = parseProfile(newest.content);
      status = profile ? '' : 'This maker published a profile we could not read.';
      await loadPicture(profile?.picture);
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not load this profile.';
    } finally {
      loading = false;
    }
  }

  // ---------------------------------------------------------------- published objects

  /** Torn down when a different maker is opened, so two subscriptions never overlap. */
  let closeObjects: (() => void) | undefined;

  function ingest(event: Parameters<typeof toPrintableObject>[0]): void {
    const object = toPrintableObject(event);
    if (!object) return;

    const merged = collectObject(objects, object);
    if (merged === objects) return;

    objects = merged;
    objectsLoading = false;
  }

  function loadObjects(nextPubkey: string): void {
    closeObjects?.();
    closeObjects = undefined;
    objects = new Map();
    objectsStatus = '';

    if (!hasOutboxSubscribe()) {
      objectsLoading = false;
      objectsStatus = 'This shell does not provide relay access, so prints cannot be listed.';
      return;
    }

    objectsLoading = true;

    const subscription = outbox.subscribe([
      { kinds: [OBJECT_KIND], authors: [nextPubkey], limit: OBJECT_LIMIT },
    ]);
    subscription.on('event', (result) => ingest(result.event));
    subscription.on('closed', (reason) => {
      objectsLoading = false;
      if (reason) objectsStatus = 'The connection to the relays dropped. Reload to try again.';
    });

    const deadline = window.setTimeout(() => {
      objectsLoading = false;
    }, OBJECT_DEADLINE_MS);

    closeObjects = () => {
      window.clearTimeout(deadline);
      subscription.close();
    };
  }

  // ---------------------------------------------------------------- navigation

  /** Hands the object to whichever napplet fulfills the `printable-detail` role. */
  async function openObject(object: PrintableObject): Promise<void> {
    if (!hasIntent()) {
      objectsStatus = 'This shell cannot open prints.';
      return;
    }

    const result = await intent.open('printable-detail', { address: object.address });
    if (!result.ok) objectsStatus = result.error ?? 'Could not open that print.';
  }

  // ---------------------------------------------------------------- lifecycle

  function applyIntent(payload: unknown): void {
    const next = (payload as { pubkey?: unknown } | undefined)?.pubkey;
    if (typeof next !== 'string' || next.length === 0) {
      status = 'The shell opened this page without a maker to show.';
      return;
    }

    pubkey = next;
    void loadProfile(next);
    loadObjects(next);
  }

  onMount(() => {
    if (!hasInc()) {
      status = 'This shell cannot deliver the maker to show.';
      return;
    }

    // Subscribe BEFORE signalling readiness — the shell flushes on the ready signal.
    const subscription = inc.on(OPEN_TOPIC, applyIntent);
    inc.emit(READY_TOPIC, [], '');

    return () => {
      subscription.unsubscribe();
      closeObjects?.();
      revokePicture();
    };
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <section class="grid gap-4" aria-label="Maker profile">
    <div class="flex flex-wrap items-center gap-4">
      <div class="avatar placeholder shrink-0">
        <div class="h-20 w-20 rounded-full bg-primary text-primary-content">
          {#if pictureUrl}
            <img src={pictureUrl} alt="" class="h-20 w-20 rounded-full object-cover" />
          {:else}
            <span class="text-2xl">{profile ? initial : '?'}</span>
          {/if}
        </div>
      </div>

      <div class="min-w-0 grid gap-1">
        <div class="text-2xl font-bold" data-testid="profile-name">
          {profile ? displayName : 'Maker profile'}
        </div>
        {#if profile?.nip05}
          <div class="text-sm text-base-content/70">{profile.nip05}</div>
        {/if}
        {#if profile?.website}
          <div class="text-sm text-base-content/70">{profile.website}</div>
        {/if}
      </div>
    </div>

    {#if loading}
      <div class="skeleton h-24 w-full"></div>
    {:else if profile?.about}
      <p class="max-w-prose whitespace-pre-wrap text-base-content/80">{profile.about}</p>
    {/if}

    {#if status}
      <p class="text-sm text-base-content/60" aria-live="polite" data-testid="profile-status">
        {status}
      </p>
    {/if}
  </section>

  {#if pubkey}
    <!-- Renders only once a maker has been delivered over the intent seam. -->
    <section class="mt-8 grid gap-4" aria-label="Prints by this maker" data-testid="profile-scope">
      <h2 class="text-lg font-semibold">
        Prints by {profile ? displayName : 'this maker'}
      </h2>

      {#if objectsLoading && published.length === 0}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading prints">
          {#each [0, 1, 2] as placeholder (placeholder)}
            <div class="grid gap-2">
              <div class="skeleton aspect-video w-full"></div>
              <div class="skeleton h-4 w-2/3"></div>
            </div>
          {/each}
        </div>
      {:else if published.length === 0}
        <p class="text-base-content/70" data-testid="profile-objects-empty">
          This maker has not published any prints yet.
        </p>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="profile-objects">
          {#each published as object (object.address)}
            <article class="grid content-start gap-2" data-testid="object-result">
              <button
                type="button"
                class="grid gap-2 text-left"
                data-testid="open-object"
                data-address={object.address}
                onclick={() => openObject(object)}
              >
                <CoverImage cover={object.cover} title={object.title} />
                <span class="font-medium" data-testid="object-title">{object.title}</span>
                {#if object.summary}
                  <span class="line-clamp-2 text-sm text-base-content/70">{object.summary}</span>
                {/if}
              </button>
            </article>
          {/each}
        </div>
      {/if}

      {#if objectsStatus}
        <p
          class="text-sm text-base-content/60"
          aria-live="polite"
          data-testid="profile-objects-status"
        >
          {objectsStatus}
        </p>
      {/if}
    </section>
  {/if}
</main>
