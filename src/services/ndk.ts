import NDKSvelte from "@nostr-dev-kit/ndk-svelte";
import NDKCacheAdapterDexie from "@nostr-dev-kit/ndk-cache-dexie";

const cacheAdapter = new NDKCacheAdapterDexie({ dbName: "ndk-cache" });

export const ndk = new NDKSvelte({
  explicitRelayUrls: ["wss://stl-str.nostr1.com/"],
  cacheAdapter,
});

ndk.connect();

if (import.meta.env.DEV) {
  //@ts-ignore
  window.ndk = ndk;
}
