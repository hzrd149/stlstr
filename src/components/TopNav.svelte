<script lang="ts">
  import {
    Button,
    DarkMode,
    NavBrand,
    NavHamburger,
    NavLi,
    NavUl,
    Navbar,
    Tooltip,
    Avatar,
  } from "flowbite-svelte";
  import logoSrc from "../assets/untitledui-icons/usb-flash-drive.svg";
  import { ndk } from "../services/ndk";
  import { NDKNip07Signer } from "@nostr-dev-kit/ndk";
  import { nip19 } from "nostr-tools";

  let user = ndk.activeUser;
  let profile = ndk.activeUser?.profile ?? null;

  async function loginWithExt() {
    ndk.signer = new NDKNip07Signer();
    await ndk.signer?.blockUntilReady();
    user = await ndk.signer.user();
    profile = await user.fetchProfile();
  }
</script>

<Navbar>
  <NavBrand href="#/">
    <img
      src={logoSrc}
      class="me-3 h-6 dark:text-white sm:h-9"
      alt="Flowbite Logo"
    />
    <span
      class="self-center whitespace-nowrap text-xl font-semibold dark:text-white"
      >STL-str</span
    >
    <Tooltip>Because who needs discoverability</Tooltip>
  </NavBrand>
  <NavHamburger />
  <div class="flex items-center gap-2">
    <NavUl>
      <NavLi href="#/">Things</NavLi>
      <NavLi href="#/parts">Parts</NavLi>
      <NavLi href="#/things/new">Upload</NavLi>
    </NavUl>
    {#if user}
      <a href={`#/user/${user.npub}`}>
        <Avatar src={profile?.image} />
      </a>
    {:else}
      <Button on:click={loginWithExt}>Login</Button>
    {/if}
    <!-- <DarkMode size="sm" /> -->
  </div>
</Navbar>
