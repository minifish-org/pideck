import type { Command, Commands, HostEvent, Project, RemovalBlocked, RemovalResult } from "./api";
import type { Credential } from "@earendil-works/pi-ai";

export const invokeChannel = "pideck:invoke";
export const eventChannel = "pideck:event";
export const menuActionChannel = "pideck:menu-action";
export const menuStateChannel = "pideck:menu-state";

type Forwarded = Exclude<Command, "project:open" | "project:remove" | "session:remove" | "clipboard:write" | "appearance:get" | "link:open-external">;
export type RemovalTarget = { projectId: string; sessionId?: string };
export type RemovalPreview = { scope: string; name: string; directory: string; sessionCount: number } & RemovalBlocked;

export type HostCommand =
  | Forwarded
  | "project:add"
  | "removal:plan"
  | "removal:execute"
  | "owner:close";
export type HostInput = {
  [C in Forwarded]: Commands[C][0];
} & {
  "project:add": { directory: string };
  "removal:plan": RemovalTarget;
  "removal:execute": RemovalTarget & { scope: string };
  "owner:close": { preserveQueueEdits?: boolean } | undefined;
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
};
export type HostRequest = {
  [C in HostCommand]: { type: "request"; id: number; owner: number; windowId?: number; command: C; payload: HostInput[C] }
}[HostCommand];
export type ToHost =
  | { type: "start"; dataDir: string; hasSavedCredentials: boolean; lifetimeId: string; closedWindows?: readonly number[] }
  | ({ type: "credential:snapshot"; id: number } & ({ credentials: Record<string, Credential> } | { error: string }))
  | { type: "credential:result"; id: number; error?: string }
  | { type: "shutdown" }
  | HostRequest;
export type FromHost =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; value?: unknown; error?: string }
  | { type: "credential:read"; id: number }
  | { type: "credential:write"; id: number; provider: string; credential: Credential | null }
  | { type: "event"; owner: number; event: HostEvent };
