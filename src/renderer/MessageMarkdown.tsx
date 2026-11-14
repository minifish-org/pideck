import { memo, useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Project, Selection } from '../shared/api';
import { externalMessageUrl, projectMessageLink, type ProjectLink } from '../shared/message-links';
import { readableError } from './conversation';
import { MarkdownPre } from './MarkdownCodeBlock';
import { MarkdownImage } from './MarkdownImage';
import { MarkdownTable } from './MarkdownTable';
import { MarkdownContext, useMarkdownScope } from './markdown-context';
import { rehypeReplyAnchors, remarkReply, streamingMarkdown } from './markdown-rendering';
import './markdown.css';

const MessageLink: Components['a'] = ({ node: _node, children, href, ...props }) => {
  const { project, onReview, container } = useMarkdownScope();
  const [error, setError] = useState<string>();
  const fragment = href?.startsWith('#') ? href.slice(1) : undefined;
  const external = href ? externalMessageUrl(href) : undefined;
  const file = href && !external ? projectMessageLink(href, project.directory) : undefined;
  if (fragment === undefined && !external && !file) return <>{children}</>;

  async function open() {
    setError(undefined);
    try {
      if (fragment !== undefined) {
        const target = container.current?.querySelector<HTMLElement>(`[id="${CSS.escape(decodeURIComponent(fragment))}"]`);
        if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
      } else if (external) await window.pideck.invoke('link:open-external', { url: external.href });
      else if (href) onReview(await window.pideck.invoke('review:resolve-link', { projectId: project.id, href }));
    } catch (cause) { setError(readableError(cause)); }
  }

  return <><a {...props} className={['markdown-link', props.className].filter(Boolean).join(' ')} href={external ? external.href : href}
    title={props.title ?? (fragment !== undefined ? 'Jump within this reply' : external ? `Open in browser: ${external.href}`
      : `Review ${file!.path}${file!.line ? `:${file!.line}` : ''}`)}
    onClick={event => { event.preventDefault(); void open(); }}
    onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(); }}>{children}</a>
    {error && <span className="dialog-error" role="alert"> {error}</span>}</>;
};

// Stable component identities preserve copy, wrap, collapse and preview state
// while later tokens append to a reply. No per-render inline component lambdas.
const components: Components = { a: MessageLink, img: MarkdownImage, pre: MarkdownPre, table: MarkdownTable };

const MarkdownContent = memo(function MarkdownContent({ text, streaming, prefix }: { text: string; streaming: boolean; prefix: string }) {
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, [remarkReply, { streaming }]]}
    rehypePlugins={[[rehypeReplyAnchors, { prefix }]]} urlTransform={url => url} components={components}>{text}</ReactMarkdown>;
});

export const MessageMarkdown = memo(function MessageMarkdown({ text, project, selection, entryId, streaming = false, onReview }: {
  text: string; project: Project; selection?: Selection; entryId?: number; streaming?: boolean;
  onReview: (target: ProjectLink) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const prefix = `md-${useId()}-`;
  const deferred = useDeferredValue(text);
  const visibleText = streaming ? deferred : text;
  const displayed = useMemo(() => streaming ? streamingMarkdown(visibleText) : visibleText, [visibleText, streaming]);
  const scope = useMemo(() => ({ project, selection, entryId, streaming, onReview, container }), [project, selection, entryId, streaming, onReview]);
  return <MarkdownContext value={scope}><div className="markdown" ref={container}>
    <MarkdownContent text={displayed} streaming={streaming} prefix={prefix} />
  </div></MarkdownContext>;
});
