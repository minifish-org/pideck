import { lazy, Suspense, useEffect, useState } from 'react';
import type { ThemedToken } from '@pierre/diffs';
import type { Components } from 'react-markdown';
import { CodeXml, Columns2, Image, WrapText } from 'lucide-react';
import { useAppearance } from './appearance';
import { Icon } from './Icons';

const Mermaid = lazy(() => import('./MarkdownMermaid'));
const ReplyDiff = lazy(() => import('./ReviewPanel').then(module => ({ default: module.ReplyDiff })));
type Highlight = { code: string; language: string; appearance: string; tokens: ThemedToken[][] };
type CopyStatus = 'ready' | 'copying' | 'copied' | 'error';

function MarkdownCodeBlock({ code, language = '', filename, complete = true }: {
  code: string; language?: string; filename?: string; complete?: boolean;
}) {
  const appearance = useAppearance();
  const [highlight, setHighlight] = useState<Highlight>();
  const [copied, setCopied] = useState<{ code: string; status: CopyStatus }>();
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState(false);
  const [split, setSplit] = useState(false);
  const mermaid = language.toLowerCase() === 'mermaid';
  const diff = ['diff', 'patch'].includes(language.toLowerCase());
  const rich = (mermaid || diff) && complete && !source;
  const lineCount = code.split('\n').length - Number(code.endsWith('\n'));
  const long = lineCount > 24 || code.length > 6000;
  const copy = copied?.code === code ? copied.status : 'ready';
  const current = highlight?.code === code && highlight.language === language && highlight.appearance === appearance ? highlight : undefined;

  useEffect(() => {
    // Preserve immediate source updates; coalesce tokenization and ignore stale
    // grammar loads after the source, language, view or palette changes.
    if (rich || !language || code.length > 100_000) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void import('@pierre/diffs').then(async ({ getSharedHighlighter }) => {
        const theme = appearance === 'dark' ? 'github-dark-default' : 'github-light-default';
        const highlighter = await getSharedHighlighter({ themes: [theme], langs: [language], preferredHighlighter: 'shiki-js' });
        if (!active) return;
        const { tokens } = highlighter.codeToTokens(code, { lang: language, theme, tokenizeMaxLineLength: 2_000, tokenizeTimeLimit: 100 });
        if (active) setHighlight({ code, language, appearance, tokens });
      }).catch(() => { /* Unknown languages remain readable, exact plain text. */ });
    }, 60);
    return () => { active = false; window.clearTimeout(timer); };
  }, [appearance, code, language, rich]);
  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopied(undefined), 1_500);
    return () => window.clearTimeout(timer);
  }, [copy]);

  return <div className="markdown-code-block">
    <div className="markdown-code-header">
      <span className="markdown-code-title" title={[language, filename].filter(Boolean).join(' · ')}>{filename || language || 'Code'}</span>
      {filename && <small>{language}</small>}
      {diff && <span className="markdown-diff-label">Proposed · not applied</span>}
      <span className="markdown-code-actions">
        {(mermaid || diff) && <button className="icon-button" type="button" disabled={!complete} aria-label={rich ? 'Show source' : mermaid ? 'Show diagram' : 'Show diff'}
          title={!complete ? 'Waiting for the complete code fence' : rich ? 'Show source' : mermaid ? 'Show diagram' : 'Show diff'} onClick={() => setSource(value => !value)}>
          {rich ? <CodeXml size={15} /> : mermaid ? <Image size={15} /> : <Columns2 size={15} />}
        </button>}
        {diff && rich && <button className="icon-button" type="button" aria-label="Split diff" title="Side-by-side diff" aria-pressed={split}
          onClick={() => setSplit(value => !value)}><Columns2 size={15} /></button>}
        {(!mermaid || !rich) && <button className="icon-button" type="button" aria-label="Wrap code" title="Wrap code" aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}><WrapText size={15} /></button>}
        <button className="icon-button" type="button" aria-label={copy === 'copied' ? 'Code copied' : 'Copy code block'}
          title={copy === 'copied' ? 'Code copied' : 'Copy code block'} disabled={copy === 'copying'} onClick={async () => {
            setCopied({ code, status: 'copying' });
            try { await window.pideck.invoke('clipboard:write', { text: code }); setCopied({ code, status: 'copied' }); }
            catch { setCopied({ code, status: 'error' }); }
          }}><Icon name={copy === 'copied' ? 'check' : 'copy'} width={14} height={14} /></button>
      </span>
    </div>
    {copy === 'error' && <p className="markdown-code-error" role="alert">Couldn’t copy code. Try again.</p>}
    <div className="markdown-code-body" data-collapsed={long && !expanded || undefined} data-wrap={wrap}>
      {rich ? <Suspense fallback={<p className="markdown-render-status" role="status">Loading renderer…</p>}>
        {mermaid ? <Mermaid code={code} /> : <ReplyDiff patch={code} split={split} wrap={wrap} />}
      </Suspense> : <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code'} data-highlighted={current ? appearance : undefined}>
        <code>{current ? current.tokens.map((line, index) => <span key={index}>{index > 0 && '\n'}{line.map((token, tokenIndex) =>
          <span key={tokenIndex} style={{ color: token.color, backgroundColor: token.bgColor,
            fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
            fontWeight: token.fontStyle && token.fontStyle & 2 ? 'bold' : undefined,
            textDecoration: token.fontStyle && token.fontStyle & 4 ? 'underline' : undefined }}>{token.content}</span>)}</span>) : code}</code>
      </pre>}
    </div>
    {long && <button type="button" className="markdown-code-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Collapse code' : `Show all ${lineCount} lines`}
    </button>}
  </div>;
}

// Read HAST text rather than serialized HTML. Inline code keeps its normal
// renderer; metadata comes only from the trusted Markdown AST plugin.
export const MarkdownPre: Components['pre'] = ({ node, children }) => {
  const element = node?.children[0];
  if (element?.type !== 'element' || element.tagName !== 'code' || element.children.some(child => child.type !== 'text')) return <pre>{children}</pre>;
  const classes = element.properties.className;
  const languageClass = Array.isArray(classes) ? classes.find(value => typeof value === 'string' && value.startsWith('language-')) : undefined;
  const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length) : undefined;
  return <MarkdownCodeBlock code={element.children.map(child => child.type === 'text' ? child.value : '').join('')} language={language}
    filename={typeof element.properties.dataFilename === 'string' ? element.properties.dataFilename : undefined}
    complete={element.properties.dataComplete !== 'false'} />;
};
