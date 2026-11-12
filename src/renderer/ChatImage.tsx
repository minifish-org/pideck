import { useEffect, useRef, useState } from 'react';
import type { ChatImage, Selection } from '../shared/api';
import { ImagePreview } from './ImagePreview';
import { readableError } from './conversation';

function imageSource(image: ChatImage) {
  const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!supported.includes(image.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return undefined;
  return `data:${image.mimeType};base64,${image.data}`;
}

export function ImageBlock({ image, alt, thumbnail = false, selection }: {
  image: ChatImage; alt: string; thumbnail?: boolean; selection?: Selection;
}) {
  const [preview, setPreview] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const source = imageSource(image);
  const deferred = !source && image.ref && selection;
  useEffect(() => {
    setLoading(false);
    setError(undefined);
    setPreview(undefined);
    return () => { generation.current++; };
  }, [image.ref?.entryId, image.ref?.messageIndex, image.ref?.contentIndex, selection?.sessionId]);

  async function open() {
    if (loading) return;
    setError(undefined);
    if (source) { setPreview(source); return; }
    if (!image.ref || !selection) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = imageSource(await window.pideck.invoke('chat:image', { ...selection, ...image.ref }));
      if (request !== generation.current) return;
      if (!result) throw new Error('This image cannot be previewed.');
      setPreview(result);
    } catch (cause) {
      if (request === generation.current) setError(readableError(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  return source || deferred ? <>
    <button type="button" className={source ? thumbnail ? 'attachment-preview' : 'message-image-trigger' : 'button message-image-load'}
      aria-label={`Preview ${alt.toLowerCase()}`} title="Preview image" disabled={loading} aria-busy={loading || undefined}
      onClick={() => void open()}>
      {source ? <img className={thumbnail ? undefined : 'message-image'} src={source} alt={alt} />
        : loading ? 'Loading image…' : 'View earlier image'}
    </button>
    {error && <span className="dialog-error" role="alert">{error}</span>}
    {preview && <ImagePreview source={preview} alt={alt} onClose={() => setPreview(undefined)} />}
  </> : null;
}
