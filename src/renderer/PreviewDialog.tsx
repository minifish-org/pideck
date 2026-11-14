import { useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
import './image-preview.css';

export function PreviewDialog({ label, className = '', controls, children, onClose, onKeyDown }: {
  label: string; className?: string; controls?: ReactNode; children: ReactNode; onClose: () => void; onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className={`content-preview ${className}`} aria-label={label}
    onKeyDown={onKeyDown} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <button type="button" className="icon-button image-preview-close" aria-label={`Close ${label.toLowerCase()}`}
      title={`Close ${label.toLowerCase()} (Esc)`} autoFocus onClick={onClose}><Icon name="close" /></button>
    <div className="preview-controls">{controls}</div>
    {children}
  </dialog>, document.body);
}
