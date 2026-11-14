import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, WrapText } from 'lucide-react';
import { PreviewDialog } from './PreviewDialog';
import { delimitedTable } from './markdown-rendering';

type Row = { cells: string[]; heading: boolean };
export function MarkdownTable({ children }: { children?: ReactNode }) {
  const table = useRef<HTMLTableElement>(null);
  const [wrap, setWrap] = useState(true);
  const [preview, setPreview] = useState<Row[]>();
  const [copy, setCopy] = useState<'ready' | 'tsv' | 'csv' | 'error'>('ready');
  useEffect(() => {
    if (copy === 'ready' || copy === 'error') return;
    const timer = setTimeout(() => setCopy('ready'), 1500);
    return () => clearTimeout(timer);
  }, [copy]);
  function rows(): Row[] {
    return [...(table.current?.rows ?? [])].map(row => ({
      cells: [...row.cells].map(cell => cell.textContent ?? ''), heading: [...row.cells].every(cell => cell.tagName === 'TH'),
    }));
  }
  async function copyTable(format: 'tsv' | 'csv') {
    try {
      await window.pideck.invoke('clipboard:write', { text: delimitedTable((preview ?? rows()).map(row => row.cells), format === 'csv' ? ',' : '\t') });
      setCopy(format);
    } catch { setCopy('error'); }
  }
  const controls = <>
    <span>Table</span>
    <button type="button" className="inline-action" onClick={() => void copyTable('tsv')}>{copy === 'tsv' ? 'TSV copied' : 'Copy TSV'}</button>
    <button type="button" className="inline-action" onClick={() => void copyTable('csv')}>{copy === 'csv' ? 'CSV copied' : 'Copy CSV'}</button>
    <button type="button" className="icon-button" aria-label="Wrap table cells" title="Wrap table cells" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={15} /></button>
  </>;
  return <div className="markdown-table" data-wrap={wrap}>
    <div className="markdown-table-header">{controls}
      <button type="button" className="icon-button" aria-label="Expand table" title="Expand table" onClick={() => setPreview(rows())}><Maximize2 size={15} /></button>
    </div>
    {copy === 'error' && <span className="markdown-code-error" role="alert">Couldn’t copy table. Try again.</span>}
    <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table"><table ref={table}>{children}</table></div>
    {preview && <PreviewDialog label="Table preview" className="markdown-table-preview" onClose={() => setPreview(undefined)} controls={controls}>
      <div className="markdown markdown-table-scroll" data-wrap={wrap} tabIndex={0} role="region" aria-label="Expanded table">
        {copy === 'error' && <p className="markdown-code-error" role="alert">Couldn’t copy table. Try again.</p>}
        <table><tbody>{preview.map((row, index) => <tr key={index}>{row.cells.map((cell, column) => row.heading
          ? <th key={column} scope="col">{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
      </div>
    </PreviewDialog>}
  </div>;
}
