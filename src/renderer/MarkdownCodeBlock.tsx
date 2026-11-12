import { useEffect, useState } from 'react';
import type { ThemedToken } from '@pierre/diffs';
import type { Components } from 'react-markdown';
import { useAppearance } from './appearance';
import { Icon } from './Icons';

type Highlight = { code: string; language: string; appearance: string; tokens: ThemedToken[][] };
type CopyStatus = 'ready' | 'copying' | 'copied' | 'error';

function MarkdownCodeBlock({ code, language = '' }: { code: string; language?: string }) {
  const appearance = useAppearance();
  const [highlight, setHighlight] = useState<Highlight>();
  const [copied, setCopied] = useState<{ code: string; status: CopyStatus }>();
  const copy = copied?.code === code ? copied.status : 'ready';
  const current = highlight?.code === code && highlight.language === language && highlight.appearance === appearance
    ? highlight : undefined;

  useEffect(() => {
    // Keep streamed text current immediately; coalesce tokenization and ignore
    // older grammar loads after the source, language or palette changes.
    if (!language || code.length > 100_000) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void import('@pierre/diffs').then(async ({ getSharedHighlighter }) => {
        const theme = appearance === 'dark' ? 'github-dark-default' : 'github-light-default';
        const highlighter = await getSharedHighlighter({ themes: [theme], langs: [language], preferredHighlighter: 'shiki-js' });
        if (!active) return;
        const { tokens } = highlighter.codeToTokens(code, { lang: language, theme, tokenizeMaxLineLength: 2_000, tokenizeTimeLimit: 100 });
        if (active) setHighlight({ code, language, appearance, tokens });
      }).catch(() => { /* Unknown languages and unavailable grammars remain readable plain text. */ });
    }, 60);
    return () => { active = false; window.clearTimeout(timer); };
  }, [appearance, code, language]);

  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopied(undefined), 1_500);
    return () => window.clearTimeout(timer);
  }, [copy]);

  return <div className="markdown-code-block">
    <div className="markdown-code-header">
      <span>{language || 'Code'}</span>
      <button className="icon-button" type="button" aria-label={copy === 'copied' ? 'Code copied' : 'Copy code block'}
        title={copy === 'copied' ? 'Code copied' : 'Copy code block'} disabled={copy === 'copying'} onClick={async () => {
          setCopied({ code, status: 'copying' });
          try { await window.pideck.invoke('clipboard:write', { text: code }); setCopied({ code, status: 'copied' }); }
          catch { setCopied({ code, status: 'error' }); }
        }}><Icon name={copy === 'copied' ? 'check' : 'copy'} width={14} height={14} /></button>
    </div>
    {copy === 'error' && <p className="markdown-code-error" role="alert">Couldn’t copy code. Try again.</p>}
    <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code'} data-highlighted={current ? appearance : undefined}>
      <code>{current ? current.tokens.map((line, index) => <span key={index}>{index > 0 && '\n'}{line.map((token, tokenIndex) =>
        <span key={tokenIndex} style={{ color: token.color, backgroundColor: token.bgColor,
          fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
          fontWeight: token.fontStyle && token.fontStyle & 2 ? 'bold' : undefined,
          textDecoration: token.fontStyle && token.fontStyle & 4 ? 'underline' : undefined }}>{token.content}</span>)}</span>) : code}</code>
    </pre>
  </div>;
}

// ReactMarkdown wraps both fenced and indented blocks in pre/code; inline code
// keeps its normal renderer. Read HAST text rather than serialized HTML.
export const MarkdownPre: Components['pre'] = ({ node, children }) => {
  const element = node?.children[0];
  if (element?.type !== 'element' || element.tagName !== 'code' || element.children.some(child => child.type !== 'text')) {
    return <pre>{children}</pre>;
  }
  const classes = element.properties.className;
  const languageClass = Array.isArray(classes) ? classes.find(value => typeof value === 'string' && value.startsWith('language-')) : undefined;
  const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length) : undefined;
  return <MarkdownCodeBlock code={element.children.map(child => child.type === 'text' ? child.value : '').join('')} language={language} />;
};
