import type { Thinking } from '../shared/api';

const key = (projectId: string) => `pideck.thinking.v1/${projectId}`;
const levels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function readProjectThinking(projectId: string): Thinking | undefined {
  try {
    const value = localStorage.getItem(key(projectId));
    return value && levels.includes(value) ? value as Thinking : undefined;
  } catch { return undefined; }
}

export function saveProjectThinking(projectId: string, level: Thinking): void {
  try { localStorage.setItem(key(projectId), level); } catch { /* Preferences are optional. */ }
}

export function defaultThinking(supported: readonly Thinking[], preferred?: Thinking): Thinking {
  if (preferred && supported.includes(preferred)) return preferred;
  return supported.includes('medium') ? 'medium' : supported.includes('off') ? 'off' : supported[0] ?? 'off';
}
