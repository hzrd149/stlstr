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

<main class="shell">
  <section class="card" aria-labelledby="counter-title">
    <p class="eyebrow">NAP-STORAGE demo</p>
    <h1 id="counter-title">Counter</h1>
    <output aria-live="polite" class="count">{count}</output>

    <div class="actions">
      <button type="button" onclick={() => saveCount(count - 1)} disabled={busy}>Decrement</button>
      <button type="button" class="primary" onclick={() => saveCount(count + 1)} disabled={busy}>
        Increment
      </button>
    </div>

    <button type="button" class="link" onclick={() => saveCount(0)} disabled={busy || count === 0}>
      Reset stored value
    </button>

    <p class="status">{status}</p>
  </section>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body),
  :global(#app) {
    min-height: 100%;
    margin: 0;
  }

  :global(body) {
    color: #101828;
    background: linear-gradient(135deg, #f8fafc 0%, #eef4ff 100%);
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
  }

  .shell {
    display: grid;
    min-height: 100vh;
    padding: 24px;
    place-items: center;
  }

  .card {
    width: min(100%, 420px);
    padding: 28px;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 28px;
    background: rgba(255, 255, 255, 0.86);
    box-shadow: 0 24px 80px rgba(15, 23, 42, 0.16);
    text-align: center;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #475467;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2rem, 12vw, 4.5rem);
    line-height: 0.95;
  }

  .count {
    display: block;
    margin: 28px 0;
    color: #2563eb;
    font-size: clamp(4rem, 30vw, 8rem);
    font-weight: 800;
    line-height: 0.9;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  button {
    min-height: 46px;
    border: 1px solid rgba(15, 23, 42, 0.14);
    border-radius: 999px;
    background: #ffffff;
    color: #101828;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
  }

  button:hover:not(:disabled) {
    border-color: rgba(37, 99, 235, 0.42);
    box-shadow: 0 8px 24px rgba(37, 99, 235, 0.14);
  }

  button:disabled {
    cursor: progress;
    opacity: 0.54;
  }

  .primary {
    border-color: #2563eb;
    background: #2563eb;
    color: #ffffff;
  }

  .link {
    margin-top: 14px;
    border-color: transparent;
    background: transparent;
    color: #475467;
  }

  .status {
    min-height: 1.5em;
    margin: 16px 0 0;
    color: #475467;
    font-size: 0.92rem;
  }
</style>
