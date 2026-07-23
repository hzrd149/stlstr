<script lang="ts">
  import MarkdownInline from './MarkdownInline.svelte';
  import Self from './MarkdownBlocks.svelte';
  import { decodeEntities, type Token, type Tokens } from '../markdown';

  /**
   * Block-level Markdown tokens. Recurses into itself for the containers (block quotes and
   * list items) and hands leaf content to `MarkdownInline`.
   *
   * DaisyUI has no prose plugin, so block spacing is set here rather than inherited from a
   * typography stylesheet; `Markdown.svelte` owns the outer rhythm.
   */

  const { tokens }: { tokens: Token[] } = $props();

  const HEADING_CLASSES = [
    'text-2xl font-bold',
    'text-xl font-bold',
    'text-lg font-semibold',
    'text-base font-semibold',
    'text-sm font-semibold',
    'text-sm font-semibold uppercase tracking-wide',
  ];

  function alignmentClass(align: 'center' | 'left' | 'right' | null): string {
    if (align === 'center') return 'text-center';
    if (align === 'right') return 'text-right';
    return 'text-left';
  }
</script>

{#each tokens as token, index (index)}
  {#if token.type === 'space'}
    <!-- Blank lines between blocks; the layout already spaces them. -->
  {:else if token.type === 'heading'}
    {@const level = Math.min(Math.max(token.depth, 1), 6)}
    <!-- svelte-ignore element_invalid_self_closing_tag -->
    <svelte:element this={`h${level}`} class={HEADING_CLASSES[level - 1]}>
      <MarkdownInline tokens={token.tokens ?? []} />
    </svelte:element>
  {:else if token.type === 'paragraph'}
    <p><MarkdownInline tokens={token.tokens ?? []} /></p>
  {:else if token.type === 'text'}
    <!-- Tight list items and similar: block position, inline content. -->
    {#if 'tokens' in token && token.tokens?.length}
      <MarkdownInline tokens={token.tokens} />
    {:else}
      {decodeEntities(token.text ?? '')}
    {/if}
  {:else if token.type === 'code'}
    <!-- Entity references are literal inside code, so `token.text` is used verbatim. -->
    <pre class="overflow-x-auto rounded-box bg-base-200 p-3 text-sm"><code class="font-mono"
        >{token.text}</code
      ></pre>
  {:else if token.type === 'blockquote'}
    <blockquote class="grid gap-2 border-l-4 border-base-300 pl-4 text-base-content/80">
      <Self tokens={token.tokens ?? []} />
    </blockquote>
  {:else if token.type === 'hr'}
    <hr class="border-base-300" />
  {:else if token.type === 'list'}
    {@const list = token as Tokens.List}
    <svelte:element
      this={list.ordered ? 'ol' : 'ul'}
      class="grid gap-1 pl-6 {list.ordered ? 'list-decimal' : 'list-disc'}"
      start={list.ordered && Number(list.start) > 1 ? Number(list.start) : undefined}
    >
      {#each list.items as item, itemIndex (itemIndex)}
        <!-- A task list item is not a bullet; the checkbox replaces the marker. -->
        <li class={item.task ? 'ml-[-1.5rem] flex list-none items-start gap-2' : ''}>
          {#if item.task}
            <input
              type="checkbox"
              class="checkbox checkbox-sm mt-0.5"
              checked={item.checked}
              disabled
              aria-label="Task"
            />
            <span class="grid gap-1">
              <Self tokens={item.tokens.filter((child) => child.type !== 'checkbox')} />
            </span>
          {:else}
            <Self tokens={item.tokens} />
          {/if}
        </li>
      {/each}
    </svelte:element>
  {:else if token.type === 'table'}
    {@const table = token as Tokens.Table}
    <div class="overflow-x-auto">
      <table class="table table-zebra table-sm">
        <thead>
          <tr>
            {#each table.header as cell, cellIndex (cellIndex)}
              <th class={alignmentClass(table.align[cellIndex])}>
                <MarkdownInline tokens={cell.tokens ?? []} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each table.rows as row, rowIndex (rowIndex)}
            <tr>
              {#each row as cell, cellIndex (cellIndex)}
                <td class={alignmentClass(table.align[cellIndex])}>
                  <MarkdownInline tokens={cell.tokens ?? []} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if token.type === 'html'}
    <!-- NIP.md forbids inserting raw HTML. Shown as its own source instead. -->
    <pre class="overflow-x-auto rounded-box bg-base-200 p-3 text-sm text-base-content/70"><code
        class="font-mono">{token.raw}</code
      ></pre>
  {:else if token.type !== 'def'}
    <!-- Anything unrecognised still has to read: fall back to the source text. -->
    <p class="whitespace-pre-wrap">{decodeEntities(token.raw ?? '')}</p>
  {/if}
{/each}
