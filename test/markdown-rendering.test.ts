import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeFenceClosed, delimitedTable, diagramSourceError, rehypeReplyAnchors, remarkReply, streamingMarkdown } from '../src/renderer/markdown-rendering';

function render(text: string, prefix = 'reply-a-', streaming = false) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { skipHtml: true, remarkPlugins: [remarkGfm, [remarkReply, { streaming }]],
    rehypePlugins: [[rehypeReplyAnchors, { prefix }]], children: text }));
}

test('reply heading and footnote identifiers, backlinks and accessible labels are scoped to one Markdown block', () => {
  const text = '## Design\n\n[Jump](#design) and a footnote[^1].\n\n## Design\n\n[^1]: Explanation.';
  const a = render(text);
  const b = render(text, 'reply-b-');
  for (const expected of ['id="reply-a-design"', 'id="reply-a-design-1"', 'href="#reply-a-design"',
    'id="reply-a-user-content-fn-1"', 'href="#reply-a-user-content-fn-1"',
    'href="#reply-a-user-content-fnref-1"', 'aria-describedby="reply-a-footnote-label"']) assert.ok(a.includes(expected), expected);
  assert.ok(!b.includes('reply-a-'));
  const collision = render('## user-content-fn-1\n\nA footnote[^1].\n\n[^1]: Explanation.');
  assert.ok(collision.includes('id="reply-a-user-content-fn-1-1"'));
  const ids = [...collision.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(render('## 中文 标题\n\n[回去](#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98)').includes(`href="#${encodeURIComponent('reply-a-中文-标题')}"`));
  const unicode = render('Unicode[^脚注], percent[^a%b] and another percent[^a%25b].\n\n[^脚注]: Explanation.\n[^a%b]: Percent.\n[^a%25b]: Escaped percent.');
  const unicodeIds = new Set([...unicode.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
  for (const [, href] of unicode.matchAll(/ href="#([^"]+)"/g)) assert.ok(unicodeIds.has(decodeURIComponent(href!)), href);
});

test('code metadata and completion state survive Markdown conversion without changing source or executing markup', () => {
  const text = '```typescript filename="src/a b.ts"\nconst source = "<img src=x onerror=evil()>";\n```';
  const result = render(text);
  assert.ok(result.includes('data-filename="src/a b.ts"'));
  assert.ok(result.includes('data-complete="true"'));
  assert.ok(result.includes('&lt;img src=x onerror=evil()&gt;'));
  assert.ok(!result.includes('<img'));
  assert.ok(render('```mermaid\ngraph LR\nA-->B', 'reply-', true).includes('data-complete="false"'));
  assert.ok(render('```ts src/index.ts\nvalue\n```').includes('data-filename="src/index.ts"'));
  assert.equal(codeFenceClosed('```ts\nvalue'), false);
  assert.equal(codeFenceClosed('```ts\nvalue\n```'), true);
  assert.equal(codeFenceClosed('~~~~ts\n~~~'), false);
  assert.equal(codeFenceClosed('~~~ts\n~~~~'), true);
});

test('stream repair is temporary, preserves code bytes and leaves unfinished links inert', () => {
  const original = 'Here is **bold';
  assert.equal(streamingMarkdown(original), 'Here is **bold**');
  assert.equal(original, 'Here is **bold');
  const code = '```typescript\nconst x = "**not markdown";\n';
  assert.equal(streamingMarkdown(code), code);
  assert.ok(!streamingMarkdown('[Open](https://examp').includes('](https://examp'));
  assert.ok(!streamingMarkdown('![Screen](output/par').includes('](output/par'));
});

test('alerts and a narrow details/summary allowlist render without admitting raw HTML attributes or scripts', () => {
  const result = render('> [!WARNING]\n> Be careful.\n\n<details>\n<summary>More information</summary>\n\nSafe **Markdown**.\n\n</details>');
  assert.ok(result.includes('data-kind="warning"'));
  assert.ok(result.includes('<summary>More information</summary>'));
  assert.ok(result.includes('<strong>Markdown</strong>'));
  assert.ok(result.includes('<details class="markdown-details">'));
  const unsafe = render('<details onclick="evil()">\n<summary>Bad</summary>\n\nText\n\n</details>\n\n<script>evil()</script>');
  assert.ok(!unsafe.includes('onclick'));
  assert.ok(!unsafe.includes('<script'));
  assert.ok(!unsafe.includes('<details'));
});

test('diagram source rejects configuration, network assets and CSS before upstream measures its DOM', () => {
  for (const source of ['flowchart LR\nA[Inspect]-->B[Verify]', 'sequenceDiagram\nAlice->>Bob: Hello', 'pie\n"Tests": 12']) assert.equal(diagramSourceError(source), undefined);
  for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\ngraph LR\nA-->B', '%% {init: {}}%%', '---\nconfig: {}\n---\nA-->B',
    'flowchart LR\nA@{ img: "https://untrusted.invalid/image.png" }', 'flowchart LR\nA@{ img: "relative.png" }',
    'flowchart LR\nA[<img src="//untrusted.invalid/image.png">]', 'graph LR\nA-->B; classDef red fill:url(//untrusted.invalid/x)',
    'graph LR\nstyle A fill:red', 'graph LR\nclassDef red fill:u\\72l(example)', 'graph LR\nclick A "https://untrusted.invalid"',
    'graph LR\nA[<script>evil()</script>]', 'A'.repeat(30_001),
  ]) assert.ok(diagramSourceError(source), source.slice(0, 100));
});

test('table exports preserve cell delimiters, quotes, newlines and Unicode', () => {
  assert.equal(delimitedTable([['Name', 'Value'], ['中文, value', 'a"b'], ['next', 'two\nlines']], ','),
    'Name,Value\n"中文, value","a""b"\nnext,"two\nlines"');
  assert.equal(delimitedTable([['a\tb', 'c,d']], '\t'), '"a\tb"\tc,d');
});
