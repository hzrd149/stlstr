<script lang="ts">
  import type { NDKEvent } from "@nostr-dev-kit/ndk";
  import { Button, Card } from "flowbite-svelte";
  import { getPartNevent, getPartThumbnail } from "../helpers/part";
  import { getTagValue } from "../helpers/event";
  import UserLink from "./UserLink.svelte";
  import Timestamp from "./Timestamp.svelte";
  export let part: NDKEvent;
</script>

<Card
  img={getPartThumbnail(part)}
  size="xs"
  class="max-w-60"
  href={`#/part/${getPartNevent(part)}`}
>
  <div class="overflow-hidden">
    <h4 class="truncate text-md font-bold text-black dark:text-white">
      {getTagValue(part, "name")}
    </h4>
    <UserLink user={part.author} />
    <Timestamp timestamp={part.created_at} />
  </div>
</Card>
