<script lang="ts">
  import { intent } from '@napplet/sdk';
  import { makerDisplayName, makerInitial, type MakerProfile } from '../profiles';

  const {
    pubkey,
    profile,
    testId = 'maker-link',
    labelClass = 'truncate text-sm font-medium group-hover:underline',
    avatarClass = 'h-6 w-6 rounded-full bg-neutral text-neutral-content',
    initialClass = 'text-xs',
    fallbackClass = 'flex min-w-0 items-center gap-2',
    buttonClass = 'group flex min-w-0 items-center gap-2 rounded-field text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
    onError,
  }: {
    pubkey: string;
    profile?: MakerProfile;
    testId?: string;
    labelClass?: string;
    avatarClass?: string;
    initialClass?: string;
    fallbackClass?: string;
    buttonClass?: string;
    onError?: (message: string) => void;
  } = $props();

  const name = $derived(makerDisplayName(profile));
  const initial = $derived(makerInitial(profile));
  const fallbackLabelClass = $derived(labelClass.replace(' group-hover:underline', ''));

  function napplets(): Record<string, unknown> {
    return ((window as Window & { napplet?: Record<string, unknown> }).napplet ?? {}) as Record<
      string,
      unknown
    >;
  }

  const canOpenProfile = () => {
    const domain = napplets().intent as { open?: unknown } | undefined;
    return typeof domain?.open === 'function';
  };

  async function openProfile(): Promise<void> {
    if (!pubkey || !canOpenProfile()) return;
    const result = await intent.open('profile', { pubkey });
    if (!result.ok) onError?.(result.error ?? 'Could not open this maker profile.');
  }
</script>

{#if canOpenProfile()}
  <button
    type="button"
    class={buttonClass}
    data-testid={testId}
    data-pubkey={pubkey}
    aria-label="Open {name} profile"
    onclick={openProfile}
  >
    <span class="avatar placeholder shrink-0">
      <span class={avatarClass}>
        <span class={initialClass}>{initial}</span>
      </span>
    </span>
    <span class={labelClass}>{name}</span>
  </button>
{:else}
  <span class={fallbackClass} data-testid={testId} data-pubkey={pubkey}>
    <span class="avatar placeholder shrink-0">
      <span class={avatarClass}>
        <span class={initialClass}>{initial}</span>
      </span>
    </span>
    <span class={fallbackLabelClass}>{name}</span>
  </span>
{/if}
