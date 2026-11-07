import { useSyncExternalStore } from 'react';
import type { AppearanceState } from '../shared/api';

const root = document.documentElement;
const initialDark = root.dataset.colorMode === 'dark'
  || (root.dataset.colorMode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
let current: AppearanceState = { preference: 'system', resolved: initialDark ? 'dark' : 'light' };
const listeners = new Set<() => void>();

function apply(appearance: AppearanceState) {
  const changed = current.resolved !== appearance.resolved;
  current = appearance;
  root.dataset.colorMode = appearance.resolved;
  root.dataset.lightTheme = 'light';
  root.dataset.darkTheme = 'dark';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', appearance.resolved);
  if (changed) for (const listener of listeners) listener();
}

export async function initializeAppearance() {
  const api = window.pideck;
  if (!api) return apply(current);
  api.onEvent(event => {
    if (event.type === 'appearance:changed') apply(event.appearance);
  });
  try {
    apply(await api.invoke('appearance:get'));
  } catch {
    // The document's initial palette remains usable if desktop startup is interrupted.
    apply(current);
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => current.resolved;

export function useAppearance() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
