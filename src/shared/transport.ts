import type { Command, Commands, HostEvent, Project, RemovalBlocked, RemovalResult, SessionActivity } from "./api";
import type { Credential } from "@earendil-works/pi-ai";

export const invokeChannel = "pideck:invoke";
export const eventChannel = "pideck:event";
export const menuActionChannel = "pideck:menu-action";
export const menuStateChannel = "pideck:menu-state";

type Forwarded = Exclude<Command, "desktop:ready" | "desktop:context" | "project:open" | "project:remove" | "session:remove" | "clipboard:write" | "appearance:get" | "link:open-external">;
export type RemovalTarget = { projectId: string; sessionId?: string };
export type RemovalPreview = { scope: string; name: string; directory: string; sessionCount: number } & RemovalBlocked;

export type HostCommand =
  | Forwarded
  | "project:add"
  | "removal:plan"
  | "removal:execute"
  | "host:status"
  | "owner:close";
export type HostInput = {
  [C in Forwarded]: Commands[C][0];
} & {
  "project:add": { directory: string };
  "removal:plan": RemovalTarget;
  "removal:execute": RemovalTarget & { scope: string };
  // Navigation retains the window's exclusive edit lease; a real close detaches
  // the lease while keeping the edit and queued inputs held for reopening.
  "owner:close": { preserveQueueEdits?: boolean } | undefined;
  "host:status": undefined;
};
export type HostResult = {
  [C in Exclude<Forwarded, "model:auth-open" | "model:auth-copy">]: Commands[C][1];
} & {
  "model:auth-open": string;
  "model:auth-copy": string;
  "project:add": Project;
  "removal:plan": RemovalPreview;
  "removal:execute": RemovalResult;
  "owner:close": void;
  "host:status": { active: boolean; activities: SessionActivity[]; terminalCount: number };
};
export type HostCloseResult =
  | { status: "graceful" }
  | { status: "forced"; reason: "timeout" | "request-failed"; exited: boolean }
  | { status: "failed"; reason: "cleanup-failed" | "unexpected-exit"; message: string };
export type HostRequest = {
  [C in HostCommand]: { type: "request"; id: number; owner: number; windowId?: number; command: C; payload: HostInput[C] }
}[HostCommand];
export type ToHost =
  | { type: "start"; dataDir: string; hasSavedCredentials: boolean; lifetimeId: string; closedWindows?: readonly number[]; automationDirectory?: string }
  | ({ type: "credential:snapshot"; id: number } & ({ credentials: Record<string, Credential> } | { error: string }))
  | { type: "credential:result"; id: number; error?: string }
  | { type: "shutdown" }
  | { type: "shutdown:exit" }
  | HostRequest;
export type FromHost =
  | { type: "activity"; items: SessionActivity[]; baseline: boolean }
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "shutdown:complete"; error?: string }
  | { type: "result"; id: number; value?: unknown; error?: string }
  | { type: "credential:read"; id: number }
  | { type: "credential:write"; id: number; provider: string; credential: Credential | null }
  | { type: "event"; owner: number; event: HostEvent };
