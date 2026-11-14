import { useEffect, useRef, useState } from 'react';
import { useAppearance } from './appearance';
import { ImagePreview } from './ImagePreview';
import { diagramSourceError } from './markdown-rendering';

// Mermaid has global configuration and a shared rendering queue. Serialize the
// theme change together with render. Upstream's strict renderer measures in a
// temporary hidden container; the finished preview is an inert blob image.
let queue: Promise<unknown> = Promise.resolve();
function renderDiagram(code: string, appearance: string, current: () => boolean) {
  const job = queue.catch(() => {}).then(async () => {
    if (!current()) return;
    const error = diagramSourceError(code);
    if (error) throw new Error(error);
    const { default: mermaid } = await import('mermaid');
    if (!current()) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
      theme: appearance === 'dark' ? 'dark' : 'default', maxTextSize: 30_000, maxEdges: 300, suppressErrorRendering: true,
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'maxTextSize', 'maxEdges', 'suppressErrorRendering'] });
    const container = document.createElement('div');
    container.className = 'mermaid-measure';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try { return (await mermaid.render(`diagram-${crypto.randomUUID()}`, code, container)).svg; }
    finally { container.remove(); }
  });
  queue = job;
  return job;
}

export default function MarkdownMermaid({ code }: { code: string }) {
  const appearance = useAppearance();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ code: string; appearance: string; source?: string; error?: string }>();
  const [preview, setPreview] = useState(false);
  const current = result?.code === code && result.appearance === appearance ? result : undefined;
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let source: string | undefined;
    const timer = setTimeout(() => {
      void renderDiagram(code, appearance, () => active).then(svg => {
        if (!active || !svg) return;
        // Mermaid emits percentage widths. Give the SVG intrinsic dimensions
        // so a shrink-to-fit image/button cannot collapse to a zero-size box.
        const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = document.documentElement;
        const bounds = root.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
        if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2]! <= 0 || bounds[3]! <= 0) throw new Error('Diagram has no readable dimensions. Use the source view.');
        if (bounds[2]! > 30_000 || bounds[3]! > 30_000 || bounds[2]! * bounds[3]! > 64_000_000) throw new Error('Diagram is too large to display. Use the source view.');
        root.setAttribute('width', String(bounds[2])); root.setAttribute('height', String(bounds[3]));
        source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
        setResult({ code, appearance, source });
      }).catch(cause => { if (active) setResult({ code, appearance, error: cause instanceof Error ? cause.message.slice(0, 500) : 'Could not render diagram.' }); });
    }, 180);
    return () => { active = false; clearTimeout(timer); if (source) URL.revokeObjectURL(source); };
  }, [code, appearance, visible]);
  return <div className="markdown-diagram" ref={element}>
    {current?.source ? <button type="button" className="message-image-trigger" aria-label="Expand Mermaid diagram" onClick={() => setPreview(true)}>
      <img src={current.source} alt="Mermaid diagram" onError={() => setResult({ code, appearance, error: 'Could not display diagram. Use the source view.' })} />
    </button> : current?.error ? <p className="markdown-code-error" role="alert">{current.error}</p> : <p role="status">Rendering diagram…</p>}
    {preview && current?.source && <ImagePreview source={current.source} alt="Mermaid diagram" onClose={() => setPreview(false)} />}
  </div>;
}
