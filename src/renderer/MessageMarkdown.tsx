import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Project } from '../shared/api';
import { externalMessageUrl, projectMessageLink, type ProjectLink } from '../shared/message-links';
import { readableError } from './conversation';
import { MarkdownPre } from './MarkdownCodeBlock';

function MessageLink({ href, project, onReview, children }: {
  href?: string;
  project: Project;
  onReview: (target: ProjectLink) => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string>();
  const external = href ? externalMessageUrl(href) : undefined;
  const file = href && !external ? projectMessageLink(href, project.directory) : undefined;
  if (!external && !file) return <>{children}</>;

  async function open() {
    setError(undefined);
    try {
      if (external) await window.pideck.invoke('link:open-external', { url: external.href });
      else if (href) onReview(await window.pideck.invoke('review:resolve-link', { projectId: project.id, href }));
    } catch (cause) { setError(readableError(cause)); }
  }

  return <><a className="markdown-link" href={external ? external.href : href}
    title={external ? `Open in browser: ${external.href}` : `Review ${file!.path}${file!.line ? `:${file!.line}` : ''}`}
    onClick={event => { event.preventDefault(); void open(); }}
    onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(); }}>{children}</a>
    {error && <span className="dialog-error" role="alert"> {error}</span>}</>;
}

export const MessageMarkdown = memo(function MessageMarkdown({ text, project, onReview }: {
  text: string;
  project: Project;
  onReview: (target: ProjectLink) => void;
}) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={url => url} components={{
    a: ({ children, href }) => <MessageLink href={href} project={project} onReview={onReview}>{children}</MessageLink>,
    img: ({ alt }) => <span>{alt}</span>,
    pre: MarkdownPre,
  }}>{text}</ReactMarkdown></div>;
});
