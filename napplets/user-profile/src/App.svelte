<script lang="ts">
  import { inc, outbox, resource } from '@napplet/sdk';
  import { onMount } from 'svelte';

  /**
   * Renders one user's profile (kind 0).
   *
   * The pubkey arrives over the NAP-INTENT delivery seam: NAP-INTENT's SDK surface is
   * outbound only, so the shell hands the payload over as a targeted `inc.event` on
   * `user-profile:open`. The cold-start guard is ordering — subscribe FIRST, then emit
   * `user-profile:ready`, or the shell flushes into a napplet that is not listening yet.
   */

  const OPEN_TOPIC = 'user-profile:open';
  const READY_TOPIC = 'user-profile:ready';

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

  const hasOutbox = () => typeof napplets().outbox === 'object';
  const hasResource = () => typeof napplets().resource === 'object';
  const hasInc = () => typeof napplets().inc === 'object';

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

  /** Cover art and avatars are fetched through NAP-RESOURCE, never a bare <img src>. */
  async function loadPicture(url: string | undefined): Promise<void> {
    revokePicture();
    if (!url || !hasResource()) return;

    try {
      const blob = await resource.bytes(url);
      pictureUrl = URL.createObjectURL(blob);
    } catch {
      // A blocked or broken avatar is not an error worth showing; the initial stands in.
    }
  }

  async function loadProfile(nextPubkey: string): Promise<void> {
    pubkey = nextPubkey;
    profile = null;
    revokePicture();

    if (!hasOutbox()) {
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

  function applyIntent(payload: unknown): void {
    const next = (payload as { pubkey?: unknown } | undefined)?.pubkey;
    if (typeof next !== 'string' || next.length === 0) {
      status = 'The shell opened this page without a maker to show.';
      return;
    }
    void loadProfile(next);
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

    {#if pubkey}
      <!-- Renders only once a maker has been delivered over the intent seam. -->
      <p class="text-sm text-base-content/60" data-testid="profile-scope">
        Objects published by this maker will be listed here.
      </p>
    {/if}
  </section>
</main>
