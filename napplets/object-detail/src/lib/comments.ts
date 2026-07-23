/**
 * NIP-22 (`kind:1111`) comments scoped to a printable object.
 *
 * Tag construction and tag reading are applesauce's job, not ours: `CommentFactory` builds
 * the root/parent tag pairs and `getCommentReplyPointer` reads them back, so the uppercase
 * root scope and lowercase parent scope stay correct for both top-level comments (parent is
 * the `kind:33500` object) and replies (parent is another comment).
 *
 * This module makes no SDK calls — events in, view models and unsigned templates out. The
 * shell still owns signing and relay routing through NAP-OUTBOX.
 */

import {
  COMMENT_KIND,
  getCommentReplyPointer,
  isCommentEventPointer,
  isValidComment,
} from 'applesauce-common/helpers';
import { CommentFactory } from 'applesauce-common/factories';
import type { EventTemplate, NostrEvent, NostrFilter } from '@napplet/sdk';

export { COMMENT_KIND };

/** One comment, reduced to what a thread entry needs. */
export type Comment = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  /** Id of the comment being replied to, or '' for a comment on the object itself. */
  parentId: string;
  /** The source event, kept because applesauce builds replies from the parent event. */
  event: NostrEvent;
};

/** A comment placed in the thread: `depth` is how far it is indented. */
export type ThreadEntry = Comment & { depth: number };

/**
 * Every comment in the thread — top level and replies alike — carries the object address as
 * its uppercase root scope, so one filter returns the whole thread.
 */
export function threadFilter(address: string): NostrFilter {
  return { kinds: [COMMENT_KIND], '#A': [address] };
}

/**
 * Converts an event into a comment, or null when it is not one we can thread.
 *
 * The parent comes from applesauce's reply pointer: an event pointer at `kind:1111` means
 * the parent is another comment. Anything else — an address pointer back at the object — is
 * a comment on the object itself.
 */
export function toComment(event: NostrEvent): Comment | null {
  const content = event.content.trim();
  if (!content || !isValidComment(event)) return null;

  const parent = getCommentReplyPointer(event);
  const parentId =
    parent && isCommentEventPointer(parent) && parent.kind === COMMENT_KIND ? parent.id : '';

  return {
    id: event.id,
    pubkey: event.pubkey,
    content,
    createdAt: event.created_at,
    parentId,
    event,
  };
}

/** Folds a comment into an id-keyed collection. Comments are regular events, so id is enough. */
export function collectComment(known: Map<string, Comment>, next: Comment): Map<string, Comment> {
  if (known.has(next.id)) return known;

  // A new Map identity is what makes Svelte's `$state` see the change.
  const merged = new Map(known);
  merged.set(next.id, next);
  return merged;
}

/**
 * Orders a flat set of comments into a depth-tagged reading order: oldest first at each
 * level, with each comment's replies directly beneath it.
 *
 * A reply whose parent never arrives is promoted to the top level rather than dropped —
 * relays return what they hold, and a visible orphan beats a silently missing comment.
 */
export function buildThread(comments: Iterable<Comment>, maxDepth = 4): ThreadEntry[] {
  const all = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const present = new Set(all.map((comment) => comment.id));

  const children = new Map<string, Comment[]>();
  for (const comment of all) {
    const parent = comment.parentId && present.has(comment.parentId) ? comment.parentId : '';
    // A comment cannot reply to itself; a malformed event must not build a cycle.
    const key = parent === comment.id ? '' : parent;
    const bucket = children.get(key);
    if (bucket) bucket.push(comment);
    else children.set(key, [comment]);
  }

  const thread: ThreadEntry[] = [];

  function walk(parentId: string, depth: number): void {
    for (const comment of children.get(parentId) ?? []) {
      thread.push({ ...comment, depth: Math.min(depth, maxDepth) });
      walk(comment.id, depth + 1);
    }
  }

  walk('', 0);
  return thread;
}

/**
 * Builds the unsigned `kind:1111` template for a new comment.
 *
 * `parent` is the object event for a top-level comment or another comment's event for a
 * reply; applesauce derives the root scope from it either way, which is why the raw parent
 * event is what a caller must hold on to. The factory resolves to a template rather than a
 * signed event — the shell signs it at publish time.
 */
export function buildComment(parent: NostrEvent, content: string): Promise<EventTemplate> {
  return CommentFactory.create(parent, content.trim());
}
