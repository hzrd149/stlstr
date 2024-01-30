import { NDKEvent, type NostrEvent } from "@nostr-dev-kit/ndk";

export function getEventCoordinate(event: NDKEvent) {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (!d) throw new Error("event missing d tag");
  return `${event.kind}:${event.author.pubkey}:${d}`;
}

export function getTagValue(
  event: NDKEvent | NostrEvent,
  name: string,
  require: true,
): string;
export function getTagValue(
  event: NDKEvent | NostrEvent,
  name: string,
): string | undefined;
export function getTagValue(
  event: NDKEvent | NostrEvent,
  name: string,
  require = false,
) {
  const value = event.tags.find((t) => t[0] === name)?.[1];
  if (require && value === undefined) throw new Error(`Missing ${name} tag`);
  return value;
}
