import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel, type Context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AgentDoc, configure, ConversationTranscript, createRegistry, defineExtension, Harness, section,
  type Conversation, type ConversationId, type EntryId, type TranscriptView,
} from "@earendil-works/pi-durable";
import { err, FileError, ok, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { ChatGap, ChatView, ModelOption, RemovalResult, SendChat, Selection } from "../shared/api.js";
import type { RemovalPreview, RemovalTarget } from "../shared/transport.js";
import { chatProjection, inputEntryKind } from "./chat-view.js";
import { Metadata } from "./metadata.js";
import { conversationClosure, conversationSpillPaths, removeLegacySpills } from "./purge.js";
import { shellEnvironment } from "./shell-env.js";
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

export type ChatWatch = {
  dispose(): void;
  loadEarlier(): Promise<void>;
  fillGap(gap: Pick<ChatGap, "after" | "upTo">): Promise<void>;
};

export class Runtime {
  private closing?: Promise<void>;
  private removing?: Promise<RemovalResult>;
  private readonly admissions = new Set<Promise<unknown>>();

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
        harness.resume();
        return harness;
      }
      return new Runtime(metadata, await openHarness(), models, durablePath, outputRoot, openHarness, onStorageFailure);
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

  createSession(projectId: string, title = "New session") {
    return this.admit(async () => {
      const project = this.metadata.getProject(projectId);
      const conversation = await this.harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { cwd: project.directory },
      }, context);
      return this.metadata.createSession(projectId, conversation.id, title);
    });
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

  private async submitChat(input: SendChat): Promise<void> {
    this.requireTrustedProject(input.projectId);
    const conversation = await this.conversation(input);
    const { requestId } = input;
    if (requestId) {
      // An acknowledgement lost during restart still belongs to the original
      // admission, even if the catalog or credentials have changed meanwhile.
      const accepted = await conversation.commit(tx => tx.submissionByRequest(conversation.id, requestId), context);
      if (accepted) return;
    }
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
    const images = input.images ?? [];
    if (images.length && !model.input.includes("image")) throw new Error("This model does not accept images.");
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
      await conversation.submit(tx, {
        type: "input",
        whenBusy: delivery === "send" ? "reject" : delivery === "steer" ? "steer" : "followUp",
        ...(delivery !== "send" ? { whenIdle: "reject" } : {}),
        ...(requestId ? {
          requestId,
          entry: { kind: inputEntryKind, data: { requestId } },
        } : {}),
        content: images.length ? [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ] : input.text,
      });
      return true;
    }, context);
    if (admitted) this.metadata.touchSession(input.sessionId);
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
    return this.metadata.createSession(selection.projectId, fork.id, title?.trim() || `Fork of ${source.title}`.slice(0, 120));
  }

  async compact(selection: Selection, instructions?: string): Promise<"compacted" | "no-change" | "stopped" | "failed"> {
    const { harness, taskId } = await this.admit(async () => {
      this.requireTrustedProject(selection.projectId);
      const harness = this.harness;
      const conversation = await this.conversation(selection);
      return { harness, taskId: await conversation.compact(instructions, context) };
    });
    const { outcome } = (await harness.waitForTask(taskId, context)).state;
    if (outcome.status === "aborted") return "stopped";
    if (outcome.status !== "completed") return "failed";
    if (outcome.result.submissionId === undefined) return "no-change";
    const summary = await harness.submission(outcome.result.submissionId, context);
    return (await summary?.wait(context))?.status === "done" ? "compacted" : "no-change";
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
    const sessionIds = sessions.filter(row => affected.has(row.conversationId)).map(row => row.id);
    if (selected && sessionIds.length > 1) throw new Error("Remove this session’s branches first.");
    const scope = createHash("sha256")
      .update(JSON.stringify([target.projectId, target.sessionId, conversations, [...sessionIds].sort()]))
      .digest("hex");
    return { scope, name: selected?.title ?? project.name, directory: project.directory,
      sessionCount: sessionIds.length, roots, conversations, sessionIds };
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
    await this.harness.close(context);
    let clean = true;
    try {
      const legacySpills = conversationSpillPaths(this.durablePath, plan.conversations);
      this.metadata.purge(this.durablePath, target.projectId, plan.roots, !target.sessionId, plan.conversations, legacySpills);
      clean = await cleanupExpiredOutput(this.metadata, this.outputRoot);
    } finally {
      try {
        this.harness = await this.openHarness();
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
      publish(transcript.merge(watch.value));
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
