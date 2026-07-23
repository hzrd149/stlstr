<script lang="ts">
  import MarkdownBlocks from './MarkdownBlocks.svelte';
  import { parseMarkdown } from './markdown';

  /**
   * Renders a NIP.md Markdown body.
   *
   * The whole path from source to DOM is token-based — no HTML string is ever produced, so
   * there is nothing to sanitize. See `markdown.ts` for the reasoning and the URL policy.
   */

  const { source }: { source: string } = $props();

  const tokens = $derived(parseMarkdown(source));
</script>

<div class="grid max-w-prose gap-3 text-base-content/90" data-testid="object-description">
  <MarkdownBlocks {tokens} />
</div>
