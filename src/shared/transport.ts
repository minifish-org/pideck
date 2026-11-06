import type { Command, Commands, HostEvent } from "./api";
import type { Credential } from "@earendil-works/pi-ai";

export const invokeChannel = "pideck:invoke";
export const eventChannel = "pideck:event";

export type HostCommand =
  | Exclude<Command, "project:open">
  | "project:add"
  | "owner:close";
export type HostInput = {
  [C in Exclude<Command, "project:open">]: Commands[C][0];
} & {
  "project:add": { directory: string };
  "owner:close": undefined;
};
export type HostResult = {
  [C in Exclude<Command, "project:open" | "model:auth-open" | "model:auth-copy">]: Commands[C][1];
} & {
  "model:auth-open": string;
  "model:auth-copy": string;
  "project:add": Commands["project:open"][1];
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
