import GithubSlugger from 'github-slugger';
import { visit } from 'unist-util-visit';
import type { Root as MarkdownRoot, Blockquote, RootContent } from 'mdast';
import type { Root as HtmlRoot, Element, Nodes } from 'hast';
import remend from 'remend';

export function streamingMarkdown(text: string) {
  // Only repair the temporary rendering view. Durable and all copy operations
  // retain the model's original text. Math/HTML are deliberately not enabled.
  return remend(text, { katex: false, inlineKatex: false, htmlTags: false });
}

/** Mermaid measures in a temporary DOM node before producing an inert image.
 * Keep that measurement free of external assets and model-provided CSS, too. */
export function diagramSourceError(code: string): string | undefined {
  if (code.length > 30_000) return 'Diagram exceeds the 30,000 character limit. Use the source view.';
  if (/%%\s*\{/.test(code) || code.trimStart().startsWith('---')) return 'Diagram configuration directives are not supported. Use the source view.';
  if (/(?:https?:|file:|data:|blob:|javascript:|vbscript:|ftp:|\/\/|url\s*\(|@import|@\{|<\s*(?:img|image|script|iframe|svg|foreignObject)\b)/i.test(code)
    || /(?:^|[;\n])\s*(?:click|style|classDef|linkStyle)\b/i.test(code)
    || /["']?\b(?:img|icon)["']?\s*:/i.test(code) || /\\/.test(code)) {
    return 'External assets, links and custom styles are not supported in diagrams. Use the source view.';
  }
  return undefined;
}

export function delimitedTable(rows: string[][], separator: ',' | '\t') {
  return rows.map(row => row.map(cell => /["\r\n]/.test(cell) || cell.includes(separator)
    ? `"${cell.replaceAll('"', '""')}"` : cell).join(separator)).join('\n');
}

export function codeFenceClosed(source: string) {
  const lines = source.trimEnd().split('\n');
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? '');
  if (!opening) return true; // indented code has no closing delimiter
  if (lines.length < 2) return false;
  return new RegExp(`^ {0,3}${opening[1]![0]}{${opening[1]!.length},}\\s*$`).test(lines.at(-1)!);
}

// Preserve fence metadata before mdast-to-hast discards it, and mark only
// finished fences as eligible for expensive diagram/diff rendering.
export function remarkReply(options: { streaming: boolean }) {
  return (tree: MarkdownRoot, file: { value: unknown }) => {
    const source = String(file.value);
    visit(tree, 'code', node => {
      const meta = node.meta?.trim() ?? '';
      const filename = /(?:^|\s)(?:file(?:name)?|title)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta);
      const bare = !filename && /^[^\s=]+\.[\w-]+$/.test(meta) ? meta : undefined;
      const name = filename ? filename[1] ?? filename[2] ?? filename[3] : bare;
      const complete = !options.streaming || codeFenceClosed(source.slice(node.position?.start.offset, node.position?.end.offset));
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties,
        dataFilename: name?.slice(0, 1024), dataComplete: String(complete) } };
    });
    visit(tree, 'blockquote', node => {
      const first = node.children[0];
      const text = first?.type === 'paragraph' ? first.children[0] : undefined;
      if (text?.type !== 'text') return;
      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/.exec(text.value);
      if (!match) return;
      text.value = text.value.slice(match[0].length);
      if (!text.value && first?.type === 'paragraph' && first.children.length === 1) node.children.shift();
      node.data = { ...node.data, hProperties: { className: ['markdown-callout'], dataKind: match[1]!.toLowerCase() } };
      node.children.unshift({ type: 'paragraph', data: { hProperties: { className: ['markdown-callout-title'] } },
        children: [{ type: 'text', value: match[1]! }] });
    });
    // A very small HTML allowlist, converted to AST elements rather than raw
    // HTML. No attributes, scripts, URLs, styles or nested arbitrary tags enter
    // the renderer. Everything else still passes through skipHtml.
    function details(children: RootContent[]): RootContent[] {
      const result: RootContent[] = [];
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        const opening = child.type === 'html' && /^<details>\s*<summary>([^<>]*)<\/summary>\s*$/i.exec(child.value.trim());
        if (!opening) { result.push(child); continue; }
        let depth = 1;
        let end = index + 1;
        for (; end < children.length; end++) {
          const next = children[end]!;
          if (next.type !== 'html') continue;
          if (/^<details>/i.test(next.value.trim())) depth++;
          if (/^<\/details>\s*$/i.test(next.value.trim()) && --depth === 0) break;
        }
        if (end === children.length) { result.push(child); continue; }
        const summary = { type: 'paragraph' as const, data: { hName: 'summary' }, children: [{ type: 'text' as const, value: opening[1]! }] };
        result.push({ type: 'blockquote', data: { hName: 'details', hProperties: { className: ['markdown-details'] } },
          children: [summary, ...details(children.slice(index + 1, end))] } as Blockquote);
        index = end;
      }
      return result;
    }
    tree.children = details(tree.children);
  };
}

export function nodeText(node: Nodes): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) return node.children.map(nodeText).join('');
  return '';
}

export function rehypeReplyAnchors(options: { prefix: string }) {
  return (tree: HtmlRoot) => {
    const slugger = new GithubSlugger();
    const ids = new Map<string, string>();
    const headings: Element[] = [];
    // Reserve generated footnote IDs before slugging user-provided headings.
    visit(tree, 'element', node => { if (typeof node.properties.id === 'string') slugger.slug(node.properties.id); });
    visit(tree, 'element', node => {
      if (/^h[1-6]$/.test(node.tagName) && typeof node.properties.id !== 'string') {
        node.properties.id = slugger.slug(nodeText(node));
        headings.push(node);
      }
      const id = node.properties.id;
      if (typeof id === 'string') { ids.set(id, options.prefix + id); node.properties.id = options.prefix + id; }
    });
    for (const heading of headings) heading.children.push({ type: 'element', tagName: 'a', properties: {
      href: `#${encodeURIComponent(String(heading.properties.id))}`, className: ['markdown-heading-link'], ariaLabel: 'Link to section',
    }, children: [{ type: 'text', value: '#' }] });
    visit(tree, 'element', node => {
      const href = node.properties.href;
      if (typeof href === 'string' && href.startsWith('#')) {
        try {
          // GFM footnote IDs already contain URI escapes; heading fragments
          // may instead be URI-encoded by the author. Preserve either form and
          // encode the final DOM ID once for MessageLink's URL decoding.
          const raw = href.slice(1);
          const target = ids.get(raw) ?? ids.get(decodeURIComponent(raw));
          if (target) node.properties.href = '#' + encodeURIComponent(target);
        } catch { /* Malformed fragments remain inert in MessageLink. */ }
      }
      for (const attribute of ['ariaDescribedBy', 'ariaLabelledBy']) {
        const values = node.properties[attribute];
        if (Array.isArray(values)) node.properties[attribute] = values.map(value => ids.get(String(value)) ?? value);
        else if (typeof values === 'string') node.properties[attribute] = values.split(/\s+/).map(value => ids.get(value) ?? value).join(' ');
      }
    });
  };
}
