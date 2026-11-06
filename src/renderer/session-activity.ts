import { useEffect, useState } from 'react';
import type { SessionActivity } from '../shared/api';

export const activityLabels = {
  running: 'Running',
  finished: 'Finished',
  attention: 'Needs attention',
} satisfies Record<SessionActivity['state'], string>;

export function useSessionActivity(activeSessionId: string | undefined, reading: boolean) {
  const [items, setItems] = useState<Record<string, SessionActivity>>({});
  useEffect(() => {
    const api = window.pideck;
    let subscription: { id: string; requested: Promise<void> } | undefined;

    function detach() {
      const previous = subscription;
      subscription = undefined;
      if (previous) void previous.requested.then(
        () => api.invoke('session:unwatch-activity', { subscriptionId: previous.id }),
      ).catch(() => {});
    }

    function attach() {
      detach();
      const id = crypto.randomUUID();
      const requested = api.invoke('session:watch-activity', { subscriptionId: id });
      subscription = { id, requested };
      void requested.catch(() => { if (subscription?.id === id) setItems({}); });
    }

    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'host:disconnected') {
        detach();
        setItems({});
      } else if (event.type === 'host:restart') attach();
      else if (event.type === 'session:activity' && event.subscriptionId === subscription?.id) {
        setItems(Object.fromEntries(event.items.map(item => [item.sessionId, item])));
      }
    });
    attach();
    return () => {
      unsubscribe();
      detach();
    };
  }, []);

  const active = activeSessionId ? items[activeSessionId] : undefined;
  const projectId = active?.projectId;
  const sessionId = active?.sessionId;
  const taskId = active?.settled ? active.taskId : undefined;
  useEffect(() => {
    if (!reading || !projectId || !sessionId || taskId === undefined) return;
    const receipt = { projectId, sessionId, taskId };
    function markRead() {
      if (document.hasFocus()) void window.pideck.invoke('session:read-activity', receipt).catch(() => {});
    }
    markRead();
    window.addEventListener('focus', markRead);
    return () => window.removeEventListener('focus', markRead);
  }, [reading, projectId, sessionId, taskId]);
  return items;
}
