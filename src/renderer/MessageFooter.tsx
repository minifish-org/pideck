import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '../shared/api';
import { Icon } from './Icons';

function messageText(message: ChatMessage) {
  return [...message.blocks.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type !== 'tool') return [];
    return block.output ? [block.output] : [];
  }), ...(message.error ? [message.error] : [])].join('\n\n');
}

function workingTime(milliseconds: number) {
  if (milliseconds < 1_000) return '<1s';
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return [hours && `${hours}h`, (hours || minutes) && `${minutes}m`, `${seconds % 60}s`].filter(Boolean).join(' ');
}

export function MessageFooter({ message, onFork, toolOnly = false }: { message: ChatMessage; onFork?: (entryId: number) => void; toolOnly?: boolean }) {
  const text = useMemo(() => messageText(message), [message.blocks, message.error]);
  const [copy, setCopy] = useState<'ready' | 'copying' | 'copied' | 'error'>('ready');
  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopy('ready'), 1_500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const date = message.timestamp === undefined ? undefined : new Date(message.timestamp);
  const timestamp = date && Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : undefined;
  const duration = message.durationMs;
  const entryId = message.entryId;
  const copyLabel = toolOnly ? 'Copy output' : 'Copy message';
  const copiedLabel = toolOnly ? 'Output copied' : 'Message copied';

  return <footer className="message-footer">
    <button type="button" className="icon-button message-copy" disabled={!text || copy === 'copying'}
      aria-label={copy === 'copied' ? copiedLabel : copyLabel}
      title={!text ? 'No text to copy' : copy === 'copied' ? copiedLabel : copyLabel} onClick={async () => {
        setCopy('copying');
        try {
          await window.pideck.invoke('clipboard:write', { text });
          setCopy('copied');
        } catch {
          setCopy('error');
        }
      }}><Icon name={copy === 'copied' ? 'check' : 'copy'} width={14} height={14} /></button>
    {message.role === 'assistant' && onFork && entryId !== undefined && <button type="button" className="icon-button message-fork"
      onClick={() => onFork(entryId)} title="Start a new session from this message" aria-label="Branch from here">
      <Icon name="fork" width={14} height={14} />
    </button>}
    {timestamp && <time className="message-time" dateTime={date!.toISOString()}>{timestamp}</time>}
    {message.role === 'assistant' && duration !== undefined && Number.isFinite(duration) && duration >= 0
      && <span className="message-duration" aria-label="Total working time" title={`Total working time: ${workingTime(duration)}`}>
        <Icon name="timer" width={13} height={13} />{workingTime(duration)}
      </span>}
    {copy === 'error' && <span className="message-copy-error" role="alert">Couldn’t copy. Try again.</span>}
  </footer>;
}
