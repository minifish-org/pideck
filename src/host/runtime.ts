import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { configure, createRegistry, defineExtension, Harness, section, type Conversation } from "@earendil-works/pi-durable";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ChatView, ModelOption, SendChat, Selection } from "../shared/api.js";
import { projectChatView } from "./chat-view.js";
import { Metadata } from "./metadata.js";
import { shellEnvironment } from "./shell-env.js";

const context = BACKGROUND_CONTEXT;
const instructions = [
  "You are Pideck, a coding agent working in the user's selected local project.",
  "Inspect relevant files and project instructions before editing. Make focused changes, review the diff, and verify the result.",
  "For frontend verification, use the bash tool in the project to start the dev server and run Playwright CLI.",
  "Use the project's local Playwright CLI or a CLI already on PATH. If needed, run it with npx --yes --package @playwright/cli playwright-cli.",
  "Use a unique named browser session (playwright-cli -s=<name> open <url>), exercise the changed flow, and check its snapshot, screenshot, or console.",
  "For visual analysis, pass a screenshot to the read tool when your model supports images. Close the named browser session when finished.",
].join("\n");

class ToolEnvironment extends NodeExecutionEnv {
  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, scope: Context) {
    return super.exec(command, { ...options, inheritEnv: false, env: shellEnvironment() }, scope);
  }
}

export class Runtime {
  private closing?: Promise<void>;

  private constructor(
    private readonly metadata: Metadata,
    private readonly harness: Harness,
    private readonly models: Models,
    private readonly credentials: InMemoryCredentialStore,
  ) {}

  static async open(dataDir: string, keys: Record<string, string> = {}, suppliedModels?: Models): Promise<Runtime> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const metadata = new Metadata(join(dataDir, "workspace.sqlite"));
    try {
      const credentials = new InMemoryCredentialStore();
      const providerModels = createModels({
        credentials,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      providerModels.setProvider(openaiProvider());
      providerModels.setProvider(anthropicProvider());
      const models = suppliedModels ?? providerModels;
      for (const provider of models.getProviders()) {
        const key = keys[provider.id];
        if (typeof key === "string" && key) {
          await credentials.modify(provider.id, async () => ({ type: "api_key", key }));
        }
      }

      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(defineExtension({
        name: "pideck",
        sections: [section("pideck", ({ env }) => env
          ? instructions + `\nThe project working directory is ${env.cwd}.`
          : instructions)],
      }));
      const storage = await openNodeSqliteStorage(join(dataDir, "conversations.sqlite"));
      const harness = await Harness.open(storage, {
        models,
        registry,
        env: ({ conversationId, cwd }) => {
          const project = metadata.requireTrustedProject(metadata.projectOf(conversationId));
          if (project.directory !== cwd) throw new Error("Conversation directory does not match its project.");
          return new ToolEnvironment({ cwd });
        },
      }, context);
      harness.resume();
      return new Runtime(metadata, harness, models, credentials);
    } catch (error) {
      metadata.close();
      throw error;
    }
  }

  listProjects() { return this.metadata.listProjects(); }
  addProject(directory: string) { return this.metadata.addProject(directory); }
  trustProject(projectId: string) { return this.metadata.trustProject(projectId); }
  requireTrustedProject(projectId: string) { return this.metadata.requireTrustedProject(projectId); }
  listSessions(projectId: string) { return this.metadata.listSessions(projectId); }

  async createSession(projectId: string, title = "New session") {
    const project = this.metadata.getProject(projectId);
    const conversation = await this.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { cwd: project.directory },
    }, context);
    return this.metadata.createSession(projectId, conversation.id, title);
  }

  async listModels(): Promise<ModelOption[]> {
    const available = await this.models.getAvailable();
    const configured = new Set(available.map(model => `${model.provider}/${model.id}`));
    return this.models.getModels().map(model => ({
      id: model.id,
      provider: model.provider,
      name: model.name,
      configured: configured.has(`${model.provider}/${model.id}`),
      thinking: getSupportedThinkingLevels(model),
      supportsImages: model.input.includes("image"),
    }));
  }

  async saveKey(provider: string, key: string): Promise<void> {
    if (!this.models.getProvider(provider)) throw new Error("Unknown model provider.");
    if (key) {
      await this.credentials.modify(provider, async () => ({ type: "api_key", key }));
    } else {
      await this.credentials.delete(provider);
    }
  }

  private async conversation(selection: Selection): Promise<Conversation> {
    const session = this.metadata.session(selection.projectId, selection.sessionId);
    const conversation = await this.harness.conversation(session.conversationId, context);
    if (!conversation) throw new Error("The conversation could not be reopened.");
    return conversation;
  }

  async send(input: SendChat): Promise<void> {
    this.requireTrustedProject(input.projectId);
    const conversation = await this.conversation(input);
    const model = this.models.getModel(input.model.provider, input.model.id);
    if (!model) throw new Error("The selected model is unavailable.");
    if (!await this.models.checkAuth(model.provider)) throw new Error("Set an API key for this provider before sending.");
    if (!getSupportedThinkingLevels(model).includes(input.thinking)) {
      throw new Error("The selected model does not support this thinking level.");
    }
    const images = input.images ?? [];
    if (images.length && !model.input.includes("image")) throw new Error("This model does not accept images.");

    await conversation.commit(async tx => {
      await configure(tx, conversation.id, {
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: input.thinking,
      });
      await conversation.submit(tx, {
        type: "input",
        whenBusy: "reject",
        content: images.length ? [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ] : input.text,
      });
    }, context);
    this.metadata.touchSession(input.sessionId);
  }

  async cancel(selection: Selection): Promise<void> {
    const conversation = await this.conversation(selection);
    await conversation.abort(context, { background: true });
  }

  async watch(
    selection: Selection,
    emit: (view: ChatView) => void,
    onError?: (message: string) => void,
  ): Promise<() => void> {
    const conversation = await this.conversation(selection);
    const watch = await conversation.watch(context);
    try {
      emit(projectChatView(watch.value));
      watch.start(async call => {
        if (call.kind === "value") emit(projectChatView(call.value));
      });
    } catch (error) {
      await watch.stop();
      throw error;
    }

    let stopped = false;
    void watch.closed.then(end => {
      if (!stopped && end.kind !== "ended") onError?.("The conversation watch disconnected. Reconnect to refresh.");
    });
    return () => {
      stopped = true;
      void watch.stop();
    };
  }

  close(): Promise<void> {
    this.closing ??= this.harness.close(context).finally(() => this.metadata.close());
    return this.closing;
  }
}
