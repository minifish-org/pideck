import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import './workspace-divider.css';
import './navigation-divider.css';

export function NavigationDivider({ sizingTarget, visible, preferred, onResize }: {
  sizingTarget: RefObject<HTMLElement | null>;
  visible: boolean;
  preferred?: number;
  onResize: (width: number | undefined) => void;
}) {
  const [available, setAvailable] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; coordinate: number; size: number } | undefined>(undefined);
  const min = 180;
  const max = Math.max(min, Math.min(400, available - 780));
  const automatic = Math.max(208, Math.min(240, available * .19));
  const clamp = (width: number) => Math.min(max, Math.max(min, width));
  const size = clamp(preferred ?? automatic);

  useEffect(() => {
    const element = sizingTarget.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizingTarget]);

  useLayoutEffect(() => {
    const element = sizingTarget.current;
    if (!element || preferred === undefined) return;
    element.style.setProperty('--nav-width', `${size}px`);
    return () => { element.style.removeProperty('--nav-width'); };
  }, [sizingTarget, preferred, size, visible]);

  function resize(width: number) {
    const next = clamp(Math.round(width));
    if (next !== preferred) onResize(next);
  }

  return <div className="workspace-divider navigation-divider" role="separator" tabIndex={0} hidden={!visible}
    aria-label="Resize left sidebar" aria-controls="workspace-navigation" aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={size} aria-valuetext={`${Math.round(size)} pixels`}
    data-dragging={dragging || undefined} title="Drag or use arrow keys to resize. Double-click or press Enter to reset."
    onMouseDown={event => event.preventDefault()}
    onDoubleClick={() => onResize(undefined)}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? 64 : 16;
      switch (event.key) {
        case 'Enter': onResize(undefined); break;
        case 'Home': resize(min); break;
        case 'End': resize(max); break;
        case 'ArrowLeft': resize(size - step); break;
        case 'ArrowRight': resize(size + step); break;
        default: return;
      }
      event.preventDefault();
    }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, coordinate: event.clientX, size };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      resize(start.size + event.clientX - start.coordinate);
    }}
    onLostPointerCapture={() => {
      drag.current = undefined;
      setDragging(false);
    }} />;
}
