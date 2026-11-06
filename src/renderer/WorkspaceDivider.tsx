import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import './workspace-divider.css';

const widthProperty = '--tools-width';

export function WorkspaceDivider({ workspace, sizingTarget, visible }: {
  workspace: RefObject<HTMLElement | null>;
  sizingTarget: RefObject<HTMLElement | null>;
  visible: boolean;
}) {
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; coordinate: number; size: number } | undefined>(undefined);
  const min = 340;
  const max = Math.max(min, available - 360);
  // Match the layout's CSS defaults before the first manual adjustment.
  const automatic = Math.max(380, Math.min(760, Math.round(available * .46)));
  const clamp = (size: number) => Math.min(max, Math.max(min, size));
  const size = clamp(preferred ?? automatic);

  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element || !visible) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspace, visible]);

  useLayoutEffect(() => {
    const element = sizingTarget.current;
    if (!element || !visible || preferred === undefined) return;
    element.style.setProperty(widthProperty, `${size}px`);
    return () => { element.style.removeProperty(widthProperty); };
  }, [sizingTarget, preferred, size, visible]);

  function resize(next: number) {
    const bounded = clamp(next);
    setPreferred((current) => bounded === clamp(current ?? automatic) ? current : bounded);
  }

  return <div
    className="workspace-divider"
    role="separator" tabIndex={0} hidden={!visible} aria-label="Resize right sidebar"
    aria-controls="workspace-tools" aria-orientation="vertical"
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
        case 'ArrowLeft': resize(size + step); break;
        case 'ArrowRight': resize(size - step); break;
        default: return;
      }
      event.preventDefault();
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, coordinate: event.clientX, size };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      resize(Math.round(start.size + start.coordinate - event.clientX));
    }}
    onLostPointerCapture={() => {
      drag.current = undefined;
      setDragging(false);
    }}
  />;
}
