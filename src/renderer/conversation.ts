import { useEffect, useState } from 'react';
import type { ChatView, Selection } from '../shared/api';

export function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

type Conversation = { view: ChatView | null; connected: boolean; error: string | null };

export function useConversation({ projectId, sessionId }: Selection) {
  const [conversation, setConversation] = useState<Conversation>({ view: null, connected: false, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let repairingGap = false;
    let subscription: { id: string; sequence: number; requested: Promise<void> } | undefined;
    const api = window.pideck;

    function detach() {
      const previous = subscription;
      subscription = undefined;
      if (!previous) return;
      // The watch request may still be reaching the host. Release its ID after registration settles.
      void previous.requested.catch(() => undefined)
        .then(() => api.invoke('chat:unwatch', { subscriptionId: previous.id }))
        .catch(() => undefined);
    }

    function attach() {
      detach();
      setConversation((current) => ({ ...current, connected: false, error: null }));
      const id = crypto.randomUUID();
      const requested = api.invoke('chat:watch', { projectId, sessionId, subscriptionId: id });
      subscription = { id, sequence: 0, requested };
      void requested.catch((error: unknown) => {
        if (disposed || subscription?.id !== id) return;
        detach();
        setConversation((current) => ({ ...current, connected: false, error: readableError(error) }));
      });
    }

    const unsubscribe = api.onEvent((event) => {
      if (disposed) return;
      if (event.type === 'host:restart') {
        repairingGap = false;
        attach();
        return;
      }
      if ((event.type !== 'chat:update' && event.type !== 'chat:error')
        || !subscription || event.subscriptionId !== subscription.id
        || event.projectId !== projectId || event.sessionId !== sessionId) return;
      if (event.type === 'chat:error') {
        detach();
        setConversation((current) => ({ ...current, connected: false, error: event.message }));
        return;
      }
      if (event.sequence <= subscription.sequence) return;
      if (event.sequence !== subscription.sequence + 1) {
        if (repairingGap) {
          detach();
          setConversation((current) => ({
            ...current, connected: false, error: 'Conversation updates arrived out of order.',
          }));
        } else {
          repairingGap = true;
          attach();
        }
        return;
      }

      repairingGap = false;
      subscription.sequence = event.sequence;
      setConversation({ view: event.view, connected: true, error: null });
    });

    attach();
    return () => {
      disposed = true;
      unsubscribe();
      detach();
    };
  }, [projectId, sessionId, attempt]);

  return { ...conversation, retry: () => setAttempt((current) => current + 1) };
}
