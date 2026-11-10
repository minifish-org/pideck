import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import './navigation-overlays.css';

export type NavigationMenuTarget = {
  selection: { projectId: string; sessionId?: string };
  name: string;
  trigger: HTMLButtonElement;
  x: number;
  y: number;
};

export function NavigationMenu({ target, onRemove, onClose }: {
  target: NavigationMenuTarget;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  const kind = target.selection.sessionId ? 'session' : 'project';

  useLayoutEffect(() => {
    const panel = menu.current!;
    const bounds = panel.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8)) });
    panel.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    const scroll = (event: Event) => { if (!panel.contains(event.target as Node)) onClose(); };
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', scroll, true);
      if (panel.contains(document.activeElement) && target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
    };
  }, [target, onClose]);

  return <div ref={menu} className="navigation-menu" role="menu" aria-label={`Actions for ${target.name}`} style={position}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.preventDefault();
    }}>
    <button type="button" role="menuitem" onClick={onRemove}><Icon name="trash" width={14} height={14} />Remove {kind}…</button>
  </div>;
}
