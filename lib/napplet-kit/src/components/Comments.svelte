<script lang="ts">
  import { outbox, type NostrEvent } from '@napplet/sdk';
  import MakerLink from './MakerLink.svelte';
  import { fetchMakers, type MakerProfile } from '../profiles';
  import {
    buildComment,
    buildThread,
    collectComment,
    commentScopeKey,
    eventThreadFilter,
    toComment,
    type Comment,
  } from '../comments';

  /**
   * The NIP-22 comment thread for one printable root event.
   *
   * Reads and writes both go through NAP-OUTBOX: the shell owns relay routing and signing,
   * so this component never learns which relays a comment came from or went to. Composing
   * is gated on NAP-IDENTITY reporting a signed-in viewer, because an unsigned publish
   * would only fail at the shell boundary.
   */

  const {
    object,
    viewer,
    active,
    onCommentPublished,
    placeholder = 'Share a print, a tip, or a question...',
    emptyText = 'No comments yet. Be the first to share how this printed.',
  }: {
    /** The event being discussed: a printable object, a NIP-94 file, a make, etc. */
    object: NostrEvent | null;
    viewer: string;
    active: boolean;
    onCommentPublished?: () => void;
    placeholder?: string;
    emptyText?: string;
  } = $props();

  /** Relays holding no thread never send a closing signal, so the empty state needs a deadline. */
  const LOAD_DEADLINE_MS = 6000;

  /** Names are looked up in batches so a fast-streaming thread does not fan out per comment. */
  const NAME_LOOKUP_DELAY_MS = 300;

  let comments = $state(new Map<string, Comment>());
  let authors = $state(new Map<string, MakerProfile>());
  let loading = $state(false);
  let status = $state('');

  let draft = $state('');
  // Raw because Applesauce memoizes onto `.event` with symbol properties, which a deep
  // `$state` proxy turns into reactive writes.
  let replyTo = $state.raw<Comment | null>(null);
  let replyDraft = $state('');
  let publishing = $state(false);
  let loadedScope = '';

  const thread = $derived(buildThread(comments.values()));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const hasOutboxSubscribe = () => {
    const domain = napplets().outbox as { subscribe?: unknown } | undefined;
    return typeof domain?.subscribe === 'function';
  };
  const hasOutboxPublish = () => {
    const domain = napplets().outbox as { publish?: unknown } | undefined;
    return typeof domain?.publish === 'function';
  };
  function authorName(pubkey: string): string {
    return authors.get(pubkey)?.name || 'Unknown maker';
  }

  /** Coarse and relative on purpose: an exact timestamp is protocol detail, not product UX. */
  function when(createdAt: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(createdAt * 1000).toLocaleDateString();
  }

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

  function ingest(event: Parameters<typeof toComment>[0]): void {
    const comment = toComment(event);
    if (!comment) return;

    const merged = collectComment(comments, comment);
    if (merged === comments) return;

    comments = merged;
    loading = false;
    scheduleNameLookup(comment.pubkey);
  }

  $effect(() => {
    const root = object;
    const scope = root ? commentScopeKey(root) : '';
    const author = root?.pubkey ?? '';
    const shouldLoad = active;

    if (scope !== loadedScope) {
      loadedScope = scope;
      comments = new Map();
      replyTo = null;
      replyDraft = '';
      status = '';
      loading = false;
    }

    if (!root || !scope) return;
    if (!shouldLoad) return;

    if (!hasOutboxSubscribe()) {
      status = 'This shell does not provide relay access, so comments cannot be shown.';
      return;
    }

    loading = true;

    const subscription = outbox.subscribe([eventThreadFilter(root)], { authors: [author] });
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

  function startReply(comment: Comment): void {
    replyTo = comment;
    replyDraft = '';
    status = '';
  }

  function cancelReply(): void {
    replyTo = null;
    replyDraft = '';
  }

  async function publish(parent: NostrEvent, content: string): Promise<boolean> {
    const body = content.trim();
    if (!body || publishing) return false;

    if (!hasOutboxPublish()) {
      status = 'This shell does not provide publishing access.';
      return false;
    }

    publishing = true;
    status = '';

    try {
      const template = await buildComment(parent, body);
      const result = await outbox.publish(template);

      if (!result.ok || !result.event) {
        status = result.error ?? 'Your comment could not be published.';
        return false;
      }

      ingest(result.event);
      onCommentPublished?.();
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

<section class="grid gap-3" aria-label="Comments" data-testid="object-comments">
  {#if viewer}
    <div class="grid gap-2">
      <textarea
        class="textarea w-full"
        rows="3"
        {placeholder}
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
      {#each [0, 1] as placeholderRow (placeholderRow)}
        <div class="grid gap-2">
          <div class="skeleton h-4 w-1/3"></div>
          <div class="skeleton h-3 w-full"></div>
        </div>
      {/each}
    </div>
  {:else if thread.length === 0}
    <p class="text-sm text-base-content/70" data-testid="comments-empty">{emptyText}</p>
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
            <MakerLink
              pubkey={comment.pubkey}
              profile={authors.get(comment.pubkey)}
              testId="comment-author"
              onError={(message) => (status = message)}
            />
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
