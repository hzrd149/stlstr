<script lang="ts">
  import { link } from '@napplet/sdk';
  import { hasDomain } from '@stlstr/napplet-kit/capabilities';
  import MarkdownImage from './MarkdownImage.svelte';
  import Self from './MarkdownInline.svelte';
  import { decodeEntities, safeUrl, type Token } from './markdown';

  /**
   * Inline Markdown tokens: emphasis, code spans, links, images, line breaks.
   *
   * Every branch emits elements and interpolated text. Nothing is built as an HTML string,
   * so untrusted content can never become markup — see `markdown.ts`.
   */

  const { tokens }: { tokens: Token[] } = $props();

  const hasLink = () => hasDomain('link');

  /**
   * Leaving the napplet is the shell's call, not ours. The frame is sandboxed without
   * `allow-popups` or `allow-top-navigation`, so a plain anchor would silently do nothing
   * even if we wanted it to; NAP-LINK is the only working path, and it lets the shell
   * apply its own policy and consent to the destination.
   */
  function open(href: string, label: string): void {
    if (!hasLink()) return;
    void link.open(href, { label: label || href });
  }
</script>

{#each tokens as token, index (index)}
  {#if token.type === 'text'}
    {#if 'tokens' in token && token.tokens?.length}
      <Self tokens={token.tokens} />
    {:else}
      {decodeEntities(token.text ?? token.raw ?? '')}
    {/if}
  {:else if token.type === 'escape'}
    <!-- Already unescaped by the lexer: `\*` arrives as `*`, and is not an entity. -->
    {token.text}
  {:else if token.type === 'strong'}
    <strong class="font-semibold"><Self tokens={token.tokens ?? []} /></strong>
  {:else if token.type === 'em'}
    <em class="italic"><Self tokens={token.tokens ?? []} /></em>
  {:else if token.type === 'del'}
    <del class="line-through"><Self tokens={token.tokens ?? []} /></del>
  {:else if token.type === 'codespan'}
    <!-- Entity references are literal inside code, so no decoding here. -->
    <code class="rounded bg-base-200 px-1 py-0.5 font-mono text-[0.9em]">{token.text}</code>
  {:else if token.type === 'br'}
    <br />
  {:else if token.type === 'link'}
    {@const href = safeUrl(token.href)}
    {#if href && hasLink()}
      <a
        class="link link-primary"
        {href}
        title={token.title ?? undefined}
        onclick={(event) => {
          event.preventDefault();
          open(href, token.text ?? '');
        }}
      >
        <Self tokens={token.tokens ?? []} />
      </a>
    {:else}
      <!-- A refused destination, or a shell with no NAP-LINK: the text still reads. -->
      <Self tokens={token.tokens ?? []} />
    {/if}
  {:else if token.type === 'image'}
    {@const href = safeUrl(token.href)}
    {#if href}
      <MarkdownImage src={href} alt={token.text ?? ''} />
    {:else}
      <span class="text-base-content/60">{token.text}</span>
    {/if}
  {:else if token.type === 'html'}
    <!-- NIP.md: raw HTML is never inserted into the document, only shown as its source. -->
    {token.raw}
  {:else}
    {decodeEntities(token.raw ?? '')}
  {/if}
{/each}
