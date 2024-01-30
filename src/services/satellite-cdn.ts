import { NDKEvent, NDKKind, type NostrEvent } from "@nostr-dev-kit/ndk";
import dayjs from "dayjs";
import { ndk } from "./ndk";

const ROOT_URL = "https://api.satellite.earth/v1/media";

export type SatelliteCDNUpload = {
  created: number;
  sha256: string;
  name: string;
  url: string;
  infohash: string;
  magnet: string;
  size: number;
  type: string;
  nip94: string[];
};
export type SatelliteCDNFile = {
  created: number;
  magnet: string;
  type: string;
  name: string;
  sha256: string;
  size: number;
  url: string;
};
export type SatelliteCDNAccount = {
  timeRemaining: number;
  paidThrough: number;
  transactions: {
    order: NostrEvent;
    receipt: NostrEvent;
    payment: NostrEvent;
  }[];
  storageTotal: number;
  creditTotal: number;
  usageTotal: number;
  rateFiat: {
    usd: number;
  };
  exchangeFiat: {
    usd: number;
  };
  files: SatelliteCDNFile[];
};

export async function getAccountAuthToken() {
  const event = new NDKEvent(ndk);
  event.kind = 22242;
  event.content = "Authenticate User";
  await event.sign();

  return event.rawEvent();
}

export async function getAccount(authToken: NostrEvent) {
  return fetch(
    `${ROOT_URL}/account?auth=${encodeURIComponent(JSON.stringify(authToken))}`,
  ).then((res) => res.json()) as Promise<SatelliteCDNAccount>;
}

export async function uploadFile(file: File) {
  const event = new NDKEvent(ndk);
  event.created_at = dayjs().unix();
  event.kind = 22242 as NDKKind;
  event.content = "Authorize Upload";
  event.tags.push(["name", file.name]);
  await event.sign();

  const token = encodeURIComponent(JSON.stringify(event.rawEvent()));

  return (await fetch(`${ROOT_URL}/item?auth=${token}`, {
    method: "PUT",
    body: file,
  }).then((res) => res.json())) as Promise<SatelliteCDNUpload>;
}
