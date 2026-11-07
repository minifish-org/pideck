import type { ImageInput, Thinking } from '../shared/api';

export type ReadingPosition = { messageId: string; entryId: number; offset: number };

type Preferences = {
  projectId?: string;
  sessions: Record<string, string>;
  navigation: boolean;
  navigationWidth?: number;
  model?: string;
  reading: Record<string, Record<string, ReadingPosition>>;
  reviewPaths: Record<string, string>;
};

const preferenceKey = 'pideck.workspace.v1';
const draftKey = 'pideck.draft.v1/';
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxDraftLength = 200000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validPosition(value: unknown): value is ReadingPosition {
  const { messageId, entryId, offset } = record(value);
  return typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 120
    && typeof entryId === 'number' && Number.isSafeInteger(entryId) && entryId > 0
    && typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 10_000_000;
}

export function readPreferences(): Preferences {
  const defaults: Preferences = { sessions: {}, navigation: true, reading: {}, reviewPaths: {} };
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null') as Partial<Preferences> | null;
    if (!value || typeof value !== 'object') return defaults;
    const sessions = value.sessions && typeof value.sessions === 'object'
      ? Object.fromEntries(Object.entries(value.sessions).filter(([, id]) => typeof id === 'string'))
      : {};
    return {
      projectId: typeof value.projectId === 'string' ? value.projectId : undefined,
      sessions,
      navigation: value.navigation !== false,
      navigationWidth: typeof value.navigationWidth === 'number' && Number.isFinite(value.navigationWidth)
        && value.navigationWidth >= 180 && value.navigationWidth <= 400 ? value.navigationWidth : undefined,
      model: typeof value.model === 'string' ? value.model : undefined,
      reading: Object.fromEntries(Object.entries(record(value.reading))
        .filter(([id]) => identifier.test(id))
        .map(([id, sessions]) => [id, Object.fromEntries(Object.entries(record(sessions))
          .filter((item): item is [string, ReadingPosition] => identifier.test(item[0]) && validPosition(item[1])))])),
      reviewPaths: Object.fromEntries(Object.entries(record(value.reviewPaths))
        .filter((item): item is [string, string] => identifier.test(item[0])
          && typeof item[1] === 'string' && item[1].length > 0 && item[1].length <= 4096)),
    };
  } catch {
    return defaults;
  }
}

export function savePreferences(value: Preferences) {
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(value));
  } catch {
    // The workspace still works when local preferences are unavailable.
  }
}

export type Attachment = ImageInput & { name: string };
export type SendAttempt = { text: string; attachments: Attachment[]; requestId: string };
export type QueuedDraftEdit = { id: number; token: string; text: string; original: string; hasImages: boolean };

export type Draft = {
  text: string;
  attachments: Attachment[];
  pendingRequestId?: string;
  model?: string;
  thinking?: Thinking;
  attempt?: SendAttempt;
  sending?: boolean;
  reading?: boolean;
  error?: string;
  queueEdit?: QueuedDraftEdit;
};

export const emptyDraft: Draft = { text: '', attachments: [] };
export const newSessionDraft = 'draft';

type Drafts = Record<string, Record<string, Draft>>;

// A stopped run or an expired editor can leave unsaved text. Keep it in the
// ordinary message box instead of introducing another list of drafts.
export function retainQueueEditText(draft: Draft): Draft {
  const edit = draft.queueEdit;
  if (!edit) return draft;
  const next = { ...draft, queueEdit: undefined, error: undefined };
  if (edit.text === edit.original || !edit.text.trim()) return next;
  return { ...next, text: draft.text === edit.text ? draft.text : [draft.text, edit.text].filter(Boolean).join('\n\n'), pendingRequestId: undefined };
}

export function completeAttempt(draft: Draft, attempt: SendAttempt): Draft {
  if (draft.attempt?.requestId !== attempt.requestId) return draft;
  const unchanged = draft.text === attempt.text && draft.attachments === attempt.attachments;
  return {
    ...draft,
    text: unchanged ? '' : draft.text,
    attachments: unchanged ? [] : draft.attachments,
    attempt: undefined,
    pendingRequestId: undefined,
    sending: false,
    error: undefined,
  };
}

export function acceptStartedDraft(drafts: Drafts, projectId: string, sessionId: string): Drafts {
  const project = drafts[projectId];
  const draft = project?.[newSessionDraft];
  if (!draft || (draft.attempt?.requestId ?? draft.pendingRequestId) !== sessionId) return drafts;
  const remaining = without(project, newSessionDraft);
  if (draft.attempt) {
    const next = completeAttempt(draft, draft.attempt);
    // Text typed during the first send is the new session's next draft.
    if (next.text) remaining[sessionId] = { ...next, attachments: [] };
  }
  return Object.keys(remaining).length ? { ...drafts, [projectId]: remaining } : without(drafts, projectId);
}

export function readDrafts(): Drafts {
  const drafts: Drafts = {};
  try {
    const keys = new Set<string>();
    for (const storage of [() => localStorage, () => sessionStorage]) {
      try { for (const key of Object.keys(storage())) keys.add(key); } catch { /* Storage is optional. */ }
    }
    for (const key of keys) {
      if (!key.startsWith(draftKey)) continue;
      const [projectId, sessionId, extra] = key.slice(draftKey.length).split('/');
      if (!projectId || !sessionId || extra !== undefined || !identifier.test(projectId)
        || (sessionId !== newSessionDraft && !identifier.test(sessionId))) continue;
      try {
        let saved: Record<string, unknown> = {};
        let savedWindowEdit: unknown;
        try { saved = record(JSON.parse(localStorage.getItem(key) ?? 'null')); } catch { /* Keep the window editor. */ }
        try { savedWindowEdit = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { /* Keep the ordinary draft. */ }
        const { text = '', requestId, queueEdit: savedEdit, recoveredDrafts: savedRecoveries } = saved;
        // Older alternatives may merge into a longer unsent draft. Keep that
        // text across reopening; outgoing messages still have their IPC limit.
        if (typeof text !== 'string') continue;
        const edit = record(savedWindowEdit);
        const queueEdit = Number.isSafeInteger(edit.id) && Number(edit.id) > 0 && typeof edit.token === 'string' && identifier.test(edit.token)
          && typeof edit.text === 'string' && edit.text.length <= maxDraftLength
          && typeof edit.original === 'string' && edit.original.length <= maxDraftLength && typeof edit.hasImages === 'boolean'
          ? edit as QueuedDraftEdit : undefined;
        // Migrate older saved alternatives into visible, unsent text once. Their
        // message identity was never stored, so they cannot reserve queue items.
        const legacyText = Array.isArray(savedRecoveries) ? savedRecoveries.flatMap(value => {
          const { text } = record(value);
          return typeof text === 'string' && text.length > 0 && text.length <= maxDraftLength ? [text] : [];
        }) : [];
        const legacyEdit = record(savedEdit);
        if (typeof legacyEdit.text === 'string' && legacyEdit.text.length <= maxDraftLength
          && legacyEdit.text !== legacyEdit.original) legacyText.push(legacyEdit.text);
        const currentText = [...new Set([text, ...legacyText].filter(Boolean))].join('\n\n');
        if (!currentText && !queueEdit) continue;
        (drafts[projectId] ??= {})[sessionId] = {
          ...emptyDraft, text: currentText,
          pendingRequestId: !legacyText.length && typeof requestId === 'string' && identifier.test(requestId) ? requestId : undefined,
          queueEdit,
        };
      } catch {
        // One corrupt record need not prevent other drafts from reopening.
      }
    }
  } catch {
    // The workspace still works when local preferences are unavailable.
  }
  return drafts;
}

function draftRequestId(draft?: Draft): string | undefined {
  return draft?.attempt && draft.attempt.text === draft.text && draft.attempt.attachments === draft.attachments
    ? draft.attempt.requestId : draft?.pendingRequestId;
}

export function saveDrafts(previous: Drafts, current: Drafts) {
  for (const projectId of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[projectId] ?? {};
    const after = current[projectId] ?? {};
    if (before === after) continue;
    for (const sessionId of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const next = after[sessionId];
      const prior = before[sessionId];
      const requestId = draftRequestId(next);
      if (next?.text === prior?.text && requestId === draftRequestId(prior)
        && next?.queueEdit === prior?.queueEdit) continue;
      const key = `${draftKey}${projectId}/${sessionId}`;
      try {
        if (next?.text) localStorage.setItem(key, JSON.stringify({ text: next.text, requestId }));
        else localStorage.removeItem(key);
      } catch {
        // Keep the in-memory draft when local storage is unavailable or full.
      }
      try {
        // Editing belongs to this window: reloads reconnect the same reservation,
        // while closing the window discards it just like Cancel.
        if (next?.queueEdit) sessionStorage.setItem(key, JSON.stringify(next.queueEdit));
        else sessionStorage.removeItem(key);
      } catch {
        // An unavailable store must not prevent the in-memory editor from working.
      }
    }
  }
}

export function retainKeys<T>(items: Record<string, T>, retain: (key: string) => boolean): Record<string, T> {
  const entries = Object.entries(items);
  const kept = entries.filter(([key]) => retain(key));
  return entries.length === kept.length ? items : Object.fromEntries(kept);
}

export function without<T>(items: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(items, key)) return items;
  const remaining = { ...items };
  delete remaining[key];
  return remaining;
}
