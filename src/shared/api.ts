export type Project = {
  id: string;
  name: string;
  directory: string;
  trusted: boolean;
  createdAt: number;
};

export type Session = {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type Selection = { projectId: string; sessionId: string };
export type ModelRef = { provider: string; id: string };
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelOption = ModelRef & {
  name: string;
  thinking: Thinking[];
  configured: boolean;
  supportsImages: boolean;
};
export type ImageInput = { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type SendChat = Selection & { text: string; model: ModelRef; thinking: Thinking; images?: ImageInput[] };
export type ChatBlock =
  | { type: "text" | "thinking"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments?: Record<string, unknown>;
      output?: string;
      images?: { mimeType: string; data: string }[];
      patch?: string;
      path?: string;
      status: "pending" | "running" | "done" | "error";
    };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  blocks: ChatBlock[];
  error?: string;
};
export type ChatView = {
  messages: ChatMessage[];
  status: "idle" | "running" | "cancelling";
  model?: ModelRef;
  thinking?: Thinking;
  error?: string;
};

export type ReviewFile = {
  path: string;
  oldPath?: string;
  status: string;
};
export type ReviewPatch = { patch: string | null; reason?: string };

type TerminalRef = { projectId: string; terminalId: string };
type TerminalSize = { cols: number; rows: number };
export type TerminalOpen = { terminalId: string; data: string; sequence: number; exited: boolean };

export type Commands = {
  "project:list": [undefined, Project[]];
  "project:open": [undefined, Project | null];
  "project:trust": [{ projectId: string }, Project | null];
  "session:list": [{ projectId: string }, Session[]];
  "session:create": [{ projectId: string; title?: string }, Session];
  "model:list": [undefined, ModelOption[]];
  "model:save-key": [{ provider: string; key: string }, void];
  "chat:watch": [Selection & { subscriptionId: string }, void];
  "chat:unwatch": [{ subscriptionId: string }, void];
  "chat:send": [SendChat, void];
  "chat:cancel": [Selection, void];
  "review:list": [{ projectId: string }, ReviewFile[]];
  "review:patch": [{ projectId: string; path: string }, ReviewPatch];
  "terminal:open": [{ projectId: string } & TerminalSize, TerminalOpen];
  "terminal:input": [TerminalRef & { data: string }, void];
  "terminal:resize": [TerminalRef & TerminalSize, void];
  "terminal:close": [TerminalRef, void];
};
export type Command = keyof Commands;
export type HostEvent =
  | ({ type: "chat:update"; subscriptionId: string; sequence: number; view: ChatView } & Selection)
  | ({ type: "chat:error"; subscriptionId: string; message: string } & Selection)
  | ({ type: "terminal:data"; data: string; sequence: number } & TerminalRef)
  | ({ type: "terminal:exit"; exitCode: number; sequence: number } & TerminalRef)
  | { type: "host:restart" };
export type Pideck = {
  platform: string;
  invoke<C extends Command>(command: C, ...args: Commands[C][0] extends undefined ? [] : [Commands[C][0]]): Promise<Commands[C][1]>;
  onEvent(listener: (event: HostEvent) => void): () => void;
};

declare global {
  interface Window { pideck: Pideck }
}
