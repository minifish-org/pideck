import { useEffect, useState, type RefObject } from 'react';
import type { ChatView, SessionActivity } from '../shared/api';

export const activityLabels = {
  running: 'Running',
  finished: 'Finished',
  attention: 'Needs attention',
} satisfies Record<SessionActivity['state'], string>;

export function useSessionActivity() {
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
  return items;
}

export function useReadSessionActivity(activity: SessionActivity | undefined, view: ChatView | null,
  scroll: RefObject<HTMLDivElement | null>) {
  const settledView = activity?.settled && view?.status === 'idle' ? view : null;
  useEffect(() => {
    if (!activity || !settledView) return;
    const viewport = scroll.current;
    const thread = viewport?.querySelector('.chat-thread');
    if (!viewport || !thread) return;
    const { projectId, sessionId, taskId, state, resultEntryId } = activity;
    let result: Element | null = thread;
    if (state === 'attention') {
      if (settledView.failureTaskId !== taskId) return;
      result = thread.querySelector('.chat-run-error');
    } else if (resultEntryId !== undefined) {
      result = thread.querySelector(`[data-reading-entry="${resultEntryId}"]`);
      // A committed empty answer has an entry, but no visible message.
      if (!result && settledView.latestEntryId === resultEntryId) result = thread;
    }
    if (!result) return;
    const target = result;
    let frame = 0;
    let sent = false;
    function check() {
      frame = 0;
      if (sent || !document.hasFocus() || document.visibilityState !== 'visible' || !viewport?.clientHeight) return;
      const bounds = viewport.getBoundingClientRect();
      const end = target.getBoundingClientRect().bottom;
      if (end <= bounds.top || end > bounds.bottom + 1) return;
      sent = true;
      void window.pideck.invoke('session:read-activity', { projectId, sessionId, taskId }).catch(() => { sent = false; });
    }
    function schedule() {
      if (!sent && !frame) frame = requestAnimationFrame(check);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(thread);
    viewport.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [activity, scroll, settledView]);
}
