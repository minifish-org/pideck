import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import './workspace-divider.css';

const panes = {
  review: { vertical: true, property: '--review-width', controls: 'review-panel', min: 340, reserve: 360 },
  terminal: { vertical: false, property: '--terminal-height', controls: 'workspace-terminal', min: 136, reserve: 260 },
} as const;

export function WorkspaceDivider({ workspace, pane, visible }: {
  workspace: RefObject<HTMLElement | null>;
  pane: keyof typeof panes;
  visible: boolean;
}) {
  const { vertical, property, controls, min, reserve } = panes[pane];
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; coordinate: number; size: number } | undefined>(undefined);
  const max = Math.max(min, available - reserve);
  // Match the layout's CSS defaults before the first manual adjustment.
  const automatic = vertical
    ? Math.max(380, Math.min(760, Math.round(available * .48)))
    : Math.max(136, Math.min(356, Math.round(available * .31)));
  const clamp = (size: number) => Math.min(max, Math.max(min, size));
  const size = clamp(preferred ?? automatic);

  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element || !visible) return;
    const measure = () => setAvailable(vertical ? element.clientWidth : element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspace, vertical, visible]);

  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element || !visible || preferred === undefined) return;
    element.style.setProperty(property, `${size}px`);
    return () => { element.style.removeProperty(property); };
  }, [workspace, preferred, property, size, visible]);

  function resize(next: number) {
    const bounded = clamp(next);
    setPreferred((current) => bounded === clamp(current ?? automatic) ? current : bounded);
  }

  return <div
    className={`workspace-divider workspace-divider--${vertical ? 'vertical' : 'horizontal'}`}
    role="separator" tabIndex={0} hidden={!visible} aria-label={`Resize ${pane}`}
    aria-controls={controls} aria-orientation={vertical ? 'vertical' : 'horizontal'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={size} aria-valuetext={`${size} pixels`}
    data-dragging={dragging || undefined} title="Drag or use arrow keys to resize. Double-click or press Enter to reset."
    onMouseDown={(event) => event.preventDefault()}
    onDoubleClick={() => setPreferred(undefined)}
    onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? 64 : 16;
      switch (event.key) {
        case 'Enter': setPreferred(undefined); break;
        case 'Home': resize(min); break;
        case 'End': resize(max); break;
        default:
          if (event.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) resize(size + step);
          else if (event.key === (vertical ? 'ArrowRight' : 'ArrowDown')) resize(size - step);
          else return;
      }
      event.preventDefault();
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, coordinate: vertical ? event.clientX : event.clientY, size };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const coordinate = vertical ? event.clientX : event.clientY;
      resize(Math.round(start.size + start.coordinate - coordinate));
    }}
    onLostPointerCapture={() => {
      drag.current = undefined;
      setDragging(false);
    }}
  />;
}
