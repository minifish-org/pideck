import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AgentDoc, configure, ConversationTranscript, createRegistry, defineExtension, Harness, section,
  type Conversation, type ConversationId, type EntryId, type InputSubmissionDraft, type TranscriptView,
} from "@earendil-works/pi-durable";
import { err, FileError, ok, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type {
  ChatGap, ChatView, ModelOption, QueuedInputRef, QueueUpdate, RemovalResult, SendChat, Selection, Session, SessionActivity,
  StartChat,
} from "../shared/api.js";
import type { RemovalPreview, RemovalTarget } from "../shared/transport.js";
import { branchTitle, firstSessionTitle, sessionTitle, untitledSession } from "../shared/session-title.js";
import { chatProjection, inputEntryKind } from "./chat-view.js";
import { Metadata } from "./metadata.js";
import { conversationClosure, conversationSpillPaths, removeLegacySpills } from "./purge.js";
import { readQueuedInput, updateQueuedInput } from "./queued-input.js";
import { shellEnvironment } from "./shell-env.js";
import { SessionActivities } from "./session-activity.js";
import { reviewWrites } from "./write-review.js";

const context = BACKGROUND_CONTEXT;
const instructions = [
  "You are Pideck, a coding agent working in the user's selected local project.",
  "Inspect relevant files before editing. Read AGENTS.md in relevant subdirectories for instructions scoped to those files.",
  "Use repository instructions within the scope of the user's task. Make focused changes, review the diff, and verify the result.",
  "For frontend verification, use the bash tool in the project to start the dev server and run Playwright CLI.",
  "Use the project's local Playwright CLI or a CLI already on PATH. If needed, run it with npx --yes --package @playwright/cli playwright-cli.",
  "Use a unique named browser session (playwright-cli -s=<name> open <url>), exercise the changed flow, and check its snapshot, screenshot, or console.",
  "For visual analysis, pass a screenshot to the read tool when your model supports images. Close the named browser session when finished.",
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
  constructor(cwd: string, private readonly outputDir: string) { super({ cwd }); }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, scope: Context) {
    return super.exec(command, { ...options, inheritEnv: false, env: shellEnvironment() }, scope);
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

function chatSubmission(input: StartChat | SendChat): InputSubmissionDraft {
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

export type ChatWatch = {
  dispose(): void;
  loadEarlier(): Promise<void>;
  fillGap(gap: Pick<ChatGap, "after" | "upTo">): Promise<void>;
};

export class Runtime {
  private closing?: Promise<void>;
  private removing?: Promise<RemovalResult>;
  private readonly admissions = new Set<Promise<unknown>>();
  private readonly starting = new Map<string, { projectId: string; result: Promise<Session> }>();
  private readonly activities = new SessionActivities(id => this.metadata.sessionSelection(id));

  private constructor(
    private readonly metadata: Metadata,
    private harness: Harness,
    readonly models: Models,
    private readonly durablePath: string,
    private readonly outputRoot: string,
    private readonly openHarness: () => Promise<Harness>,
    private readonly onStorageFailure?: () => void,
  ) {}

  static async open(
    dataDir: string,
    keys: Record<string, string> = {},
    suppliedModels?: Models,
    credentials: CredentialStore = new InMemoryCredentialStore(),
    onStorageFailure?: () => void,
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
        identity: { userAgent: { custom: "Pideck/0.1.0" } },
      });
      for (const [provider, key] of Object.entries(keys)) {
        if (key && models.getProvider(provider)?.auth.apiKey) {
          await credentials.modify(provider, async () => ({ type: "api_key", key }));
        }
      }
      if (!suppliedModels) await models.refresh({ allowNetwork: false });

      const registry = createRegistry();
      registry.install(createCodingTools({ images: await createNodePhotonImages() }));
      registry.install(defineExtension({
        name: "pideck",
        wraps: [reviewWrites],
        sections: [
          section("pideck", ({ env }) => env
            ? instructions + `\nThe project working directory is ${env.cwd}.`
            : instructions),
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
            const project = metadata.requireTrustedProject(metadata.projectOf(conversationId));
            if (project.directory !== cwd) throw new Error("Conversation directory does not match its project.");
            return new ToolEnvironment(cwd, join(outputRoot, String(conversationId)));
          },
        }, context);
        return harness;
      }
      const harness = await openHarness();
      const runtime = new Runtime(metadata, harness, models, durablePath, outputRoot, openHarness, onStorageFailure);
      try {
        if (await runtime.recoverSessionStarts()) {
          await harness.close(context);
          metadata.reapUnmapped(durablePath);
          runtime.harness = await openHarness();
        }
        await runtime.activities.attach(runtime.harness);
        await runtime.recoverSessionTitles();
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
  addProject(directory: string) { this.assertWritable(); return this.metadata.addProject(directory); }
  trustProject(projectId: string) { this.assertWritable(); return this.metadata.trustProject(projectId); }
  requireTrustedProject(projectId: string) { return this.metadata.requireTrustedProject(projectId); }
  listSessions(projectId: string) { return this.metadata.listSessions(projectId); }
  deviceId() { return this.metadata.deviceId(); }

  watchSessionActivity(listener: (items: SessionActivity[]) => void) {
    return this.activities.subscribe(listener);
  }

  readSessionActivity(selection: Selection, taskId: number) {
    const session = this.metadata.session(selection.projectId, selection.sessionId);
    this.activities.read(session.conversationId, taskId);
  }

  createSession(projectId: string, title?: string) {
    return this.admit(async () => {
      const project = this.metadata.getProject(projectId);
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

  async listModels(): Promise<ModelOption[]> {
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
    return this.admit(() => this.submitChat(input));
  }

  start(input: StartChat): Promise<Session> {
    return this.admit(async () => {
      const project = this.requireTrustedProject(input.projectId);
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
    });
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
      this.requireTrustedProject(projectId);
      this.metadata.createSession(projectId, conversation.id, firstSessionTitle(input.text), false, requestId);
    }, context);
    return this.metadata.finishSessionStart(requestId);
  }

  readQueuedInput(selection: QueuedInputRef): Promise<{ text: string; hasImages: boolean }> {
    return this.admit(async () => {
      this.requireTrustedProject(selection.projectId);
      const conversation = await this.conversation(selection);
      return conversation.commit(tx => readQueuedInput(tx, conversation.id, selection.id), context);
    });
  }

  updateQueuedInput(input: QueuedInputRef & QueueUpdate): Promise<void> {
    return this.admit(async () => {
      this.requireTrustedProject(input.projectId);
      const conversation = await this.conversation(input);
      return conversation.commit(tx => updateQueuedInput(tx, conversation.id, input.id, input), context);
    });
  }

  private async validateChatModel(input: StartChat | SendChat) {
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
    this.requireTrustedProject(input.projectId);
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
      if (delivery === "send") {
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
      await conversation.submit(tx, chatSubmission(input));
      return true;
    }, context);
    if (admitted) this.metadata.touchSession(input.sessionId);
    if (autoTitlePending) await this.nameFromFirstMessage(input.sessionId, conversation);
  }

  fork(selection: Selection, entryId: number, title?: string) {
    return this.admit(() => this.forkSession(selection, entryId, title));
  }

  private async forkSession(selection: Selection, entryId: number, title?: string) {
    this.requireTrustedProject(selection.projectId);
    const source = this.metadata.session(selection.projectId, selection.sessionId);
    const conversation = await this.conversation(selection);
    const at = entryId as EntryId;
    const entry = (await conversation.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, context)).items[0];
    if (!entry || !["pi.user", inputEntryKind, "pi.assistant"].includes(entry.kind)) {
      throw new Error("Choose a committed user or assistant message in this session.");
    }
    const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
    return this.metadata.createSession(selection.projectId, fork.id, (title && sessionTitle(title)) || branchTitle(source.title));
  }

  cancel(selection: Selection): Promise<void> {
    return this.admit(async () => {
      const conversation = await this.conversation(selection);
      await conversation.abort(context, { background: true });
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
        await conversation?.abort(stop.context, { background: true });
      }));
    } finally {
      clearTimeout(timeout);
      stop.cancel();
    }
    await prepare?.(true);
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
        await this.activities.attach(this.harness);
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

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    this.assertWritable();
    const admitted = operation();
    this.admissions.add(admitted);
    try { return await admitted; }
    finally { this.admissions.delete(admitted); }
  }

  async watch(
    selection: Selection,
    emit: (view: ChatView) => void,
    onError?: (message: string) => void,
    readingEntryId?: number,
  ): Promise<ChatWatch> {
    const conversation = await this.conversation(selection);
    const scope = withCancel(context);
    const watch = await conversation.watch(scope.context);
    const transcript = new ConversationTranscript(
      (query, limit, loadContext) => conversation.entries(query, limit, undefined, loadContext),
    );
    const project = chatProjection();
    let latest: TranscriptView;
    let stopped = false;
    function publish(view: TranscriptView) {
      if (stopped || view === latest) return;
      latest = view;
      emit(project(view));
    }
    try {
      const initial = watch.value;
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
      publish(transcript.merge(initial));
      watch.start(async call => {
        if (call.kind === "value") publish(transcript.merge(call.value));
      });
    } catch (error) {
      scope.cancel();
      await watch.stop();
      throw error;
    }

    void watch.closed.then(end => {
      if (!stopped && end.kind !== "ended") onError?.("The conversation watch disconnected. Reconnect to refresh.");
      stopped = true;
      scope.cancel();
    });
    return {
      dispose() {
        stopped = true;
        scope.cancel();
        void watch.stop();
      },
      async loadEarlier() {
        if (stopped) return;
        await transcript.loadEarlier(scope.context);
        publish(transcript.merge(watch.value));
      },
      async fillGap(gap) {
        if (stopped) return;
        const item = latest.items.find(candidate => candidate.kind === "gap"
          && candidate.after < gap.upTo && gap.after < candidate.upTo);
        if (item?.kind !== "gap") return;
        await transcript.fillGap(item, scope.context);
        publish(transcript.merge(watch.value));
      },
    };
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.removing?.catch(() => {});
      this.activities.detach();
      await this.harness.close(context);
    })().finally(() => this.metadata.close());
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
