import { createRequire } from "node:module";
import { join } from "node:path";

export type NativeUpdateEvent =
  | { type: "install-requested" }
  | { type: "menu-changed" }
  | { type: "aborted"; message: string; domain: string; code: number };

export type MacUpdater = {
  start(callback: (event: NativeUpdateEvent) => void): boolean;
  check(): boolean;
  cancelCheck(): boolean;
  status(): "idle" | "checking" | "showing" | "busy";
  canCheck(): boolean;
  resumeInstall(): boolean;
  dispose(): void;
};

// This module is loaded in Electron main only. The renderer never receives an
// updater handle, a feed URL command, or filesystem/installation access.
export function loadMacUpdater(resources: string): MacUpdater {
  const require = createRequire(import.meta.url);
  return require(join(resources, "native", "pideck-sparkle.node")) as MacUpdater;
}
