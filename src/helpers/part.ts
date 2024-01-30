import { NDKKind, NDKEvent, type NostrEvent } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";
import type { SatelliteCDNUpload } from "../services/satellite-cdn";
import { ndk } from "../services/ndk";
import dayjs from "dayjs";

export function getPartThumbnail(thing: NDKEvent | NostrEvent) {
  return thing.tags.find((t) => t[0] === "thumb")?.[1];
}

export function getPartNevent(thing: NDKEvent) {
  return nip19.neventEncode({
    id: thing.id,
    author: thing.author.pubkey,
    kind: thing.kind,
  });
}

export function buildPartEventFromUpload(res: SatelliteCDNUpload, thumbnailURL?: string){
  const event = new NDKEvent(ndk);
  event.kind = NDKKind.Media;
  event.content = "";
  event.created_at = dayjs().unix();
  event.tags.push(["name", res.name]);
  event.tags.push(["url", res.url]);
  event.tags.push(["m", res.type]);
  event.tags.push(["x", res.sha256]);
  event.tags.push(["size", String(res.size)]);
  event.tags.push(["magnet", res.magnet]);
  event.tags.push(["i", res.infohash]);
  if (thumbnailURL) event.tags.push(["thumb", thumbnailURL]);
  event.tags.push(["alt", "3D Printing model"]);
  return event;
}
