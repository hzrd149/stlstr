import type { NDKEvent, NDKKind, NostrEvent } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

export const THING_KIND = 39555 as NDKKind;

export function getThingTitle(thing: NDKEvent | NostrEvent) {
  return thing.tags.find((t) => t[0] === "title")?.[1];
}
export function getThingImage(thing: NDKEvent | NostrEvent) {
  return thing.tags.find((t) => t[0] === "image")?.[1];
}
export function getThingSummary(thing: NDKEvent | NostrEvent) {
  return thing.tags.find((t) => t[0] === "summary")?.[1];
}
export function getThingDateCreated(thing: NDKEvent | NostrEvent) {
  const created = thing.tags.find((t) => t[0] === "created")?.[1];
  return created ? parseInt(created) : thing.created_at!;
}

export function getThingFileIds(thing: NDKEvent | NostrEvent) {
  return thing.tags.filter((t) => t[0] === "e").map((t) => t[1]);
}

export function getThingNaddr(thing: NDKEvent) {
  const d = thing.tags.find((t) => t[0] === "d")?.[1];
  if (!d) throw new Error("missing identifier");
  return nip19.naddrEncode({
    kind: thing.kind!,
    pubkey: thing.author.pubkey,
    identifier: d,
  });
}
