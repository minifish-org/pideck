import type { Command, Commands, HostEvent, Project, RemovalBlocked, RemovalResult } from "./api";
import type { Credential } from "@earendil-works/pi-ai";

export const invokeChannel = "pideck:invoke";
export const eventChannel = "pideck:event";
export const menuActionChannel = "pideck:menu-action";
export const menuStateChannel = "pideck:menu-state";

type Forwarded = Exclude<Command, "project:open" | "project:remove" | "session:remove">;
export type RemovalTarget = { projectId: string; sessionId?: string };
export type RemovalPreview = { scope: string; name: string; directory: string; sessionCount: number } & RemovalBlocked;
export type ProjectFolder = { directory: string; device: string; inode: string };
export type ProjectInspection = { folder: ProjectFolder; name: string; project?: Project };

export type HostCommand =
  | Forwarded
  | "project:inspect"
  | "project:add"
  | "removal:plan"
  | "removal:execute"
  | "owner:close";
export type HostInput = {
  [C in Forwarded]: Commands[C][0];
} & {
  "project:inspect": { directory: string };
  "project:add": { directory: string; approval: ProjectFolder };
  "removal:plan": RemovalTarget;
  "removal:execute": RemovalTarget & { scope: string };
  "owner:close": undefined;
};
export type HostResult = {
  [C in Exclude<Forwarded, "model:auth-open" | "model:auth-copy">]: Commands[C][1];
} & {
  "model:auth-open": string;
  "model:auth-copy": string;
  "project:inspect": ProjectInspection;
  "project:add": Project;
  "removal:plan": RemovalPreview;
  "removal:execute": RemovalResult;
  "owner:close": void;
};
export type HostRequest = {
  [C in HostCommand]: { type: "request"; id: number; owner: number; command: C; payload: HostInput[C] }
}[HostCommand];
export type ToHost =
  | { type: "start"; dataDir: string; credentials: Record<string, Credential>; credentialStoreLocked?: true }
  | { type: "credential:result"; id: number; error?: string }
  | { type: "shutdown" }
  | HostRequest;
export type FromHost =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; value?: unknown; error?: string }
  | { type: "credential:write"; id: number; provider: string; credential: Credential | null }
  | { type: "event"; owner: number; event: HostEvent };
