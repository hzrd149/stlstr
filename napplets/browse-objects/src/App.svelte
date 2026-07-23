<main class="min-h-screen bg-base-100 p-4">
  <div class="join w-full">
    <input
      class="input join-item input-bordered w-full"
      placeholder="Search phone stands, minis, brackets..."
    />
    <button class="btn btn-primary join-item">Search</button>
  </div>

  <section class="mt-4 grid gap-3 md:grid-cols-3" aria-label="Browse preview">
    {#each ['Newest objects', 'Popular tags', 'Featured makers'] as title}
      <article class="grid gap-2">
        <div class="font-medium">{title}</div>
        <div class="skeleton h-32 w-full"></div>
        <p class="text-sm text-base-content/60">Outbox-backed data will fill this panel.</p>
      </article>
    {/each}
  </section>
</main>
