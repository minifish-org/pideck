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

export function MessageFooter({ message, onFork, onEdit, editDisabled, toolOnly = false }: {
  message: ChatMessage;
  onFork?: (entryId: number) => void;
  onEdit?: (entryId: number) => void;
  editDisabled?: boolean;
  toolOnly?: boolean;
}) {
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
  const entryId = message.entryId;
  const assistant = message.role === 'assistant';
  const time = timestamp && <time className="message-time" dateTime={date!.toISOString()}>{timestamp}</time>;
  const copyLabel = toolOnly ? 'Copy output' : 'Copy message';
  const copiedLabel = toolOnly ? 'Output copied' : 'Message copied';

  return <footer className="message-footer">
    {assistant && time}
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
    {!assistant && onEdit && entryId !== undefined && <button type="button" className="icon-button message-edit"
      disabled={editDisabled} onClick={() => onEdit(entryId)} title="Edit and resend this message" aria-label="Edit message">
      <Icon name="edit" width={14} height={14} />
    </button>}
    {assistant && onFork && entryId !== undefined && <button type="button" className="icon-button message-fork"
      onClick={() => onFork(entryId)} title="Start a new session from this message" aria-label="Branch from here">
      <Icon name="fork" width={14} height={14} />
    </button>}
    {!assistant && time}
    {copy === 'error' && <span className="message-copy-error" role="alert">Couldn’t copy. Try again.</span>}
  </footer>;
}
