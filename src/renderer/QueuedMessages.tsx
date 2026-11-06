import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
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
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  const position = useCallback(() => {
    const button = trigger.current;
    const menu = popover.current;
    if (!button || !menu?.matches(':popover-open')) return;
    const anchor = button.getBoundingClientRect();
    const visible = button.closest('.queued-list')?.getBoundingClientRect();
    if (visible && (anchor.top >= visible.bottom || anchor.bottom <= visible.top)) {
      menu.hidePopover();
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const gap = 4;
    const inset = 8;
    const above = anchor.top - inset - gap;
    const below = document.documentElement.clientHeight - anchor.bottom - inset - gap;
    const y = above >= height || above >= below ? anchor.top - gap - height : anchor.bottom + gap;
    const x = anchor.right - width;
    menu.style.left = `${Math.max(inset, Math.min(x, document.documentElement.clientWidth - inset - width))}px`;
    menu.style.top = `${Math.max(inset, Math.min(y, document.documentElement.clientHeight - inset - height))}px`;
    menu.dataset.positioned = 'true';
  }, []);

  useLayoutEffect(position);
  useLayoutEffect(() => {
    if (!open) return;
    const menu = popover.current;
    if (!menu) return;
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    const chat = trigger.current?.closest('.chat');
    if (chat) observer.observe(chat);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  function activate(action: () => void) {
    if (blocked) return;
    popover.current?.hidePopover();
    action();
  }

  return <>
    <button className="icon-button queue-actions-trigger" type="button" ref={trigger}
      aria-label="Queued message actions" title="Queued message actions" aria-disabled={blocked || undefined} popoverTarget={id}
      onClick={(event) => { if (blocked) event.preventDefault(); }}>
      <Icon name="more" width={15} height={15} />
    </button>
    <div id={id} ref={popover} className="chat-popover queue-popover" popover="auto"
      role="group" aria-label="Queued message actions"
      onToggle={(event) => {
        const next = event.newState === 'open';
        setOpen(next);
        if (next) {
          position();
          event.currentTarget.querySelector('button')?.focus({ preventScroll: true });
        } else {
          delete event.currentTarget.dataset.positioned;
        }
      }}
      onBlur={(event) => {
        const { currentTarget, relatedTarget } = event;
        if (relatedTarget instanceof Node && relatedTarget !== trigger.current
          && !currentTarget.contains(relatedTarget) && currentTarget.matches(':popover-open')) {
          currentTarget.hidePopover();
        }
      }}
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const actions = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const at = actions.findIndex(button => button === document.activeElement);
        if (at < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1
          : (at + (event.key === 'ArrowUp' ? actions.length - 1 : 1)) % actions.length;
        actions[next]?.focus({ preventScroll: true });
      }}>
      {canSteer && item.delivery === 'follow-up' && <button type="button" disabled={blocked}
        onClick={() => activate(() => onUpdate({ action: 'steer' }))}>Steer current run</button>}
      <button type="button" disabled={blocked} onClick={() => activate(onEdit)}>Edit message</button>
      {before && <button type="button" disabled={blocked}
        onClick={() => activate(() => onUpdate({ action: 'move', targetId: before.id, position: 'before' }))}>Move up</button>}
      {after && <button type="button" disabled={blocked}
        onClick={() => activate(() => onUpdate({ action: 'move', targetId: after.id, position: 'after' }))}>Move down</button>}
      <button type="button" className="queue-action-danger" disabled={blocked}
        onClick={() => activate(() => onUpdate({ action: 'remove' }))}>Delete message</button>
    </div>
  </>;
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
  const restore = useRef<{ id: number; removed?: number } | undefined>(undefined);
  // A steer enters the current run at its next boundary. Follow-ups wait for the run's end.
  const ordered = items.toSorted((left, right) => Number(right.delivery === 'steer') - Number(left.delivery === 'steer'));
  const missing = editing !== undefined && !items.some(({ id }) => id === editing.id);

  useLayoutEffect(() => {
    const focus = restore.current;
    if (!focus || editing || items.some(({ id }) => id === focus.removed)) return;
    const target = list.current?.querySelector<HTMLButtonElement>(`[data-queue-id="${focus.id}"] .queue-actions-trigger`);
    restore.current = undefined;
    if (document.activeElement !== document.body) return;
    if (target) target.focus({ preventScroll: true });
    else onFocusComposer();
  }, [editing, items, onFocusComposer]);

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
      if (change.action === 'remove') {
        const index = ordered.findIndex((item) => item.id === id);
        restore.current = { id: ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? id, removed: id };
      }
      try {
        await window.pideck.invoke('chat:queue-update', { ...selection, id, ...change });
      } catch (cause) {
        if (restore.current?.removed === id) restore.current = undefined;
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
    if (editor.current?.contains(document.activeElement)) restore.current = { id };
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
