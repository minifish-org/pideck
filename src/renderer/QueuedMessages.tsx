import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatView, QueueUpdate, Selection } from '../shared/api';
import { readableError } from './conversation';
import { Icon } from './Icons';

type Item = NonNullable<ChatView['queued']>[number];
type Edit = { id: number; text: string; original: string; hasImages: boolean };

function QueueActions({ item, before, after, canSteer, blocked, onEdit, onUpdate }: {
  item: Item;
  before?: Item;
  after?: Item;
  canSteer: boolean;
  blocked: boolean;
  onEdit: () => void;
  onUpdate: (update: QueueUpdate) => void;
}) {
  function update(change: QueueUpdate) {
    if (!blocked) onUpdate(change);
  }

  return <div className="queue-actions" role="group" aria-label="Queued message actions">
    {canSteer && item.delivery === 'follow-up' && <button className="icon-button queue-action-steer" type="button"
      aria-label="Steer current run" title="Steer current run" aria-disabled={blocked || undefined}
      onClick={() => update({ action: 'steer' })}>Steer</button>}
    <button className="icon-button queue-action-edit" type="button"
      aria-label="Edit message" title="Edit message" aria-disabled={blocked || undefined}
      onClick={() => { if (!blocked) onEdit(); }}>
      <Icon name="edit" />
    </button>
    {(before || after) && <>
      <button className="icon-button" type="button" aria-label="Move up" title="Move up"
        aria-disabled={blocked || !before || undefined} tabIndex={before ? undefined : -1}
        onClick={() => before && update({ action: 'move', targetId: before.id, position: 'before' })}>
        <Icon name="arrowUp" />
      </button>
      <button className="icon-button" type="button" aria-label="Move down" title="Move down"
        aria-disabled={blocked || !after || undefined} tabIndex={after ? undefined : -1}
        onClick={() => after && update({ action: 'move', targetId: after.id, position: 'after' })}>
        <Icon name="arrowDown" />
      </button>
    </>}
    <button className="icon-button queue-action-delete" type="button"
      aria-label="Delete message" title="Delete message" aria-disabled={blocked || undefined}
      onClick={() => update({ action: 'remove' })}>
      <Icon name="trash" />
    </button>
  </div>;
}

export function QueuedMessages({ selection, items = [], canSteer, enabled, onFocusComposer }: {
  selection: Selection;
  items?: ChatView['queued'];
  canSteer: boolean;
  enabled: boolean;
  onFocusComposer: () => void;
}) {
  const [editing, setEditing] = useState<Edit>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const editor = useRef<HTMLFormElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const restore = useRef<{ id: number; removed?: number; steered?: true } | undefined>(undefined);
  // A steer enters the current run at its next boundary. Follow-ups wait for the run's end.
  const ordered = items.toSorted((left, right) => Number(right.delivery === 'steer') - Number(left.delivery === 'steer'));
  const missing = editing !== undefined && !items.some(({ id }) => id === editing.id);

  useLayoutEffect(() => {
    const focus = restore.current;
    if (!focus || editing || items.some(({ id, delivery }) => id === focus.removed
      || (focus.steered && canSteer && id === focus.id && delivery === 'follow-up'))) return;
    const target = list.current?.querySelector<HTMLButtonElement>(`[data-queue-id="${focus.id}"] .queue-action-edit`);
    restore.current = undefined;
    if (document.activeElement !== document.body) return;
    if (target) target.focus({ preventScroll: true });
    else onFocusComposer();
  }, [canSteer, editing, items, onFocusComposer]);

  async function run<T>(action: () => Promise<T>, complete?: (result: T) => void) {
    if (!enabled || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await action();
      complete?.(result);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function update(id: number, change: QueueUpdate, complete?: () => void) {
    void run(async () => {
      if (change.action === 'steer') restore.current = { id, steered: true };
      if (change.action === 'remove') {
        const index = ordered.findIndex((item) => item.id === id);
        restore.current = { id: ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? id, removed: id };
      }
      try {
        await window.pideck.invoke('chat:queue-update', { ...selection, id, ...change });
      } catch (cause) {
        if (restore.current?.removed === id || (restore.current?.id === id && restore.current.steered)) restore.current = undefined;
        throw cause;
      }
    }, complete);
  }

  function startEdit(id: number) {
    void run(() => window.pideck.invoke('chat:queue-read', { ...selection, id }), ({ text, hasImages }) => {
      setEditing({ id, text, original: text, hasImages });
    });
  }

  function closeEditor(id: number) {
    if (editor.current?.contains(document.activeElement) || document.activeElement === document.body) restore.current = { id };
    setEditing(undefined);
    setError(undefined);
  }

  function renderEditor(edit: Edit) {
    const canSave = enabled && !pending && !missing && edit.text !== edit.original
      && (Boolean(edit.text.trim()) || edit.hasImages);
    function save() {
      if (canSave) update(edit.id, { action: 'edit', text: edit.text }, () => closeEditor(edit.id));
    }
    return <form className="queue-editor" ref={editor} onSubmit={(event) => { event.preventDefault(); save(); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && !pending) {
          event.preventDefault();
          event.stopPropagation();
          closeEditor(edit.id);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      }}>
      <textarea autoFocus aria-label="Edit queued message" placeholder="Edit queued message…" rows={2} maxLength={200000}
        value={edit.text} readOnly={missing || pending} onChange={(event) => {
          setEditing({ ...edit, text: event.target.value });
        }} />
      <div className="queue-editor-footer">
        {missing ? <span role="status">This message has left the queue.</span>
          : edit.hasImages && <span>Includes image attachments</span>}
        <button className="button" type="button" disabled={pending} onClick={() => closeEditor(edit.id)}>
          {missing ? 'Close' : 'Cancel'}
        </button>
        {!missing && <button className="button button--primary" type="submit" disabled={!canSave}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>}
      </div>
    </form>;
  }

  if (!ordered.length && !editing && !error) return null;

  const rows = ordered.map((item, index) => {
    const previous = ordered[index - 1];
    const following = ordered[index + 1];
    return <li key={item.id} data-queue-id={item.id} data-delivery={item.delivery}>
      {editing?.id === item.id ? renderEditor(editing) : <div className="queued-row">
        {item.delivery === 'steer' && <span className="queued-mode">Steering</span>}
        <span className="queued-preview" title={item.preview}>{item.preview}</span>
        <QueueActions item={item} before={previous?.delivery === item.delivery ? previous : undefined}
          after={following?.delivery === item.delivery ? following : undefined}
          canSteer={canSteer} blocked={!enabled || pending || Boolean(editing)} onEdit={() => startEdit(item.id)}
          onUpdate={(change) => update(item.id, change)} />
      </div>}
    </li>;
  });
  if (missing) rows.push(<li key={editing.id} data-queue-id={editing.id}>{renderEditor(editing)}</li>);

  return <div className="queued-messages">
    {rows.length > 0 && <>
      <div className="queued-heading" aria-hidden="true">Queued messages <span>{ordered.length}</span></div>
      <ol className="queued-list" aria-label="Queued messages" ref={list}>
        {rows}
      </ol>
    </>}
    {error && <div className="notice composer-notice" role="alert">
      <Icon name="alert" /><span>{error}</span>
      <button className="icon-button" type="button" aria-label="Dismiss queue error" onClick={() => setError(undefined)}>
        <Icon name="close" />
      </button>
    </div>}
  </div>;
}
