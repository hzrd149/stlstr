<script lang="ts">
  import { outbox, type NostrEvent } from '@napplet/sdk';
  import { getReplaceableAddress } from 'applesauce-core/helpers';
  import {
    buildComment,
    buildThread,
    collectComment,
    threadFilter,
    toComment,
    type Comment,
  } from './comments';
  import { fetchMakers, type MakerProfile } from './profiles';

  /**
   * The NIP-22 comment thread for one printable object.
   *
   * Reads and writes both go through NAP-OUTBOX: the shell owns relay routing and signing,
   * so this component never learns which relays a comment came from or went to. Composing
   * is gated on NAP-IDENTITY reporting a signed-in viewer, because an unsigned publish
   * would only fail at the shell boundary.
   */

  const {
    object,
    viewer,
  }: {
    /**
     * The object event itself, not just its address: applesauce derives a comment's whole
     * root scope from the parent event. Null until the object loads.
     */
    object: NostrEvent | null;
    viewer: string;
  } = $props();

  /** The root scope every comment in this thread points at. */
  const address = $derived(object ? (getReplaceableAddress(object) ?? '') : '');

  /** Relays holding no thread never send a closing signal, so the empty state needs a deadline. */
  const LOAD_DEADLINE_MS = 6000;

  /** Names are looked up in batches so a fast-streaming thread does not fan out per comment. */
  const NAME_LOOKUP_DELAY_MS = 300;

  let comments = $state(new Map<string, Comment>());
  let authors = $state(new Map<string, MakerProfile>());
  let loading = $state(false);
  let status = $state('');

  let draft = $state('');
  // Raw for the same reason as the object event: applesauce memoizes onto `.event` with
  // symbol properties, which a deep `$state` proxy turns into reactive writes.
  let replyTo = $state.raw<Comment | null>(null);
  /** The inline reply composer's own draft, kept apart from the top-level one. */
  let replyDraft = $state('');
  let publishing = $state(false);

  const thread = $derived(buildThread(comments.values()));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutbox = () => typeof napplets().outbox === 'object';

  function authorName(pubkey: string): string {
    return authors.get(pubkey)?.name || 'Unknown maker';
  }

  function initial(pubkey: string): string {
    const name = authors.get(pubkey)?.name;
    return name ? name.slice(0, 1).toUpperCase() : '?';
  }

  /** Coarse and relative on purpose — an exact timestamp is protocol detail, not product UX. */
  function when(createdAt: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(createdAt * 1000).toLocaleDateString();
  }

  // ---------------------------------------------------------------- author names

  let pendingAuthors = new Set<string>();
  let nameTimer = 0;

  function scheduleNameLookup(pubkey: string): void {
    if (authors.has(pubkey) || pendingAuthors.has(pubkey)) return;
    pendingAuthors.add(pubkey);

    window.clearTimeout(nameTimer);
    nameTimer = window.setTimeout(() => {
      const batch = [...pendingAuthors];
      pendingAuthors = new Set();
      void fetchMakers(batch).then((resolved) => {
        const next = new Map(authors);
        for (const maker of resolved) next.set(maker.pubkey, maker);
        authors = next;
      });
    }, NAME_LOOKUP_DELAY_MS);
  }

  // ---------------------------------------------------------------- the thread

  function ingest(event: Parameters<typeof toComment>[0]): void {
    const comment = toComment(event);
    if (!comment) return;

    const merged = collectComment(comments, comment);
    if (merged === comments) return;

    comments = merged;
    loading = false;
    scheduleNameLookup(comment.pubkey);
  }

  /**
   * Re-opened whenever the object address changes, and torn down by the same effect, so two
   * threads never stream into one list.
   */
  $effect(() => {
    const scope = address;
    const author = object?.pubkey ?? '';

    comments = new Map();
    replyTo = null;
    status = '';
    loading = false;

    if (!scope) return;

    if (!hasOutbox()) {
      status = 'This shell does not provide relay access, so comments cannot be shown.';
      return;
    }

    loading = true;

    // A root-scope filter names no authors, so the shell has nothing to route on by
    // itself. The hint points it at the object author's relays instead of the app's
    // fallback set — the thread lives where the object was published.
    const subscription = outbox.subscribe([threadFilter(scope)], { authors: [author] });
    subscription.on('event', (result) => ingest(result.event));
    subscription.on('closed', (reason) => {
      loading = false;
      if (reason) status = 'The connection to the relays dropped. Reload to see new comments.';
    });

    const deadline = window.setTimeout(() => {
      loading = false;
    }, LOAD_DEADLINE_MS);

    return () => {
      window.clearTimeout(deadline);
      window.clearTimeout(nameTimer);
      subscription.close();
    };
  });

  // ---------------------------------------------------------------- composing

  /** Opens the inline composer under one comment, closing whichever was open before. */
  function startReply(comment: Comment): void {
    replyTo = comment;
    replyDraft = '';
    status = '';
  }

  function cancelReply(): void {
    replyTo = null;
    replyDraft = '';
  }

  /**
   * Publishes one comment. The parent is the object for a top-level comment and the comment
   * being answered for a reply; applesauce reads the root scope off whichever it is given.
   *
   * Returns whether it published, so each composer can clear only its own draft.
   */
  async function publish(parent: NostrEvent, content: string): Promise<boolean> {
    const body = content.trim();
    if (!body || publishing) return false;

    publishing = true;
    status = '';

    try {
      const template = await buildComment(parent, body);
      const result = await outbox.publish(template);

      if (!result.ok || !result.event) {
        status = result.error ?? 'Your comment could not be published.';
        return false;
      }

      // Show it immediately rather than waiting for it to come back off a relay.
      ingest(result.event);
      return true;
    } catch (error) {
      status = error instanceof Error ? error.message : 'Your comment could not be published.';
      return false;
    } finally {
      publishing = false;
    }
  }

  async function publishComment(): Promise<void> {
    if (!object) return;
    if (await publish(object, draft)) draft = '';
  }

  async function publishReply(): Promise<void> {
    if (!replyTo) return;
    if (await publish(replyTo.event, replyDraft)) cancelReply();
  }
</script>

<!-- No heading of its own: the tab this sits in already names it. -->
<section class="grid gap-3" aria-label="Comments" data-testid="object-comments">
  {#if viewer}
    <div class="grid gap-2">
      <textarea
        class="textarea w-full"
        rows="3"
        placeholder="Share a print, a tip, or a question..."
        aria-label="Write a comment"
        data-testid="comment-draft"
        bind:value={draft}
        disabled={publishing}
      ></textarea>

      <button
        type="button"
        class="btn btn-primary w-fit"
        data-testid="publish-comment"
        disabled={publishing || draft.trim().length === 0 || !object}
        onclick={publishComment}
      >
        {publishing ? 'Posting...' : 'Post comment'}
      </button>
    </div>
  {:else}
    <p class="text-sm text-base-content/60" data-testid="comment-signed-out">
      Sign in to join the conversation.
    </p>
  {/if}

  {#if loading && thread.length === 0}
    <div class="grid gap-3" aria-label="Loading comments">
      {#each [0, 1] as placeholder (placeholder)}
        <div class="grid gap-2">
          <div class="skeleton h-4 w-1/3"></div>
          <div class="skeleton h-3 w-full"></div>
        </div>
      {/each}
    </div>
  {:else if thread.length === 0}
    <p class="text-sm text-base-content/70" data-testid="comments-empty">
      No comments yet. Be the first to share how this printed.
    </p>
  {:else}
    <ul class="grid gap-3" data-testid="comment-list">
      {#each thread as comment (comment.id)}
        <li
          class="grid gap-1"
          style="margin-left: {comment.depth * 1.5}rem"
          data-testid="comment"
          data-depth={comment.depth}
        >
          <div class="flex items-baseline gap-2">
            <div class="avatar placeholder shrink-0">
              <div class="h-6 w-6 rounded-full bg-neutral text-neutral-content">
                <span class="text-xs">{initial(comment.pubkey)}</span>
              </div>
            </div>
            <span class="text-sm font-medium" data-testid="comment-author">
              {authorName(comment.pubkey)}
            </span>
            <span class="text-xs text-base-content/60">{when(comment.createdAt)}</span>
          </div>

          <p class="whitespace-pre-wrap text-sm text-base-content/80" data-testid="comment-body">
            {comment.content}
          </p>

          {#if viewer && replyTo?.id !== comment.id}
            <button
              type="button"
              class="link w-fit text-xs text-base-content/60"
              data-testid="reply-to-comment"
              onclick={() => startReply(comment)}
            >
              Reply
            </button>
          {/if}

          {#if viewer && replyTo?.id === comment.id}
            <!-- The composer opens in place, under the comment being answered. -->
            <div class="grid gap-2 pt-1" data-testid="reply-composer">
              <textarea
                class="textarea w-full"
                rows="2"
                placeholder="Write a reply..."
                aria-label="Reply to {authorName(comment.pubkey)}"
                data-testid="reply-draft"
                bind:value={replyDraft}
                disabled={publishing}
              ></textarea>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  data-testid="publish-reply"
                  disabled={publishing || replyDraft.trim().length === 0}
                  onclick={publishReply}
                >
                  {publishing ? 'Posting...' : 'Post reply'}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="cancel-reply"
                  disabled={publishing}
                  onclick={cancelReply}
                >
                  Cancel
                </button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if status}
    <p class="text-sm text-base-content/60" aria-live="polite" data-testid="comment-status">
      {status}
    </p>
  {/if}
</section>
