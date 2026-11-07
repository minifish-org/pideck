import { useLayoutEffect, useRef } from 'react';
import { Icon } from './Icons';
import './image-preview.css';

export function ImagePreview({ source, alt, onClose }: {
  source: string;
  alt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[hidden], [inert]')) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return <dialog ref={dialog} className="image-preview" aria-label="Image preview"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <button type="button" className="icon-button image-preview-close" aria-label="Close image preview"
      title="Close image preview (Esc)" autoFocus onClick={onClose}><Icon name="close" /></button>
    <img src={source} alt={alt} />
  </dialog>;
}
