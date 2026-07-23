<script lang="ts">
  import { identity, inc, intent, outbox } from '@napplet/sdk';
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

  let title = $state('');
  let license = $state('');
  let description = $state('');
  let owner = $state('');
  let address = $state('');
  let viewer = $state('');
  let status = $state('Waiting for an object to open...');
  let loaded = $state(false);

  /** An empty viewer means nobody is signed in, so the editor stays closed. */
  const isOwner = $derived(Boolean(viewer && owner && viewer === owner));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => typeof napplets().outbox === 'object';
  const hasInc = () => typeof napplets().inc === 'object';
  const hasIntent = () => typeof napplets().intent === 'object';
  const hasIdentity = () => typeof napplets().identity === 'object';

  function tagValue(tags: string[][], name: string): string {
    return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
  }

  async function loadObject(requested: string): Promise<void> {
    const [kind, pubkey, ...rest] = requested.split(':');
    const identifier = rest.join(':');

    if (kind !== '33500' || !pubkey || !identifier) {
      status = 'The shell opened this page with an address it could not read.';
      return;
    }

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access.';
      return;
    }

    status = 'Loading object...';

    try {
      const { events } = await outbox.query(
        [{ kinds: [33500], authors: [pubkey], '#d': [identifier], limit: 1 }],
        { timeoutMs: 5000 },
      );

      const newest = events
        .map((result) => result.event)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!newest) {
        status = 'This object has not been published to the relays we can reach.';
        return;
      }

      title = tagValue(newest.tags, 'title') || identifier;
      license = tagValue(newest.tags, 'license');
      description = newest.content;
      // The event's author is the owner — never the pubkey the payload asked for.
      owner = newest.pubkey;
      address = `33500:${newest.pubkey}:${identifier}`;
      loaded = true;
      status = '';
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
      <div class="alert alert-info">
        <span>Replacement publishing comes next; these fields are not editable yet.</span>
      </div>

      <div class="grid gap-4 md:grid-cols-2" data-testid="edit-form">
        <label class="fieldset">
          <span class="fieldset-legend">Title</span>
          <input class="input w-full" disabled value={title} />
        </label>
        <label class="fieldset">
          <span class="fieldset-legend">License</span>
          <input class="input w-full" disabled placeholder="CC-BY-4.0" value={license} />
        </label>
        <label class="fieldset md:col-span-2">
          <span class="fieldset-legend">Description</span>
          <textarea class="textarea w-full" disabled value={description}></textarea>
        </label>
      </div>
    {/if}
  </section>
</main>
