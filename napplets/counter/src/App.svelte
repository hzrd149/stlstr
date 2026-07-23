<script lang="ts">
  import { onMount } from 'svelte';
  import { storage } from '@napplet/sdk';

  const STORAGE_KEY = 'counter:value';

  let count = $state(0);
  let status = $state('Loading stored count...');
  let busy = $state(true);

  async function loadCount(): Promise<void> {
    busy = true;
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
      count = Number.isFinite(parsed) ? parsed : 0;
      status = raw == null ? 'No stored value yet.' : 'Loaded from NAP-STORAGE.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Failed to load count.';
    } finally {
      busy = false;
    }
  }

  async function saveCount(next: number): Promise<void> {
    busy = true;
    try {
      await storage.setItem(STORAGE_KEY, String(next));
      count = next;
      status = 'Saved with NAP-STORAGE.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Failed to save count.';
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void loadCount();
  });
</script>

<main class="min-h-screen bg-base-100 p-4">
  <div class="grid max-w-sm gap-3">
    <output aria-live="polite" class="stat-value text-primary">{count}</output>

    <div class="join">
      <button
        class="btn join-item"
        type="button"
        onclick={() => saveCount(count - 1)}
        disabled={busy}
      >
        Decrement
      </button>
      <button
        class="btn btn-primary join-item"
        type="button"
        onclick={() => saveCount(count + 1)}
        disabled={busy}
      >
        Increment
      </button>
    </div>

    <button
      class="btn btn-ghost"
      type="button"
      onclick={() => saveCount(0)}
      disabled={busy || count === 0}
    >
      Reset stored value
    </button>

    <p class="text-sm text-base-content/60">{status}</p>
  </div>
</main>
