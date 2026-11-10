import type { Op } from "@earendil-works/chord/delta";
import type { ProjectLink } from "./message-links";

export type AppearancePreference = "system" | "light" | "dark";
export type AppearanceState = { preference: AppearancePreference; resolved: "light" | "dark" };

export type Project = {
  id: string;
  name: string;
  directory: string;
  createdAt: number;
};

export type Session = {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Native Durable history ancestry, mapped to a session in this project. */
  parentSessionId?: string;
  forkEntryId?: number;
};

export type Selection = { projectId: string; sessionId: string };
export type DesktopNavigation = { id: number; project: Project; session?: Session; showResult?: true };
export type DesktopContext = { projectId?: string; sessionId?: string; viewing: boolean };
export type SessionActivity = Selection & {
  taskId: number;
  state: "running" | "finished" | "attention";
  settled: boolean;
  resultEntryId?: number;
};
export type RemovalResult = { sessionIds: string[]; warning?: string };
export type SessionBranch = Pick<Session, "id" | "title">;
export type RemovalBlocked = { blockingBranches: SessionBranch[] };
export type ModelRef = { provider: string; id: string };
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelOption = ModelRef & {
  name: string;
  thinking: Thinking[];
  configured: boolean;
  supportsImages: boolean;
  contextWindow?: number;
  maxTokens?: number;
};
export type ModelCatalog = { models: ModelOption[]; savedConnectionsPending: boolean };
export type AuthMethod = "api_key" | "oauth";
export type ModelProvider = {
  id: string;
  name: string;
  methods: { type: AuthMethod; name: string }[];
  credential?: AuthMethod;
  configured: boolean;
  dynamic: boolean;
};
export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };
export type AuthLink = { id: string; label: string; domain: string };
export type AuthNotice =
  | { type: "info"; message: string; links?: AuthLink[] }
  | { type: "auth_url"; link: AuthLink; instructions?: string }
  | { type: "device_code"; link?: AuthLink; code: string; copyId?: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };
export type ImageInput = { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type DraftImage = ImageInput & { name: string };
export type DraftImageRef = { projectId: string; draftId: string; key: string };
export type SendChat = Selection & {
  text: string;
  model: ModelRef;
  thinking: Thinking;
  images?: ImageInput[];
  requestId?: string;
  delivery?: "send" | "follow-up" | "steer";
};
export type StartChat = Omit<SendChat, "sessionId" | "delivery" | "requestId"> & { requestId: string };
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
      taskId?: number;
      cancelling?: true;
      cancelled?: true;
    };
export type ChatMessage = {
  id: string;
  entryId?: number;
  requestId?: string;
  timestamp?: number;
  /** This assistant entry is the native final answer of a settled interaction. */
  completed?: true;
  durationMs?: number;
  role: "user" | "assistant";
  blocks: ChatBlock[];
  error?: string;
};
export type ChatGap = { after: number; upTo: number; beforeMessageId?: string };
export type QueuedInputRef = Selection & { id: number };
export type QueueEditRef = QueuedInputRef & { token: string };
export type QueueUpdate =
  | { action: "steer" | "remove" }
  | { action: "edit"; text: string }
  | { action: "move"; targetId: number; position: "before" | "after" };
export type ChatView = {
  messages: ChatMessage[];
  status: "idle" | "running" | "cancelling";
  runStartedAt?: number;
  runEndedAt?: number;
  model?: ModelRef;
  thinking?: Thinking;
  error?: string;
  failureTaskId?: number;
  runOutcome?: { kind: "cancelled" | "failed"; taskId: number; message: string };
  canContinue?: true;
  latestEntryId?: number;
  hasEarlier?: boolean;
  gaps?: ChatGap[];
  activity?: { kind: "compacting" | "retrying" | "waiting"; retryAt?: number };
  queued?: { id: number; requestId?: string; delivery: "follow-up" | "steer"; preview: string; editing?: boolean }[];
  canSteerQueued?: boolean;
};

export type ReviewFile = {
  path: string;
  oldPath?: string;
  status: string;
};
export type ReviewPatch = { patch: string | null; reason?: string };
export type ReviewFileContents = { path: string; contents: string | null; reason?: string };
type ReviewWatchRef = { projectId: string; subscriptionId: string };

type TerminalRef = { projectId: string; terminalId: string };
type TerminalSize = { cols: number; rows: number };
export type TerminalOpen = { terminalId: string; data: string; sequence: number; exited: boolean };
export type TerminalEvent =
  | ({ type: "terminal:data"; data: string; sequence: number } & TerminalRef)
  | ({ type: "terminal:exit"; exitCode: number; sequence: number } & TerminalRef)
  | ({ type: "terminal:reclaimed"; sequence: number } & TerminalRef);

type WatchRef = Selection & { subscriptionId: string };

export type Commands = {
  "desktop:ready": [undefined, DesktopNavigation | null];
  "desktop:context": [DesktopContext, void];
  "appearance:get": [undefined, AppearanceState];
  "clipboard:write": [{ text: string }, void];
  "link:open-external": [{ url: string }, void];
  "project:list": [undefined, Project[]];
  "project:open": [undefined, Project | null];
  "project:remove": [{ projectId: string }, RemovalResult | null];
  "session:list": [{ projectId: string }, Session[]];
  "session:watch-activity": [{ subscriptionId: string }, void];
  "session:unwatch-activity": [{ subscriptionId: string }, void];
  "session:read-activity": [Selection & { taskId: number }, void];
  "session:create": [{ projectId: string; title?: string }, Session];
  "session:rename": [Selection & { title: string }, Session];
  "session:remove": [Selection, RemovalResult | RemovalBlocked | null];
  "draft:images-read": [DraftImageRef, DraftImage[]];
  "draft:images-write": [DraftImageRef & { images: DraftImage[] }, void];
  "model:list": [{ useSaved: true } | undefined, ModelCatalog];
  "model:providers": [undefined, ModelProvider[]];
  "model:login": [{ provider: string; method: AuthMethod; flowId: string }, void];
  "model:logout": [{ provider: string }, void];
  "model:refresh": [{ provider?: string }, void];
  "model:auth-answer": [{ flowId: string; promptId: string; value: string }, void];
  "model:auth-cancel": [{ flowId: string }, void];
  "model:auth-open": [{ flowId: string; linkId: string }, void];
  "model:auth-copy": [{ flowId: string; copyId: string }, void];
  "chat:watch": [WatchRef & { readingEntryId?: number }, void];
  "chat:unwatch": [{ subscriptionId: string }, void];
  "chat:earlier": [WatchRef & { gap?: Pick<ChatGap, "after" | "upTo"> }, void];
  "chat:start": [StartChat, Session];
  "chat:send": [SendChat, void];
  "chat:queue-read": [QueuedInputRef, { text: string; hasImages: boolean }];
  "chat:queue-edit-start": [QueueEditRef, { token: string; text: string; hasImages: boolean }];
  "chat:queue-edit-finish": [QueueEditRef & { text?: string }, void];
  "chat:queue-update": [QueuedInputRef & QueueUpdate, void];
  "chat:cancel": [Selection, void];
  "chat:continue": [Selection & { requestId: string; model?: ModelRef; thinking?: Thinking }, void];
  "chat:task-cancel": [Selection & { taskId: number }, void];
  "chat:fork": [Selection & { entryId: number; title?: string }, Session];
  "review:list": [{ projectId: string }, ReviewFile[]];
  "review:patch": [{ projectId: string; path: string }, ReviewPatch];
  "review:resolve-link": [{ projectId: string; href: string }, ProjectLink];
  "review:file": [{ projectId: string; path: string; requestId: string }, ReviewFileContents];
  "review:file-cancel": [{ projectId: string; requestId: string }, void];
  "review:watch": [ReviewWatchRef, void];
  "review:unwatch": [ReviewWatchRef, void];
  "terminal:open": [{ projectId: string } & TerminalSize, TerminalOpen];
  "terminal:input": [TerminalRef & { data: string }, void];
  "terminal:resize": [TerminalRef & TerminalSize, void];
  "terminal:close": [TerminalRef, void];
  "terminal:visibility": [TerminalRef & { visible: boolean }, void];
  "terminal:sync": [TerminalRef & { through: number; replay?: true }, TerminalEvent[]];
};
export type Command = keyof Commands;
export type MenuAction = "open-project" | "search-sessions" | "new-session" | "settings" | "toggle-navigation" | "toggle-review" | "toggle-terminal" | "focus-composer";
export type MenuState = {
  canOpenProject: boolean;
  canSearchSessions: boolean;
  canOpenSettings: boolean;
  canCreateSession: boolean;
  canFocusComposer: boolean;
  canToggleNavigation: boolean;
  canUseWorkspace: boolean;
  navigationVisible: boolean;
  reviewVisible: boolean;
  terminalVisible: boolean;
};
export type HostEvent =
  | { type: "desktop:navigate"; navigation: DesktopNavigation }
  | { type: "host:resume" }
  | { type: "appearance:changed"; appearance: AppearanceState }
  | { type: "session:activity"; subscriptionId: string; items: SessionActivity[] }
  | ({ type: "chat:update"; sequence: number } & WatchRef & ({ view: ChatView } | { ops: Op[] }))
  | ({ type: "chat:error"; subscriptionId: string; message: string } & Selection)
  | ({ type: "chat:reset" } & Selection)
  | ({ type: "review:changed" | "review:watch-error" } & ReviewWatchRef)
  | { type: "auth:prompt"; flowId: string; promptId: string; prompt: AuthPrompt }
  | { type: "auth:prompt-closed"; flowId: string; promptId: string }
  | { type: "auth:notice"; flowId: string; notice: AuthNotice }
  | TerminalEvent
  | { type: "host:disconnected"; message: string }
  | { type: "host:restart" };
export type Pideck = {
  platform: string;
  invoke<C extends Command>(command: C, ...args: undefined extends Commands[C][0] ? [Commands[C][0]?] : [Commands[C][0]]): Promise<Commands[C][1]>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  onMenuAction?(listener: (action: MenuAction) => void): () => void;
  updateMenu?(state: MenuState): void;
};

declare global {
  interface Window { pideck: Pideck }
}
