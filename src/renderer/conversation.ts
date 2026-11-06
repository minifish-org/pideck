import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { applyImmutable } from '@earendil-works/chord/delta';
import type { ChatGap, ChatView, Selection } from '../shared/api';
import type { ReadingPosition } from './preferences';

export function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

type Conversation = { view: ChatView | null; watchId?: string; connected: boolean; error: string | null };
type Watch = { id: string; sequence: number; view: ChatView | null; requested: Promise<void> };

export function useConversation({ projectId, sessionId }: Selection, readingPosition: RefObject<ReadingPosition | undefined>) {
  const [conversation, setConversation] = useState<Conversation>({ view: null, connected: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const activeWatch = useRef<Watch | null>(null);

  useEffect(() => {
    let disposed = false;
    let repairingGap = false;
    let subscription: Watch | undefined;
    const api = window.pideck;

    function detach() {
      const previous = subscription;
      subscription = undefined;
      activeWatch.current = null;
      if (!previous) return;
      // The watch request may still be reaching the host. Release its ID after registration settles.
      void previous.requested.catch(() => undefined)
        .then(() => api.invoke('chat:unwatch', { subscriptionId: previous.id }))
        .catch(() => undefined);
    }

    function disconnect(message: string) {
      detach();
      setConversation((current) => ({ ...current, connected: false, error: message }));
    }

    function attach() {
      detach();
      setConversation((current) => ({ ...current, connected: false, error: null }));
      const id = crypto.randomUUID();
      const readingEntryId = readingPosition.current?.entryId;
      const requested = api.invoke('chat:watch', { projectId, sessionId, subscriptionId: id, readingEntryId });
      subscription = { id, sequence: 0, view: null, requested };
      void requested.catch((error: unknown) => {
        if (disposed || subscription?.id !== id) return;
        disconnect(readableError(error));
      });
    }

    function repair() {
      if (repairingGap) {
        disconnect('Conversation updates arrived out of order.');
      } else {
        repairingGap = true;
        attach();
      }
    }

    const unsubscribe = api.onEvent((event) => {
      if (disposed) return;
      if (event.type === 'host:disconnected') {
        disconnect(event.message);
        return;
      }
      if (event.type === 'host:restart'
        || (event.type === 'chat:reset' && event.projectId === projectId && event.sessionId === sessionId)) {
        repairingGap = false;
        attach();
        return;
      }
      if ((event.type !== 'chat:update' && event.type !== 'chat:error')
        || !subscription || event.subscriptionId !== subscription.id
        || event.projectId !== projectId || event.sessionId !== sessionId) return;
      if (event.type === 'chat:error') {
        disconnect(event.message);
        return;
      }
      if (event.sequence <= subscription.sequence) return;
      if (event.sequence !== subscription.sequence + 1) {
        repair();
        return;
      }

      try {
        const view = 'view' in event ? event.view
          : subscription.view && applyImmutable(subscription.view, event.ops);
        if (!view) { repair(); return; }
        repairingGap = false;
        subscription.sequence = event.sequence;
        subscription.view = view;
        activeWatch.current = subscription;
        setConversation({ view, watchId: subscription.id, connected: true, error: null });
      } catch {
        repair();
      }
    });

    attach();
    return () => {
      disposed = true;
      unsubscribe();
      detach();
    };
  }, [projectId, sessionId, attempt, readingPosition]);

  async function loadEarlier(gap?: ChatGap) {
    const watch = activeWatch.current;
    if (!watch) throw new Error('Reconnect to load conversation history.');
    await window.pideck.invoke('chat:earlier', {
      projectId, sessionId, subscriptionId: watch.id,
      ...(gap ? { gap: { after: gap.after, upTo: gap.upTo } } : {}),
    });
  }

  return { ...conversation, loadEarlier, retry: () => setAttempt((current) => current + 1) };
}
