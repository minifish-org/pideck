import type { ImageInput, SendChat, Thinking } from '../shared/api';

type Preferences = {
  projectId?: string;
  sessions: Record<string, string>;
  navigation: boolean;
  model?: string;
};

const preferenceKey = 'pideck.workspace.v1';

export function readPreferences(): Preferences {
  const defaults: Preferences = { sessions: {}, navigation: true };
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
      model: typeof value.model === 'string' ? value.model : undefined,
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
export type SendAttempt = { text: string; attachments: Attachment[]; input: SendChat & { requestId: string } };

export type Draft = {
  text: string;
  attachments: Attachment[];
  model?: string;
  thinking?: Thinking;
  attempt?: SendAttempt;
  sending?: boolean;
  reading?: boolean;
  error?: string;
};

export const emptyDraft: Draft = { text: '', attachments: [] };

export function without<T>(items: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(items, key)) return items;
  const remaining = { ...items };
  delete remaining[key];
  return remaining;
}
