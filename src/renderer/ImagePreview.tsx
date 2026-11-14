import { useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus, Scan, ScanLine } from 'lucide-react';
import { PreviewDialog } from './PreviewDialog';

export function ImagePreview({ source, alt, onClose }: { source: string; alt: string; onClose: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number>();
  const [error, setError] = useState(false);
  const fit = natural.width ? Math.min(1, size.width / natural.width, size.height / natural.height) : 1;
  const scale = zoom ?? fit;
  const changeZoom = (factor: number) => setZoom(Math.min(4, Math.max(.1, scale * factor)));
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (zoom === undefined && viewport.current) viewport.current.scrollTo(0, 0);
  }, [zoom]);

  return <PreviewDialog label="Image preview" className="image-preview" onClose={onClose} onKeyDown={event => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
    if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25); }
    if (event.key === '0') setZoom(undefined);
    if (event.key === '1') setZoom(1);
  }} controls={<>
    <span className="preview-image-name" title={alt}>{alt}</span>
    <span className="preview-image-dimensions">{natural.width ? `${natural.width} × ${natural.height}` : ''}</span>
    <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out (−)" disabled={scale <= .1} onClick={() => changeZoom(1 / 1.25)}><Minus size={15} /></button>
    <span className="preview-zoom" aria-live="polite">{Math.round(scale * 100)}%</span>
    <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in (+)" disabled={scale >= 4} onClick={() => changeZoom(1.25)}><Plus size={15} /></button>
    <button type="button" className="icon-button" aria-label="Actual size" title="Actual size (1)" onClick={() => setZoom(1)}><ScanLine size={15} /></button>
    <button type="button" className="icon-button" aria-label="Fit image" title="Fit image (0)" onClick={() => setZoom(undefined)}><Scan size={15} /></button>
  </>}>
    <div className="image-preview-viewport" ref={viewport} tabIndex={0} aria-label="Image canvas"
      data-zoomed={zoom !== undefined || undefined} onPointerDown={event => {
        if (event.button !== 0 || zoom === undefined) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
      }} onPointerMove={event => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
        event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
      }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <div className="image-preview-canvas" style={zoom === undefined ? undefined : { width: natural.width * scale || '100%', height: natural.height * scale || '100%' }}>
        {error ? <p role="alert">This image could not be decoded.</p> : <img src={source} alt={alt} draggable={false}
          style={zoom === undefined ? undefined : { width: natural.width ? natural.width * scale : undefined, height: natural.height ? natural.height * scale : undefined }}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setError(true)} />}
      </div>
    </div>
  </PreviewDialog>;
}
