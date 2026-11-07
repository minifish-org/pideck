import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import type { ChatView, QueueUpdate, Selection } from '../shared/api';
import { readableError } from './conversation';
import { Icon } from './Icons';
import type { Draft, QueuedDraftEdit, RecoveredDraft } from './preferences';

type Item = NonNullable<ChatView['queued']>[number];
type Move = Extract<QueueUpdate, { action: 'move' }>;
type Drop = Pick<Move, 'targetId' | 'position'>;

function QueueActions({ item, canSteer, canEdit, blocked, onEdit, onUpdate }: {
  item: Item;
  canSteer: boolean;
  canEdit: boolean;
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
      aria-label="Edit message" title={canEdit ? 'Edit message' : 'Finish the current edit first'} aria-disabled={blocked || !canEdit || undefined}
      onClick={() => { if (!blocked && canEdit) onEdit(); }}>
      <Icon name="edit" />
    </button>
    <button className="icon-button queue-action-delete" type="button"
      aria-label="Delete message" title="Delete message" aria-disabled={blocked || undefined}
      onClick={() => update({ action: 'remove' })}>
      <Icon name="trash" />
    </button>
  </div>;
}

export function QueuedMessages({ selection, items = [], canSteer, enabled, editingId, onEdit, onFocusComposer }: {
  selection: Selection;
  items?: ChatView['queued'];
  canSteer: boolean;
  enabled: boolean;
  editingId?: number;
  onEdit: (edit: QueuedDraftEdit) => void;
  onFocusComposer: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [drag, setDrag] = useState<{ id: number; over?: Drop }>();
  const dragSource = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const list = useRef<HTMLOListElement>(null);
  const restore = useRef<{ id: number; removed?: number; steered?: true; move?: Drop } | undefined>(undefined);
  // A steer enters the current run at its next boundary. Follow-ups wait for the run's end.
  const ordered = items.toSorted((left, right) => Number(right.delivery === 'steer') - Number(left.delivery === 'steer'));
  const canReorder = enabled && !pending;

  function clearDrag() {
    dragSource.current = undefined;
    setDrag(undefined);
  }

  useLayoutEffect(() => {
    if (dragSource.current !== undefined && (!canReorder || !items.some(({ id }) => id === dragSource.current))) clearDrag();
  }, [canReorder, items]);

  useLayoutEffect(() => {
    const focus = restore.current;
    if (!focus || items.some(({ id, delivery }) => id === focus.removed
      || (focus.steered && canSteer && id === focus.id && delivery === 'follow-up'))) return;
    if (focus.move) {
      const from = items.findIndex(({ id }) => id === focus.id);
      const to = items.findIndex(({ id }) => id === focus.move?.targetId);
      if (from >= 0 && to >= 0 && (from < to) !== (focus.move.position === 'before')) return;
    }
    const row = list.current?.querySelector(`[data-queue-id="${focus.id}"]`);
    const target = (focus.move && row?.querySelector<HTMLElement>('.queued-message[tabindex]'))
      || row?.querySelector<HTMLElement>(editingId === undefined ? '.queue-action-edit' : '.queue-actions button:not([aria-disabled="true"])');
    restore.current = undefined;
    if (document.activeElement === document.body) {
      if (target) target.focus({ preventScroll: !focus.move });
      else onFocusComposer();
    } else if (focus.move && target && target === document.activeElement) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [canSteer, editingId, items, onFocusComposer]);

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
        if (restore.current?.removed === id || restore.current?.id === id) restore.current = undefined;
        throw cause;
      }
    }, complete);
  }

  function dropAt(event: DragEvent<HTMLOListElement>): Drop | undefined {
    if (!canReorder || busy.current || !(event.target instanceof Element)) return;
    const source = ordered.findIndex(({ id }) => id === dragSource.current);
    if (source < 0) return;
    // A drop on the insertion line can land in the gap between rows.
    const row = event.target.closest('[data-queue-id]')
      ?? Array.from(event.currentTarget.children).find(child => event.clientY < child.getBoundingClientRect().bottom)
      ?? event.currentTarget.lastElementChild;
    const target = ordered.findIndex(({ id }) => id === Number(row?.getAttribute('data-queue-id')));
    if (!row || source === target || ordered[source].delivery !== ordered[target]?.delivery) return;
    const bounds = row.getBoundingClientRect();
    const before = event.clientY < bounds.top + bounds.height / 2;
    if (source === target + (before ? -1 : 1)) return;
    return { targetId: ordered[target].id, position: before ? 'before' : 'after' };
  }

  function startEdit(id: number) {
    void run(() => window.pideck.invoke('chat:queue-read', { ...selection, id }), ({ text, hasImages }) => {
      onEdit({ id, text, original: text, hasImages });
    });
  }

  if (!ordered.length && !error) return null;

  const rows = ordered.map((item, index) => {
    const previous = ordered[index - 1]?.delivery === item.delivery ? ordered[index - 1] : undefined;
    const following = ordered[index + 1]?.delivery === item.delivery ? ordered[index + 1] : undefined;
    const hasPeers = Boolean(previous || following);
    const editing = editingId === item.id;
    const draggable = hasPeers && canReorder && !editing;
    return <li key={item.id} data-queue-id={item.id} data-delivery={item.delivery}
      data-dragging={drag?.id === item.id || undefined} data-drop={drag?.over?.targetId === item.id ? drag.over.position : undefined}>
      {editing ? <div className="queued-edit-marker" role="status" aria-label="Editing queued message" title="Editing in the message box">
        <Icon name="edit" width={13} height={13} /><span>Editing</span>
      </div> : <div className="queued-row">
        <div className="queued-message" draggable={draggable} tabIndex={hasPeers ? 0 : undefined}
          title={draggable ? `${item.preview}\nDrag to reorder` : item.preview}
          aria-keyshortcuts={hasPeers ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onDragStart={(event) => {
            if (event.target !== event.currentTarget) return;
            if (!draggable || busy.current) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-pideck-queue-message', '');
            dragSource.current = item.id;
            setDrag({ id: item.id });
          }}
          onDragEnd={() => { if (dragSource.current === item.id) clearDrag(); }}
          onKeyDown={(event) => {
            if (!draggable || busy.current || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
              || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const up = event.key === 'ArrowUp';
            const peer = up ? previous : following;
            if (!peer) return;
            const move: Drop = { targetId: peer.id, position: up ? 'before' : 'after' };
            restore.current = { id: item.id, move };
            update(item.id, { action: 'move', ...move });
          }}>
          {item.delivery === 'steer' && <span className="queued-mode">Steering</span>}
          <span className="queued-preview">{item.preview}</span>
        </div>
        <QueueActions item={item}
          canSteer={canSteer} canEdit={editingId === undefined} blocked={!enabled || pending} onEdit={() => startEdit(item.id)}
          onUpdate={(change) => update(item.id, change)} />
      </div>}
    </li>;
  });

  return <div className="queued-messages">
    {rows.length > 0 && <>
      <div className="queued-heading" aria-hidden="true">Queued messages <span>{ordered.length}</span></div>
      <ol className="queued-list" aria-label="Queued messages" ref={list}
        onDragOver={(event) => {
          const id = dragSource.current;
          if (id === undefined) return;
          const over = dropAt(event);
          event.dataTransfer.dropEffect = over ? 'move' : 'none';
          if (over) event.preventDefault();
          setDrag(current => current?.over?.targetId === over?.targetId && current?.over?.position === over?.position
            ? current : { id, over });
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDrag(current => current?.over ? { id: current.id } : current);
        }}
        onDrop={(event) => {
          const id = dragSource.current;
          if (id === undefined) return;
          event.preventDefault();
          const over = dropAt(event);
          clearDrag();
          if (over) update(id, { action: 'move', ...over });
        }}>
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

function draftPreview(draft: Pick<Draft, 'text' | 'attachments'>) {
  const text = draft.text.replace(/\s+/g, ' ').trim();
  return text ? text.length > 100 ? `${text.slice(0, 100)}…` : text
    : draft.attachments.length ? `${draft.attachments.length} image${draft.attachments.length === 1 ? '' : 's'}` : 'Empty draft';
}

function draftLabel(kind: RecoveredDraft['kind']) {
  return kind === 'queue-edit' ? 'Unsent queue edit' : kind === 'draft' ? 'Unsent draft' : 'Saved draft';
}

export function DraftRecoveryPicker({ current, items, disabled, onRestore }: {
  current: Pick<Draft, 'text' | 'attachments'>;
  items: RecoveredDraft[];
  disabled: boolean;
  onRestore: (index: number) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open]);

  return <>
    <button className="icon-button queue-restore" type="button" ref={trigger} aria-label="Restore saved draft"
      title={`Choose a saved draft (${items.length}); your current draft is kept`} popoverTarget={id}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onKeyDown={event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (panel.current?.matches(':popover-open')) panel.current.querySelector<HTMLButtonElement>('button')?.focus();
        else event.currentTarget.click();
      }}><Icon name="restore" /></button>
    <div className="chat-popover draft-recovery-popover" id={id} ref={panel} popover="auto" role="dialog" aria-label="Saved drafts"
      onToggle={event => setOpen(event.newState === 'open')}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && event.relatedTarget !== trigger.current
          && !event.currentTarget.contains(event.relatedTarget) && event.currentTarget.matches(':popover-open')) {
          event.currentTarget.hidePopover();
        }
      }} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          panel.current?.hidePopover();
          trigger.current?.focus();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        if (!choices.length || index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        choices[next]?.focus();
      }}>
      {open && <>
        <div className="draft-recovery-current" role="group" aria-label="Current draft">
          <span className="draft-recovery-kind">Current draft</span>
          <span className="draft-recovery-preview">{draftPreview(current)}</span>
          {current.text.trim() && current.attachments.length > 0 && <small>{current.attachments.length} image{current.attachments.length === 1 ? '' : 's'}</small>}
        </div>
        <ul className="draft-recovery-list" aria-label="Available drafts">
          {items.map((item, index) => <li key={index}>
            <button type="button" className="draft-recovery-option" aria-label={`Restore ${draftLabel(item.kind).toLowerCase()}: ${draftPreview(item)}`}
              title={item.text.slice(0, 1000) || draftPreview(item)} onClick={() => {
                panel.current?.hidePopover();
                onRestore(index);
              }}>
              <span className="draft-recovery-kind"><Icon name={item.kind === 'queue-edit' ? 'edit' : 'file'} width={12} height={12} />{draftLabel(item.kind)}</span>
              <span className="draft-recovery-preview">{draftPreview(item)}</span>
              {item.text.trim() && item.attachments.length > 0 && <small>{item.attachments.length} image{item.attachments.length === 1 ? '' : 's'}</small>}
            </button>
          </li>)}
        </ul>
      </>}
    </div>
  </>;
}
