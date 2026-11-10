import { useEffect, useRef, useState } from 'react';
import type { Commands, Selection } from '../shared/api';
import { readableError } from './conversation';
import { Icon } from './Icons';

export function MessageEditor({ selection, entryId, disabledReason, onSend, onCancel, onPending }: {
  selection: Selection;
  entryId: number;
  disabledReason?: string;
  onSend: (entryId: number, text: string, requestId: string) => Promise<void>;
  onCancel: () => void;
  onPending: (pending: boolean) => void;
}) {
  const [content, setContent] = useState<Commands['chat:edit-read'][1]>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const attempt = useRef<{ text: string; requestId: string } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setError(undefined);
    void window.pideck.invoke('chat:edit-read', { ...selection, entryId }).then(value => {
      if (!active) return;
      setContent(value);
      setText(value.text);
    }, cause => { if (active) setError(readableError(cause)); });
    return () => { active = false; };
  }, [selection.projectId, selection.sessionId, entryId, retry]);

  useEffect(() => { editor.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!content) return;
    editor.current?.focus({ preventScroll: true });
    editor.current?.setSelectionRange(content.text.length, content.text.length);
  }, [content]);

  const canSend = content && !disabledReason && !sending && Boolean(text.trim() || content.images.length);
  async function send() {
    if (!canSend || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(undefined);
    onPending(true);
    if (attempt.current?.text !== text) attempt.current = { text, requestId: crypto.randomUUID() };
    try { await onSend(entryId, text, attempt.current.requestId); }
    catch (cause) { setError(readableError(cause)); }
    finally {
      pending.current = false;
      setSending(false);
      onPending(false);
    }
  }

  return <form className="message-editor" aria-label="Edit sent message" aria-busy={!content && !error || sending}
    onSubmit={event => { event.preventDefault(); void send(); }} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!pending.current) onCancel();
    }}>
    <textarea ref={editor} aria-label="Edit sent message" value={text} maxLength={200000} rows={3}
      placeholder={content ? 'Edit your message…' : 'Opening message…'} readOnly={!content || sending}
      onChange={event => { setText(event.target.value); setError(undefined); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <p className="message-edit-note">Resends from here in a new session. The original conversation is kept; file changes aren’t reverted.</p>
    {Boolean(content?.images.length) && <p className="message-edit-note message-edit-images">
      <Icon name="picture" width={14} height={14} />{content!.images.length} image attachment{content!.images.length === 1 ? '' : 's'} will be kept.
    </p>}
    {disabledReason && <p className="message-edit-note" role="status">{disabledReason}</p>}
    {error && <div className="message-edit-error" role="alert"><span>{error}</span>
      {!content && <button className="inline-action" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>}
    </div>}
    <div className="message-edit-actions">
      <button className="button" type="button" disabled={sending} onClick={onCancel}>Cancel</button>
      <button className="button button--primary" type="submit" disabled={!canSend} aria-busy={sending || undefined}>
        <Icon name={sending ? 'spinner' : 'arrowUp'} width={14} height={14} />{sending ? 'Sending…' : 'Send again'}
      </button>
    </div>
  </form>;
}
