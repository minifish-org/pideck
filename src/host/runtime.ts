import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AgentDoc, configure, ConversationTranscript, createRegistry, defineExtension, GenerationTask, Harness, InboxDoc, LiveDoc, section, ToolTask,
  type Conversation, type ConversationId, type ConversationView, type EntryId, type InboxState, type InputSubmissionDraft, type LiveState, type TaskGraph, type TaskId, type TranscriptView, type Tx,
} from "@earendil-works/pi-durable";
import { err, ExecutionError, FileError, ok, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type {
  ChatGap, ChatView, EditChat, ModelCatalog, ModelOption, QueuedInputRef, QueueEditRef, QueueUpdate, RemovalResult, SendChat, Selection, Session, SessionActivity,
  StartChat, Commands,
} from "../shared/api.js";
import type { RemovalPreview, RemovalTarget } from "../shared/transport.js";
import { branchTitle, firstSessionTitle, sessionTitle, untitledSession } from "../shared/session-title.js";
import { chatProjection, continueEntryKind, inputEntryKind, type CompletedRun } from "./chat-view.js";
import { PersistentCredentials } from "./credential-store.js";
import { Metadata } from "./metadata.js";
import { conversationClosure, conversationSpillPaths, removeLegacySpills } from "./purge.js";
import { advanceReleasedQueue, detachQueueEdit, discardQueueEdit, finishQueueEdit, QueueEditDoc, readQueuedInput,
  startQueueEdit, submitQueuedInput, updateQueuedInput } from "./queued-input.js";
import type { QueueEditState } from "./queued-input.js";
import { shellEnvironment } from "./shell-env.js";
import { SessionActivities } from "./session-activity.js";
import { activeRunStartedAt, completedRun } from "./run-timing.js";
import { reviewWrites } from "./write-review.js";
import { Automation } from "./automation.js";

const context = BACKGROUND_CONTEXT;
const processLifetime = randomUUID();
const instructions = [
  "You are Pideck, a coding agent working in the user's selected local project.",
  "Inspect relevant files before editing. Read AGENTS.md in relevant subdirectories for instructions scoped to those files.",
  "Use repository instructions within the scope of the user's task. Make focused changes, review the diff, and verify the result.",
  "For frontend verification, use the bash tool in the project to start the dev server and run Playwright CLI.",
  "Use a unique named browser session (playwright-cli -s=<name> open <url>), exercise the changed flow, and check its snapshot, screenshot, or console.",
  "For visual analysis, pass a screenshot to the read tool when your model supports images. Close the named browser session when finished.",
  "For a frontend change, run the changed interactions in the browser, inspect the screenshot and fix any problems before reporting success. Do not claim visual inspection without reading an image.",
  "Keep development servers on loopback, record their process IDs, and stop servers you started when verification is complete.",
].join("\n");

const projectInstructionLimit = 64 * 1024;
const projectInstructions = section("project_instructions", async ({ env }, scope) => {
  if (!env) return undefined;
  const opened = await env.openBinaryReader("AGENTS.md", { noFollow: true }, scope);
  if (!opened.ok) return undefined;
  try {
    const result = await opened.value.read(0, projectInstructionLimit + 1, scope);
    if (!result.ok || result.value.length === 0) return undefined;
    const text = new TextDecoder().decode(result.value.subarray(0, projectInstructionLimit));
    return result.value.length > projectInstructionLimit
      ? text + "\n[AGENTS.md was truncated. Read the file before making changes.]"
      : text;
  } finally {
    await opened.value.close(context);
  }
});

class ToolEnvironment extends NodeExecutionEnv {
  constructor(cwd: string, private readonly outputDir: string,
    private readonly browser?: { runtime: Automation; projectId: string; conversationId: string }) { super({ cwd }); }

  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, scope: Context): ReturnType<NodeExecutionEnv["exec"]> {
    const env = shellEnvironment();
    try {
      if (this.browser) Object.assign(env, await this.browser.runtime.environment(
        this.browser.projectId, this.browser.conversationId, this.cwd));
    } catch (cause) {
      return err(new ExecutionError("spawn_error", cause instanceof Error ? cause.message : "Could not prepare the browser tools."));
    }
    return super.exec(command, { ...options, inheritEnv: false, env }, scope);
  }

  override async createTempDir(prefix: string | undefined, scope: Context): ReturnType<NodeExecutionEnv["createTempDir"]> {
    if (scope.abortSignal?.aborted) return err(new FileError("aborted", "The tool was stopped."));
    try {
      await mkdir(this.outputDir, { recursive: true, mode: 0o700 });
      return ok(await mkdtemp(join(this.outputDir, prefix ?? "tmp-")));
    } catch {
      return err(new FileError("unknown", "Could not create a temporary tool output directory."));
    }
  }
}

type RemovalPlan = RemovalPreview & RemovalResult & { roots: ConversationId[]; conversations: ConversationId[] };

function chatSubmission(input: { text: string; images?: readonly { mimeType: string; data: string }[];
  requestId?: string; delivery?: SendChat["delivery"] }): InputSubmissionDraft {
  const images = input.images ?? [];
  const delivery = ("delivery" in input && input.delivery) || "send";
  const { requestId } = input;
  return {
    type: "input",
    whenBusy: delivery === "send" ? "reject" : delivery === "steer" ? "steer" : "followUp",
    ...(delivery === "steer" ? { whenIdle: "reject" } : {}),
    ...(requestId ? { requestId, entry: { kind: inputEntryKind, data: { requestId } } } : {}),
    content: images.length ? [
      ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
      ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ] : input.text,
  };
}

async function requireEditIdle(tx: Tx, conversationId: ConversationId) {
  const live = await tx.doc(LiveDoc, conversationId);
  if (live.run || live.compactions?.length) throw new Error("Stop the current run before resending an edited message.");
  const inbox = await tx.doc(InboxDoc, conversationId);
  if (inbox.items.length || (await tx.doc(QueueEditDoc, conversationId)).edit) {
    throw new Error("Finish or remove queued messages before resending an edited message.");
  }
}

export type ChatWatch = {
  dispose(): void;
  loadEarlier(): Promise<void>;
  fillGap(gap: Pick<ChatGap, "after" | "upTo">): Promise<void>;
};

export class Runtime {
  private closing?: Promise<void>;
  private removing?: Promise<RemovalResult>;
  private readonly admissions = new Set<Promise<unknown>>();
  private activeAdmissions = 0;
  private readonly starting = new Map<string, { projectId: string; result: Promise<Session> }>();
  private readonly editing = new Map<string, { source: string; result: Promise<Session> }>();
  private readonly activities = new SessionActivities(id => this.metadata.sessionSelection(id), {
    load: () => this.metadata.sessionActivities(),
    save: (id, activity) => this.metadata.saveSessionActivity(id, activity),
    clear: id => this.metadata.clearSessionActivity(id),
  });
  private readonly closedEditOwners = new Set<number>();
  private editsClosing = false;

  private constructor(
    private readonly metadata: Metadata,
    private harness: Harness,
    readonly models: Models,
    private readonly durablePath: string,
    private readonly outputRoot: string,
    private readonly openHarness: () => Promise<Harness>,
    private readonly savedCredentials?: PersistentCredentials,
    private readonly onStorageFailure?: () => void,
    private readonly lifetimeId: string = processLifetime,
    private readonly automation?: Automation,
  ) {}

  static async open(
    dataDir: string,
    keys: Record<string, string> = {},
    suppliedModels?: Models,
    credentials: CredentialStore = new InMemoryCredentialStore(),
    onStorageFailure?: () => void,
    lifetimeId: string = processLifetime,
    closedWindows: readonly number[] = [],
    automationOptions?: { resourcesDirectory: string; stateDirectory: string; launcherPath?: string },
  ): Promise<Runtime> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const metadata = new Metadata(join(dataDir, "workspace.sqlite"));
    const durablePath = join(dataDir, "conversations.sqlite");
    const outputRoot = join(dataDir, "tool-output");
    try {
      metadata.reapUnmapped(durablePath);
      await cleanupExpiredOutput(metadata, outputRoot);
      const models = suppliedModels ?? builtinModels({
        credentials,
        modelsStore: metadata.modelsStore,
        identity: { userAgent: { custom: "Pideck/0.1.2" } },
      });
      const savedCredentials = credentials instanceof PersistentCredentials ? credentials : undefined;
      const restoreCatalogs = () => models.refresh({ allowNetwork: false });
      if (!suppliedModels) savedCredentials?.onUnlock(restoreCatalogs);
      for (const [provider, key] of Object.entries(keys)) {
        if (key && models.getProvider(provider)?.auth.apiKey) {
          await credentials.modify(provider, async () => ({ type: "api_key", key }));
        }
      }
      if (!suppliedModels) {
        if (savedCredentials) await savedCredentials.passive(restoreCatalogs);
        else await restoreCatalogs();
      }

      const registry = createRegistry();
      const automation = automationOptions ? await Automation.open(automationOptions) : undefined;
      registry.install(createCodingTools({ images: await createNodePhotonImages() }));
      registry.install(defineExtension({
        name: "pideck",
        wraps: [reviewWrites],
        sections: [
          section("pideck", ({ env }) => [instructions,
            automation ? automation.instructions()
              : "Use the project's local Playwright CLI or a CLI already on PATH; if needed, run npx --yes --package @playwright/cli playwright-cli.",
            env ? `The project working directory is ${env.cwd}.` : ""].filter(Boolean).join("\n")),
          projectInstructions,
        ],
      }));
      async function openHarness() {
        const storage = await openNodeSqliteStorage(durablePath);
        const harness = await Harness.open(storage, {
          models,
          registry,
          onReport: report => {
            if (report.kind === "storage_failed") onStorageFailure?.();
          },
          env: ({ conversationId, cwd }) => {
            const project = metadata.requireProject(metadata.projectOf(conversationId));
            if (project.directory !== cwd) throw new Error("Conversation directory does not match its project.");
            return new ToolEnvironment(cwd, join(outputRoot, String(conversationId)), automation
              ? { runtime: automation, projectId: project.id, conversationId: String(conversationId) } : undefined);
          },
        }, context);
        return harness;
      }
      const harness = await openHarness();
      const runtime = new Runtime(metadata, harness, models, durablePath, outputRoot, openHarness, savedCredentials, onStorageFailure, lifetimeId, automation);
      for (const windowId of closedWindows) runtime.closedEditOwners.add(windowId);
      try {
        if (await runtime.recoverSessionStarts()) {
          await harness.close(context);
          metadata.reapUnmapped(durablePath);
          runtime.harness = await openHarness();
        }
        await runtime.recoverQueueEdits();
        await runtime.activities.attach(runtime.harness);
        await runtime.recoverSessionTitles();
        await runtime.resumeReleasedQueues();
        runtime.harness.resume();
      } catch (error) {
        runtime.activities.detach();
        await runtime.harness.close(context).catch(() => {});
        throw error;
      }
      return runtime;
    } catch (error) {
      metadata.close();
      throw error;
    }
  }

  listProjects() { return this.metadata.listProjects(); }
  addProject(directory: string) {
    this.assertWritable();
    return this.metadata.addProject(directory);
  }
  requireProject(projectId: string) { return this.metadata.requireProject(projectId); }
  async listSessions(projectId: string): Promise<Session[]> {
    const sessions = this.metadata.listSessions(projectId);
    const rows = this.metadata.sessionRows(projectId);
    const byConversation = new Map(rows.map(row => [row.conversationId, row.id]));
    const byId = new Map(rows.map(row => [row.id, row.conversationId]));
    // Read native immutable ancestry on Durable's line, including old forks.
    return this.harness.commit(async tx => Promise.all(sessions.map(async session => {
      const record = await tx.conversation(byId.get(session.id)!);
      const parentSessionId = record?.parent && byConversation.get(record.parent.conversationId);
      return parentSessionId ? { ...session, parentSessionId, forkEntryId: record!.parent!.at } : session;
    })), context);
  }
  readDraftImages(input: Commands['draft:images-read'][0]) { return this.metadata.readDraftImages(input); }
  writeDraftImages(input: Commands['draft:images-write'][0]) {
    this.assertWritable();
    this.metadata.writeDraftImages(input);
  }
  deviceId() { return this.metadata.deviceId(); }

  watchSessionActivity(listener: (items: SessionActivity[]) => void) {
    return this.activities.subscribe(listener);
  }

  sessionActivities() { return this.activities.snapshot(); }
  hasActiveWork() { return this.activeAdmissions > 0 || this.activities.hasActiveWork(); }

  readSessionActivity(selection: Selection, taskId: number) {
    const session = this.metadata.session(selection.projectId, selection.sessionId);
    this.activities.read(session.conversationId, taskId);
  }

  createSession(projectId: string, title?: string) {
    return this.admit(async () => {
      const project = this.requireProject(projectId);
      const conversation = await this.harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { cwd: project.directory },
      }, context);
      const name = title && sessionTitle(title);
      return this.metadata.createSession(projectId, conversation.id, name || untitledSession, !name);
    });
  }

  renameSession(selection: Selection, title: string) {
    this.assertWritable();
    const name = sessionTitle(title);
    if (!name) throw new Error("Enter a session name.");
    return this.metadata.renameSession(selection.projectId, selection.sessionId, name);
  }

  private async recoverSessionTitles(): Promise<void> {
    for (const { id, conversationId } of this.metadata.sessionsAwaitingTitle()) {
      const conversation = await this.harness.conversation(conversationId, context);
      if (conversation) await this.nameFromFirstMessage(id, conversation);
    }
  }

  private async recoverSessionStarts(): Promise<boolean> {
    let discarded = false;
    for (const { id, conversationId } of this.metadata.pendingStarts()) {
      const conversation = await this.harness.conversation(conversationId, context);
      const accepted = await conversation?.commit(tx => tx.submissionByRequest(conversationId, id), context);
      if (accepted) this.metadata.finishSessionStart(id);
      else {
        this.metadata.discardSessionStart(id);
        discarded = true;
      }
    }
    return discarded;
  }

  private async nameFromFirstMessage(sessionId: string, conversation: Conversation): Promise<void> {
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
      const page = await conversation.entries({ order: "ascending" }, 16, cursor, context);
      for (const entry of page.items) {
        if (entry.kind !== "pi.user" && entry.kind !== inputEntryKind) continue;
        const user = entry.model?.find(message => message.role === "user");
        if (!user) continue;
        const text = typeof user.content === "string" ? user.content
          : user.content.find(block => block.type === "text")?.text ?? "";
        this.metadata.setAutomaticTitle(sessionId, firstSessionTitle(text));
        return;
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  async modelCatalog(useSaved = false): Promise<ModelCatalog> {
    if (useSaved) await this.savedCredentials?.unlock();
    const pending = this.savedCredentials?.savedConnectionsPending ?? false;
    const models = await this.listModels();
    const stillPending = this.savedCredentials?.savedConnectionsPending ?? false;
    return { models: pending && !stillPending ? await this.listModels() : models, savedConnectionsPending: stillPending };
  }

  listModels(): Promise<ModelOption[]> {
    const list = () => this.readModelCatalog();
    return this.savedCredentials ? this.savedCredentials.passive(list) : list();
  }

  private async readModelCatalog(): Promise<ModelOption[]> {
    const catalogs = await Promise.all(this.models.getProviders().map(async provider => {
      const available = await this.models.getAvailableOfType("chat", provider.id, {
        signal: AbortSignal.timeout(2500),
      }).catch(() => []);
      const configured = new Set(available.map(model => model.id));
      return this.models.getModels(provider.id).map(model => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
        configured: configured.has(model.id),
        thinking: getSupportedThinkingLevels(model),
        supportsImages: model.input.includes("image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    }));
    return catalogs.flat();
  }

  private async conversation(selection: Selection): Promise<Conversation> {
    const session = this.metadata.session(selection.projectId, selection.sessionId);
    const conversation = await this.harness.conversation(session.conversationId, context);
    if (!conversation) throw new Error("The conversation could not be reopened.");
    return conversation;
  }

  send(input: SendChat): Promise<void> {
    return this.admit(() => this.submitChat(input), true);
  }

  start(input: StartChat): Promise<Session> {
    return this.admit(async () => {
      const project = this.requireProject(input.projectId);
      if (!input.text.trim() && !input.images?.length) throw new Error("Enter a message or attach an image.");
      const { requestId } = input;
      const existing = this.starting.get(requestId);
      if (existing) {
        if (existing.projectId !== project.id) throw new Error("This message belongs to another project.");
        return existing.result;
      }
      const result = this.submitFirstMessage(input, project.directory);
      this.starting.set(requestId, { projectId: project.id, result });
      try { return await result; }
      finally { this.starting.delete(requestId); }
    }, true);
  }

  private async submitFirstMessage(input: StartChat, directory: string): Promise<Session> {
    const { projectId, requestId } = input;
    const existing = this.metadata.findSession(requestId);
    if (existing) {
      if (existing.projectId !== projectId) throw new Error("This message belongs to another project.");
      const conversation = await this.harness.conversation(existing.conversationId, context);
      const accepted = await conversation?.commit(tx => tx.submissionByRequest(existing.conversationId, requestId), context);
      if (accepted) return this.metadata.finishSessionStart(requestId);
      if (!existing.startPending) throw new Error("A session already exists with this identifier.");
      this.metadata.discardSessionStart(requestId);
    }
    const model = await this.validateChatModel(input);
    const conversation = await this.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { cwd: directory, model: { provider: model.provider, modelId: model.id }, thinkingLevel: input.thinking },
    }, context);
    // The mapping must exist before the admitted run can resolve its tool
    // environment. Keep it hidden until Durable confirms the admission.
    await conversation.commit(async tx => {
      await conversation.submit(tx, chatSubmission(input));
      this.requireProject(projectId);
      this.metadata.createSession(projectId, conversation.id, firstSessionTitle(input.text), false, requestId);
    }, context);
    return this.metadata.finishSessionStart(requestId);
  }

  private async editableMessage(selection: Selection, entryId: number) {
    this.requireProject(selection.projectId);
    const conversation = await this.conversation(selection);
    // Read fork-aware history, not an arbitrary global entry ID or the bounded
    // renderer projection (which may omit earlier image data).
    const at = entryId as EntryId;
    const entry = (await conversation.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, context)).items[0];
    const user = entry?.model?.[0];
    if (!entry || !["pi.user", inputEntryKind].includes(entry.kind) || entry.model?.length !== 1 || user?.role !== "user") {
      throw new Error("Choose a committed user message in this session.");
    }
    const content = typeof user.content === "string" ? { text: user.content, images: [] }
      : { text: user.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n\n"),
        images: user.content.flatMap(block => block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : []) };
    return { conversation, content };
  }

  readMessageForEdit(input: Commands["chat:edit-read"][0]): Promise<Commands["chat:edit-read"][1]> {
    return this.admit(async () => (await this.editableMessage(input, input.entryId)).content);
  }

  edit(input: EditChat): Promise<Session> {
    return this.admit(async () => {
      const source = `${input.projectId}/${input.sessionId}/${input.entryId}`;
      const pending = this.editing.get(input.requestId);
      if (pending) {
        if (pending.source !== source) throw new Error("This edit belongs to another message.");
        return pending.result;
      }
      const result = this.resubmitMessage(input);
      this.editing.set(input.requestId, { source, result });
      try { return await result; }
      finally { this.editing.delete(input.requestId); }
    }, true);
  }

  private async resubmitMessage(input: EditChat): Promise<Session> {
    const { conversation, content } = await this.editableMessage(input, input.entryId);
    const source = this.metadata.session(input.projectId, input.sessionId);
    const existing = this.metadata.findSession(input.requestId);
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error("This edit belongs to another project.");
      const receipt = await this.harness.commit(async tx => {
        const accepted = await tx.submissionByRequest(existing.conversationId, input.requestId);
        const data = accepted?.type === "input" && accepted.entry !== undefined ? (await tx.entry(accepted.entry))?.data : undefined;
        if (!data || typeof data !== "object" || Array.isArray(data)
            || data.editedSessionId !== input.sessionId || data.editedEntryId !== input.entryId) {
          throw new Error("This request already belongs to another action.");
        }
        return (await tx.conversation(existing.conversationId))?.parent;
      }, context);
      return { ...this.metadata.finishSessionStart(input.requestId),
        ...(receipt ? { parentSessionId: source.id, forkEntryId: receipt.at } : {}) };
    }
    if (!input.text.trim() && !content.images.length) throw new Error("Enter a message or keep an attached image.");
    const submission = { ...input, images: content.images };
    const model = await this.validateChatModel(submission);
    await conversation.commit(tx => requireEditIdle(tx, conversation.id), context);
    const previous = (await conversation.entries({ maxEntryId: (input.entryId - 1) as EntryId }, 1, undefined, context)).items[0];
    // Durable forks include their checkpoint. Fork immediately BEFORE the
    // edited input so neither it nor its old answer enters the new context.
    // The very first input has no checkpoint, so it starts an empty session.
    const branch = previous
      ? await conversation.fork(previous.id, { ownership: { kind: "ownerless" } }, context)
      : await this.harness.createConversation({ ownership: { kind: "ownerless" },
        agent: { cwd: this.requireProject(input.projectId).directory } }, context);
    await branch.commit(async tx => {
      await requireEditIdle(tx, conversation.id);
      await configure(tx, branch.id, { model: { provider: model.provider, modelId: model.id }, thinkingLevel: input.thinking });
      await branch.submit(tx, { ...chatSubmission(submission), entry: { kind: inputEntryKind,
        data: { requestId: input.requestId, editedSessionId: input.sessionId, editedEntryId: input.entryId } } });
      this.requireProject(input.projectId);
      // Use the existing first-admission recovery path: an acknowledgement lost
      // to a restart must reopen this branch, never fork or execute it twice.
      this.metadata.createSession(input.projectId, branch.id,
        previous ? branchTitle(source.title) : firstSessionTitle(input.text), false, input.requestId);
    }, context);
    return { ...this.metadata.finishSessionStart(input.requestId),
      ...(previous ? { parentSessionId: source.id, forkEntryId: previous.id } : {}) };
  }

  readQueuedInput(selection: QueuedInputRef): Promise<Commands["chat:queue-read"][1]> {
    return this.admit(async () => {
      this.requireProject(selection.projectId);
      const conversation = await this.conversation(selection);
      return conversation.commit(tx => readQueuedInput(tx, conversation.id, selection.id), context);
    });
  }

  updateQueuedInput(input: QueuedInputRef & QueueUpdate): Promise<void> {
    return this.admit(async () => {
      this.requireProject(input.projectId);
      const conversation = await this.conversation(input);
      return conversation.commit(tx => updateQueuedInput(tx, conversation.id, input.id, input), context);
    });
  }

  startQueueEdit(input: QueueEditRef, owner: number) {
    return this.admit(async () => {
      const conversation = await this.conversation(input);
      return conversation.commit(tx => {
        if (this.editsClosing || this.closedEditOwners.has(owner)) throw new Error("This editing window has closed.");
        return startQueueEdit(tx, conversation.id, { ...input, owner, lifetimeId: this.lifetimeId });
      }, context);
    });
  }

  finishQueueEdit(input: QueueEditRef & { text?: string }, owner: number): Promise<void> {
    return this.admit(async () => {
      const conversation = await this.conversation(input);
      return conversation.commit(tx => {
        if (this.editsClosing || this.closedEditOwners.has(owner)) throw new Error("This editing window has closed.");
        return finishQueueEdit(tx, conversation, { ...input, owner, lifetimeId: this.lifetimeId }, input.text);
      }, context);
    });
  }

  private conversationRows() {
    return this.metadata.listProjects().flatMap(project => this.metadata.sessionRows(project.id));
  }

  private async recoverQueueEdits() {
    for (const row of this.conversationRows()) {
      const held = await this.harness.snapshot(QueueEditDoc, row.conversationId, context);
      if (!held?.edit) continue;
      const foreignLifetime = held.edit.lifetimeId !== this.lifetimeId;
      if (!foreignLifetime && !this.closedEditOwners.has(held.edit.owner)) continue;
      const conversation = await this.harness.conversation(row.conversationId, context);
      if (conversation) await conversation.commit(tx => detachQueueEdit(tx, conversation.id, undefined, this.lifetimeId, foreignLifetime), context);
    }
  }

  private async resumeReleasedQueues() {
    for (const row of this.conversationRows()) {
      if (!(await this.harness.snapshot(QueueEditDoc, row.conversationId, context))?.resume) continue;
      const conversation = await this.harness.conversation(row.conversationId, context);
      if (conversation) await conversation.commit(tx => advanceReleasedQueue(tx, conversation), context);
    }
  }

  async detachQueueEdits(owner?: number) {
    if (owner !== undefined) this.closedEditOwners.add(owner);
    else this.editsClosing = true;
    await this.removing?.catch(() => {});
    if (this.closing) return;
    return this.admit(async () => {
      for (const row of this.conversationRows()) {
        const conversation = await this.harness.conversation(row.conversationId, context);
        // Serialize behind an in-flight claim, rather than missing it in a
        // snapshot taken just before that claim commits.
        if (conversation) await conversation.commit(tx => detachQueueEdit(tx, conversation.id, owner, this.lifetimeId), context);
      }
    });
  }

  private async validateChatModel(input: Pick<SendChat, "model" | "thinking"> & { images?: readonly unknown[] }) {
    await this.savedCredentials?.unlock();
    const model = this.models.getModel(input.model.provider, input.model.id);
    if (!model) throw new Error("The selected model is unavailable.");
    const available = await this.models.getAvailableOfType("chat", model.provider, {
      signal: AbortSignal.timeout(2500),
    }).catch(() => []);
    if (!available.some(candidate => candidate.id === model.id)) {
      throw new Error("Sign in to this provider or choose a model your account can access.");
    }
    if (!getSupportedThinkingLevels(model).includes(input.thinking)) {
      throw new Error("The selected model does not support this thinking level.");
    }
    if (input.images?.length && !model.input.includes("image")) throw new Error("This model does not accept images.");
    return model;
  }

  private async submitChat(input: SendChat): Promise<void> {
    this.requireProject(input.projectId);
    const { autoTitlePending } = this.metadata.session(input.projectId, input.sessionId);
    const conversation = await this.conversation(input);
    const { requestId } = input;
    if (requestId) {
      // An acknowledgement lost during restart still belongs to the original
      // admission, even if the catalog or credentials have changed meanwhile.
      const accepted = await conversation.commit(tx => tx.submissionByRequest(conversation.id, requestId), context);
      if (accepted) {
        if (autoTitlePending) await this.nameFromFirstMessage(input.sessionId, conversation);
        return;
      }
    }
    const model = await this.validateChatModel(input);
    const delivery = input.delivery ?? "send";

    const admitted = await conversation.commit(async tx => {
      if (requestId && await tx.submissionByRequest(conversation.id, requestId)) return false;
      const editing = (await tx.doc(QueueEditDoc, conversation.id)).edit;
      if (delivery === "send" && !editing) {
        await configure(tx, conversation.id, {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: input.thinking,
        });
      } else {
        const current = await tx.doc(AgentDoc, conversation.id);
        if (current.model?.provider !== model.provider || current.model.modelId !== model.id
            || (current.thinkingLevel ?? "off") !== input.thinking) {
          throw new Error("Queued input uses the model and thinking level of the active run.");
        }
      }
      await submitQueuedInput(tx, conversation, chatSubmission(input));
      return true;
    }, context);
    if (admitted) this.metadata.touchSession(input.sessionId);
    if (autoTitlePending) await this.nameFromFirstMessage(input.sessionId, conversation);
  }

  fork(selection: Selection, entryId: number, title?: string) {
    return this.admit(() => this.forkSession(selection, entryId, title));
  }

  private async forkSession(selection: Selection, entryId: number, title?: string) {
    this.requireProject(selection.projectId);
    const source = this.metadata.session(selection.projectId, selection.sessionId);
    const conversation = await this.conversation(selection);
    const at = entryId as EntryId;
    const entry = (await conversation.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, context)).items[0];
    if (!entry || !["pi.user", inputEntryKind, "pi.assistant"].includes(entry.kind)) {
      throw new Error("Choose a committed user or assistant message in this session.");
    }
    const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
    return { ...this.metadata.createSession(selection.projectId, fork.id, (title && sessionTitle(title)) || branchTitle(source.title)),
      parentSessionId: source.id, forkEntryId: entryId };
  }

  cancel(selection: Selection): Promise<void> {
    return this.admit(async () => {
      const conversation = await this.conversation(selection);
      await conversation.commit(tx => discardQueueEdit(tx, conversation.id), context);
      await conversation.abort(context, { background: true });
      await this.automation?.closeConversation(String(conversation.id));
    });
  }

  continue(input: Commands["chat:continue"][0]): Promise<void> {
    return this.admit(async () => {
      this.requireProject(input.projectId);
      const conversation = await this.conversation(input);
      const existing = await conversation.commit(tx => tx.submissionByRequest(conversation.id, input.requestId), context);
      if (existing) {
        if (existing.type !== "continue") throw new Error("This request already belongs to another action.");
        return;
      }
      if (Boolean(input.model) !== Boolean(input.thinking)) throw new Error("Choose both a model and thinking level.");
      const agent = await this.harness.snapshot(AgentDoc, conversation.id, context);
      const model = input.model ?? (agent?.model ? { provider: agent.model.provider, id: agent.model.modelId } : undefined);
      if (!model) throw new Error("Choose a model before continuing.");
      const thinking = input.thinking ?? agent?.thinkingLevel ?? "off";
      await this.validateChatModel({ ...input, model, thinking });
      const current = await conversation.context(context);
      const last = current.messages.findLast(message => message.role !== "system");
      const tail = current.entries.at(-1)?.id;
      await conversation.commit(async tx => {
        const accepted = await tx.submissionByRequest(conversation.id, input.requestId);
        if (accepted) {
          if (accepted.type !== "continue") throw new Error("This request already belongs to another action.");
          return;
        }
        const live = await tx.doc(LiveDoc, conversation.id);
        if (live.run || live.compactions?.length) throw new Error("Wait for the current work to finish before continuing.");
        if ((await tx.doc(QueueEditDoc, conversation.id)).edit) throw new Error("Finish editing the queued message first.");
        const queuedInput = (await tx.doc(InboxDoc, conversation.id)).items.some(item => item.mode !== "write");
        if (await tx.latestEntryId(conversation.id) !== tail) throw new Error("The conversation changed. Try continuing again.");
        if (!queuedInput && last?.role !== "user" && last?.role !== "toolResult") throw new Error("There is no unfinished response to continue.");
        await configure(tx, conversation.id, { model: { provider: model.provider, modelId: model.id }, thinkingLevel: thinking });
        await conversation.submit(tx, { type: "continue", requestId: input.requestId });
        // Native continue has no model message. This display-free receipt links
        // its settlement and admission time to the eventual final answer.
        await tx.appendEntry(conversation.id, { kind: continueEntryKind, data: { requestId: input.requestId, startedAt: Date.now() } });
      }, context);
      this.metadata.touchSession(input.sessionId);
    }, true);
  }

  cancelTask(input: Commands["chat:task-cancel"][0]): Promise<void> {
    return this.admit(async () => {
      const conversation = await this.conversation(input);
      const taskId = await conversation.commit(async tx => {
        const task = await tx.task(input.taskId as TaskId);
        if (!task || task.conversationId !== conversation.id || task.kind !== ToolTask.definition.name) {
          throw new Error("This tool does not belong to the selected conversation.");
        }
        if (task.state.status === "terminal" || task.abortRequested) return undefined;
        const live = await tx.doc(LiveDoc, conversation.id);
        if (!live.tools?.some(slot => slot.taskId === task.id && slot.status !== "done" && !slot.unoffered)) {
          throw new Error("This tool is no longer active in the selected conversation.");
        }
        return task.id;
      }, context);
      if (taskId === undefined) return;
      await this.harness.abortTask(taskId, context);
      await this.harness.waitForTask(taskId, context);
    });
  }

  removalPlan(target: RemovalTarget): RemovalPlan {
    const project = this.metadata.getProject(target.projectId);
    const selected = target.sessionId ? this.metadata.session(target.projectId, target.sessionId) : undefined;
    const sessions = this.metadata.sessionRows(project.id);
    const roots = selected ? [selected.conversationId] : sessions.map(row => row.conversationId);
    const conversations = conversationClosure(this.durablePath, roots);
    const affected = new Set(conversations);
    if (conversations.some(id => this.metadata.hasConversation(id) && this.metadata.projectOf(id) !== project.id)) {
      throw new Error("Removal would affect sessions in another workspace.");
    }
    const affectedSessions = sessions.filter(row => affected.has(row.conversationId));
    const sessionIds = affectedSessions.map(row => row.id);
    const blockingBranches = selected
      ? affectedSessions.filter(row => row.id !== selected.id)
        .sort((left, right) => right.conversationId - left.conversationId)
        .map(({ id, title }) => ({ id, title }))
      : [];
    const scope = createHash("sha256")
      .update(JSON.stringify([target.projectId, target.sessionId, conversations, [...sessionIds].sort()]))
      .digest("hex");
    return { scope, name: selected?.title ?? project.name, directory: project.directory,
      sessionCount: sessionIds.length, roots, conversations, sessionIds, blockingBranches };
  }

  remove(target: RemovalTarget, scope: string, prepare?: (reopenHarness: boolean) => Promise<void>): Promise<RemovalResult> {
    if (this.removing || this.closing) return Promise.reject(new Error("Another workspace operation is finishing."));
    const removal = this.performRemoval(target, scope, prepare);
    this.removing = removal;
    void removal.finally(() => { this.removing = undefined; }).catch(() => {});
    return removal;
  }

  private async performRemoval(target: RemovalTarget, scope: string, prepare?: (reopenHarness: boolean) => Promise<void>): Promise<RemovalResult> {
    await Promise.allSettled(this.admissions);
    const plan = this.removalPlan(target);
    if (plan.blockingBranches.length) throw new Error("Remove this session’s branches first.");
    if (plan.scope !== scope) throw new Error("The affected sessions changed. Review the removal again.");
    if (plan.conversations.length === 0 && !target.sessionId) {
      await prepare?.(false);
      await this.automation?.closeProject(target.projectId);
      this.metadata.removeEmptyProject(target.projectId);
      return { sessionIds: [] };
    }
    const affected = new Set(plan.conversations);
    const inspection = await this.harness.inspect(context);
    if (inspection.tasks.some(task => !affected.has(task.record.conversationId))) {
      throw new Error("Finish or stop work in other sessions before removing this item.");
    }
    const stop = withCancel(context);
    const timeout = setTimeout(() => stop.cancel(), 20_000);
    try {
      // Native forks are independent conversations. Each affected run must stop.
      await Promise.all(plan.conversations.map(async id => {
        const conversation = await this.harness.conversation(id, stop.context);
        if (conversation) await conversation.commit(tx => discardQueueEdit(tx, conversation.id), stop.context);
        await conversation?.abort(stop.context, { background: true });
      }));
    } finally {
      clearTimeout(timeout);
      stop.cancel();
    }
    await prepare?.(true);
    await Promise.all(plan.conversations.map(id => this.automation?.closeConversation(String(id))));
    if (!target.sessionId) await this.automation?.closeProject(target.projectId);
    this.activities.detach();
    await this.harness.close(context);
    let clean = true;
    try {
      const legacySpills = conversationSpillPaths(this.durablePath, plan.conversations);
      this.metadata.purge(this.durablePath, target.projectId, plan.roots, !target.sessionId, plan.conversations, legacySpills);
      this.activities.forget(plan.conversations);
      clean = await cleanupExpiredOutput(this.metadata, this.outputRoot);
    } finally {
      try {
        this.harness = await this.openHarness();
        await this.recoverQueueEdits();
        await this.activities.attach(this.harness);
        await this.resumeReleasedQueues();
        this.harness.resume();
      } catch (error) {
        this.onStorageFailure?.();
        throw error;
      }
    }
    return {
      sessionIds: plan.sessionIds,
      ...(clean ? {} : { warning: "Removed. Some tool output files could not be cleared. Pideck will retry when reopened." }),
    };
  }

  private assertWritable() {
    if (this.removing || this.closing) throw new Error("The workspace is finishing a removal.");
  }

  private async admit<T>(operation: () => Promise<T>, startsWork = false): Promise<T> {
    this.assertWritable();
    if (startsWork) this.activeAdmissions++;
    let admitted: Promise<T> | undefined;
    try {
      admitted = operation();
      this.admissions.add(admitted);
      return await admitted;
    } finally {
      if (admitted) this.admissions.delete(admitted);
      if (startsWork) this.activeAdmissions--;
    }
  }

  async watch(
    selection: Selection,
    emit: (view: ChatView) => void,
    onError?: (message: string) => void,
    readingEntryId?: number,
  ): Promise<ChatWatch> {
    const conversation = await this.conversation(selection);
    const scope = withCancel(context);
    // Conversation views mount built-in documents only. Observe the app's edit
    // document on the same commit line, then publish their combined state once.
    await conversation.commit(async tx => { await tx.doc(QueueEditDoc, conversation.id); }, scope.context);
    const transcript = new ConversationTranscript(
      (query, limit, loadContext) => conversation.entries(query, limit, undefined, loadContext),
    );
    const project = chatProjection();
    const completedRuns = new Map<number, CompletedRun>();
    const completionReads = new Map<number, Promise<void>>();
    const answerEntries = new Map<number, EntryId>();
    const harness = this.harness;
    const detach = new Set<() => void>();
    let graph: TaskGraph | undefined;
    let canContinue = false;
    let nativeView: ConversationView | undefined;
    let queueEdit: Readonly<QueueEditState> | undefined;
    let editAdvanced = false;
    let ready = false;
    let scheduled = false;
    let latest: TranscriptView | undefined;
    let stopped = false;
    let runTiming: { inputId?: number; taskId: number; startedAt?: number; endedAt?: number; settling?: true; read?: Promise<void> } | undefined;
    function emitCurrent() {
      if (!stopped && latest) emit(project(latest, completedRuns, graph, canContinue, runTiming?.startedAt, runTiming?.endedAt));
    }
    function readRunTiming(view: TranscriptView) {
      const live = view.docs["pi.live"] as LiveState | undefined;
      const run = live?.run;
      if (run) {
        const inputId = run.inputs[0];
        if (runTiming && runTiming.endedAt === undefined
            && (inputId !== undefined ? runTiming.inputId === inputId : runTiming.taskId === run.taskId)) {
          runTiming.taskId = run.taskId;
          return runTiming.read;
        }
        const timing: NonNullable<typeof runTiming> = { ...(inputId !== undefined ? { inputId } : {}), taskId: run.taskId };
        // Replace the previous range before reading a new run's origin. A slow
        // read must never show the previous run's total as the new live clock.
        runTiming = timing;
        timing.read = activeRunStartedAt(harness, conversation, run, scope.context).then(startedAt => {
          if (stopped || runTiming !== timing) return;
          timing.startedAt = startedAt;
          emitCurrent();
        }).catch(() => {});
        return timing.read;
      }
      const lastAssistant = view.items.findLast(item => item.kind === "entry" && item.entry.kind === "pi.assistant" && item.entry.byTaskId !== undefined);
      const assistantTaskId = lastAssistant?.kind === "entry" ? lastAssistant.entry.byTaskId : undefined;
      const taskId = Math.max(assistantTaskId ?? 0, live?.runFailure?.taskId ?? 0, runTiming?.taskId ?? 0);
      if (!taskId) return;
      if (runTiming?.taskId !== taskId) runTiming = { taskId };
      const timing = runTiming;
      if (timing.settling || timing.endedAt !== undefined) return timing.read;
      timing.settling = true;
      const originRead = timing.read;
      timing.read = Promise.resolve(originRead).then(async () => {
        let task = await harness.getTask(taskId as TaskId, scope.context);
        if (!task || task.kind !== GenerationTask.definition.name) return;
        if (task.state.status !== "terminal") {
          // A native end may still drain owned work as `completing`. Keep a
          // cached current origin, but never block initial watch attachment.
          // An inherited parent's task does not drive this idle fork's clock.
          if (task.conversationId === conversation.id) void harness.waitForTask(task.id, scope.context).then(() => {
            if (stopped || runTiming !== timing) return;
            timing.settling = undefined;
            timing.read = undefined;
            if (latest) void readRunTiming(latest);
          }).catch(() => {});
          return;
        }
        const answer = lastAssistant?.kind === "entry" && lastAssistant.entry.byTaskId === taskId ? lastAssistant.entry.id : undefined;
        const candidate = completedRuns.get(taskId) ?? await completedRun(harness, task, scope.context, answer);
        // A fork may expose an intermediate tool round whose native task later
        // answered in the parent. Its final result lies beyond this view's cut.
        const completion = candidate?.entryId === answer ? candidate : undefined;
        const failure = live?.runFailure?.taskId === taskId ? live.runFailure : undefined;
        const startedAt = timing.startedAt ?? completion?.startedAt
          ?? (failure ? await activeRunStartedAt(harness, conversation, failure, scope.context) : undefined);
        if (stopped || runTiming !== timing) return;
        if (completion) completedRuns.set(taskId, completion);
        if (startedAt !== undefined && task.endedAt !== undefined && Number.isFinite(task.endedAt) && task.endedAt >= startedAt) {
          timing.startedAt = startedAt;
          timing.endedAt = task.endedAt;
        } else {
          timing.startedAt = undefined;
        }
        emitCurrent();
      }).catch(() => {});
      // Keep the current origin visible through the terminal read, then freeze
      // at the persisted task end; no mount-time or observation-time substitute.
      return timing.read;
    }
    async function readContinuable(view: TranscriptView) {
      const live = view.docs["pi.live"] as LiveState | undefined;
      const held = view.docs[QueueEditDoc.definition.kind] as QueueEditState | undefined;
      if (live?.run || live?.compactions?.length || held?.edit) return;
      const inbox = view.docs["pi.inbox"] as InboxState | undefined;
      if (inbox?.items.some(item => item.mode !== "write")) {
        canContinue = true;
        emitCurrent();
        return;
      }
      if (live?.runFailure?.reason === "nothing_to_answer") return;
      const current = await conversation.context(scope.context);
      if (stopped || latest !== view) return;
      const last = current.messages.findLast(message => message.role !== "system");
      const tail = view.items.findLast(item => item.kind === "entry");
      if (current.entries.at(-1)?.id !== (tail?.kind === "entry" ? tail.entry.id : undefined)) return;
      if (last?.role === "user" || last?.role === "toolResult") {
        canContinue = true;
        emitCurrent();
      }
    }
    async function publishCompletion(task: NonNullable<Awaited<ReturnType<typeof harness.getTask>>>) {
      if (stopped) return;
      const completion = await completedRun(harness, task, scope.context, answerEntries.get(task.id));
      if (stopped || !completion) return;
      completedRuns.set(task.id, completion);
      emitCurrent();
    }
    function readCompletions(view: TranscriptView) {
      const reads = [];
      for (const item of view.items) {
        if (item.kind !== "entry" || item.entry.kind !== "pi.assistant" || item.entry.byTaskId === undefined) continue;
        const id = item.entry.byTaskId;
        answerEntries.set(id, item.entry.id);
        let read = completionReads.get(id);
        if (!read) {
          read = harness.getTask(id as TaskId, scope.context).then(async task => {
            if (!task || task.kind !== GenerationTask.definition.name) return;
            if (task.state.status === "terminal") await publishCompletion(task);
            else void harness.waitForTask(id as TaskId, scope.context).then(publishCompletion).catch(() => {});
          }).catch(() => {});
          completionReads.set(id, read);
        }
        reads.push(read);
      }
      return Promise.all(reads);
    }
    function publish(view: TranscriptView, force = false) {
      if (stopped) return;
      if (view === latest) {
        if (force) emitCurrent();
        return;
      }
      latest = view;
      canContinue = false;
      void readRunTiming(view);
      emitCurrent();
      void readCompletions(view);
      void readContinuable(view).catch(() => {});
    }
    function currentView(view: ConversationView) {
      return { ...view, docs: { ...view.docs, ...(queueEdit ? { [QueueEditDoc.definition.kind]: queueEdit } : {}) } };
    }
    function changed() {
      if (!ready || scheduled || stopped) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!stopped && nativeView) {
          try { publish(transcript.merge(currentView(nativeView)), true); }
          catch { ended(); }
        }
      });
    }
    function ended() {
      if (stopped) return;
      stopped = true;
      for (const stop of detach) stop();
      scope.cancel();
      onError?.("The conversation watch disconnected. Reconnect to refresh.");
    }
    try {
      const observedGraph = await harness.observeTaskGraph({
        advance(call) { if (call.kind === "value") { graph = call.value; changed(); } },
        end: ended,
      }, scope.context);
      detach.add(observedGraph.detach);
      graph ??= observedGraph.value;
      const observed = await harness.observeConversation(conversation.id, {
        advance(call) { if (call.kind === "value") { nativeView = call.value; changed(); } },
        end: ended,
      }, scope.context);
      detach.add(observed.detach);
      nativeView ??= observed.value;
      const observedEdit = await harness.observeDoc(QueueEditDoc, conversation.id, {
        advance(call) { if (call.kind === "value") { queueEdit = call.value; editAdvanced = true; changed(); } },
        end: ended,
      }, scope.context);
      if (!observedEdit) throw new Error("The queue edit state could not be watched.");
      detach.add(observedEdit.detach);
      if (!editAdvanced) queueEdit = observedEdit.value;
      const initial = currentView(nativeView);
      if (readingEntryId !== undefined && initial.before !== undefined && readingEntryId <= initial.before) {
        const entry = readingEntryId as EntryId;
        const [previous, following] = await Promise.all([
          conversation.entries({ maxEntryId: (entry - 1) as EntryId, order: "descending" }, 13, undefined, scope.context),
          conversation.entries({ minEntryId: entry, maxEntryId: initial.before, order: "ascending" }, 38, undefined, scope.context),
        ]);
        if (following.items.some(({ id }) => id === entry)) {
          const preceding = previous.items.slice(0, 12).reverse();
          const before = previous.items[12]?.id
            ?? (previous.next === undefined ? undefined : ((preceding[0]?.id ?? entry) - 1) as EntryId);
          transcript.merge({ ...initial, before, entries: [...preceding, ...following.items] });
        }
      }
      const first = transcript.merge(initial);
      await Promise.all([readCompletions(first), readRunTiming(first)]);
      ready = true;
      publish(transcript.merge(currentView(nativeView)));
    } catch (error) {
      scope.cancel();
      for (const stop of detach) stop();
      throw error;
    }
    return {
      dispose() {
        stopped = true;
        scope.cancel();
        for (const stop of detach) stop();
      },
      async loadEarlier() {
        if (stopped) return;
        await transcript.loadEarlier(scope.context);
        if (nativeView) publish(transcript.merge(currentView(nativeView)));
      },
      async fillGap(gap) {
        if (stopped) return;
        const item = latest?.items.find(candidate => candidate.kind === "gap"
          && candidate.after < gap.upTo && gap.after < candidate.upTo);
        if (item?.kind !== "gap") return;
        await transcript.fillGap(item, scope.context);
        if (nativeView) publish(transcript.merge(currentView(nativeView)));
      },
    };
  }

  close(): Promise<void> {
    // Set the gate before draining accepted writes. A send may still be
    // validating credentials and not have appeared in the task graph yet.
    this.closing ??= Promise.resolve().then(async () => {
      await this.removing?.catch(() => {});
      await Promise.allSettled(this.admissions);
      this.activities.detach();
      try { await this.harness.close(context); }
      finally { await this.automation?.closeAll(); }
    }).finally(() => this.metadata.close());
    return this.closing;
  }
}

async function cleanupExpiredOutput(metadata: Metadata, root: string): Promise<boolean> {
  let clean = true;
  const cleared: string[] = [];
  try {
    for (const path of metadata.outputCleanupPaths()) {
      try {
        removeLegacySpills([path]);
        cleared.push(path);
      } catch {
        clean = false;
      }
    }
    metadata.finishOutputCleanup(cleared);
  } catch {
    clean = false;
  }
  try {
    if (await isOutputDirectory(root)) {
      for (const name of await readdir(root)) {
        if (/^[1-9]\d*$/.test(name) && !metadata.hasConversation(Number(name))) {
          try { await rm(join(root, name), { recursive: true, force: true, maxRetries: 3 }); }
          catch { clean = false; }
        }
      }
    }
  } catch {
    clean = false;
  }
  return clean;
}

async function isOutputDirectory(root: string): Promise<boolean> {
  const info = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info && !info.isDirectory()) throw new Error("The tool output directory is not a regular directory.");
  return Boolean(info);
}
