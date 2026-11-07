import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppearancePreference, AppearanceState } from "../shared/api";

type NativeAppearance = {
  themeSource: AppearancePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
};

function preference(value: unknown): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

async function initialPreference(file: string, directory: string): Promise<AppearancePreference> {
  try {
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    if (saved && typeof saved === "object" && "preference" in saved && preference(saved.preference)) return saved.preference;
  } catch {
    // Missing or damaged appearance preferences use the profile's initial choice.
  }
  try {
    await access(join(directory, "workspace.sqlite"));
    return "dark";
  } catch {
    return "system";
  }
}

export async function openAppearance(directory: string, native: NativeAppearance) {
  const file = join(directory, "appearance.json");
  const temporary = file + ".tmp";
  let selected = await initialPreference(file, directory);
  let writing = Promise.resolve();
  const listeners = new Set<(state: AppearanceState) => void>();
  native.themeSource = selected;
  const resolve = (): AppearanceState => ({ preference: selected,
    resolved: selected === "system" ? native.shouldUseDarkColors ? "dark" : "light" : selected });
  let state = resolve();

  function refresh() {
    const next = resolve();
    if (state.preference === next.preference && state.resolved === next.resolved) return;
    state = next;
    for (const listener of listeners) listener({ ...state });
  }

  function persist() {
    const next = selected;
    writing = writing.then(async () => {
      try {
        await writeFile(temporary, JSON.stringify({ preference: next }), { mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    return writing;
  }

  // Save the initial choice before opening the workspace: a new profile becomes
  // an existing profile on its next launch, even without a manual menu choice.
  native.on("updated", refresh);
  await persist();
  return {
    get: () => ({ ...state }),
    set(next: AppearancePreference) {
      if (next === selected) return writing;
      selected = next;
      native.themeSource = next;
      refresh();
      return persist();
    },
    subscribe(listener: (state: AppearanceState) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    flush: () => writing,
    dispose() {
      native.removeListener("updated", refresh);
      listeners.clear();
    },
  };
}

export function appearanceBackground(state: AppearanceState) {
  return state.resolved === "dark" ? "#0d1117" : "#ffffff";
}

export function appearanceDocument(html: string, state: AppearanceState) {
  return html.replace(/<html\b[^>]*>/i, opening => opening
    .replace(/\sdata-(?:color-mode|light-theme|dark-theme)=(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/>$/, ` data-color-mode="${state.resolved}" data-light-theme="light" data-dark-theme="dark">`))
    .replace(/(<meta\b(?=[^>]*\bname=["']color-scheme["'])[^>]*\bcontent=["'])[^"']*(["'][^>]*>)/i,
      `$1${state.resolved}$2`);
}
