import { useEffect, useRef, useState } from 'react';
import type { Commands } from '../shared/api';
import { externalMessageUrl, localMessageImagePath } from '../shared/message-links';
import { imageSource } from './ChatImage';
import { ImagePreview } from './ImagePreview';
import { readableError } from './conversation';
import { useMarkdownScope } from './markdown-context';

export function MarkdownImage({ src = '', alt = '' }: { src?: string; alt?: string }) {
  const { selection, entryId, streaming } = useMarkdownScope();
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; value?: Commands['chat:reply-image'][1]; error?: string }>();
  const [preview, setPreview] = useState(false);
  const local = localMessageImagePath(src);
  const external = externalMessageUrl(src);
  const incomplete = src === 'streamdown:incomplete-image';
  const key = `${selection?.projectId}/${selection?.sessionId}/${entryId}/${src}`;
  const current = result?.key === key ? result : undefined;
  useEffect(() => {
    if (!anchor.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setResult(undefined); setPreview(false);
    if (!visible || !local || !selection || !entryId || streaming) return;
    let active = true;
    const scope = { ...selection, entryId, href: src, requestId: crypto.randomUUID() };
    void window.pideck.invoke('chat:reply-image', scope).then(
      value => { if (active) setResult(imageSource(value) ? { key, value } : { key, error: 'This image cannot be previewed.' }); },
      cause => { if (active) setResult({ key, error: readableError(cause) }); },
    );
    return () => { active = false; void window.pideck.invoke('chat:reply-image-cancel', scope).catch(() => {}); };
  }, [src, local, selection?.projectId, selection?.sessionId, entryId, streaming, visible, attempt, key]);
  const source = current?.value && imageSource(current.value);
  return <span ref={anchor} className="markdown-image" role="group" aria-label={alt || 'Reply image'}>
    {source ? <button type="button" className="message-image-trigger" aria-label={`Preview ${alt || 'reply image'}`}
      onClick={() => setPreview(true)}><img className="message-image" src={source} alt={alt}
        onError={() => setResult({ key, error: 'This image could not be decoded.' })} /></button>
      : <span className="markdown-image-placeholder">{current?.error ? <>
        <span role="alert">{current.error}</span> <button type="button" className="inline-action" onClick={() => setAttempt(value => value + 1)}>Retry image</button>
      </> : incomplete || streaming || !entryId ? 'Image available when the reply finishes.'
        : !local ? <>Remote and embedded images are not loaded automatically.{external && <button type="button" className="inline-action"
          onClick={() => { void window.pideck.invoke('link:open-external', { url: external.href }).catch(cause => setResult({ key, error: readableError(cause) })); }}>Open in browser</button>}</>
        : !selection ? 'Open this conversation to view the image.' : 'Loading image…'}</span>}
    <span className="markdown-image-caption">{alt || 'Image'}{current?.value && <small> · {current.value.source === 'conversation' ? 'Saved in conversation' : 'Current file'}</small>}</span>
    {preview && source && <ImagePreview source={source} alt={alt || 'Reply image'} onClose={() => setPreview(false)} />}
  </span>;
}
