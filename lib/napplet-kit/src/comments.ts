/**
 * Shared NIP-22 (`kind:1111`) comment helpers for printables and files.
 *
 * Tag construction and tag reading are Applesauce's job: `CommentFactory` builds the
 * root/parent tag pairs and `getCommentReplyPointer` reads them back. This module makes no
 * SDK calls: events in, view models and unsigned templates out. The shell still owns
 * signing and relay routing through NAP-OUTBOX.
 */

import type { EventTemplate, NostrEvent, NostrFilter } from '@napplet/sdk';
import { CommentFactory } from 'applesauce-common/factories/comment';
import {
  COMMENT_KIND,
  getCommentReplyPointer,
  isCommentEventPointer,
  isValidComment,
} from 'applesauce-common/helpers/comment';
import { getReplaceableAddress } from 'applesauce-core/helpers/event';

export { COMMENT_KIND };

/** One comment, reduced to what a thread entry needs. */
export type Comment = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  /** Id of the comment being replied to, or '' for a top-level comment. */
  parentId: string;
  /** The source event, kept because Applesauce builds replies from the parent event. */
  event: NostrEvent;
};

/** A comment placed in the thread: `depth` is how far it is indented. */
export type ThreadEntry = Comment & { depth: number };

/** Comments scoped to an addressable/replaceable root, such as `kind:33500`. */
export function addressThreadFilter(address: string): NostrFilter {
  return { kinds: [COMMENT_KIND], '#A': [address] };
}

/** Alias for printable callers. */
export const threadFilter = addressThreadFilter;

/** Comments scoped to a regular-event root, such as a NIP-94 `kind:1063` file event. */
export function eventThreadFilter(event: NostrEvent): NostrFilter {
  const address = getReplaceableAddress(event);
  return address ? addressThreadFilter(address) : { kinds: [COMMENT_KIND], '#E': [event.id] };
}

/** A stable key for resetting/loading a thread when its root changes. */
export function commentScopeKey(event: NostrEvent): string {
  return getReplaceableAddress(event) ?? event.id;
}

/** Converts an event into a comment, or null when it is not one we can thread. */
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
 */
export function buildThread(comments: Iterable<Comment>, maxDepth = 4): ThreadEntry[] {
  const all = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const present = new Set(all.map((comment) => comment.id));

  const children = new Map<string, Comment[]>();
  for (const comment of all) {
    const parent = comment.parentId && present.has(comment.parentId) ? comment.parentId : '';
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

/** Builds the unsigned `kind:1111` template for a new comment. */
export function buildComment(parent: NostrEvent, content: string): Promise<EventTemplate> {
  return CommentFactory.create(parent, content.trim());
}
