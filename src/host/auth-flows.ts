import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt as NativePrompt, CredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AuthLink, AuthMethod, AuthNotice, AuthPrompt, HostEvent, ModelProvider } from "../shared/api";

type Flow = {
  id: string;
  provider: string;
  controller: AbortController;
  prompts: Map<string, (value: string) => void>;
  links: Map<string, string>;
  codes: Map<string, string>;
};

export class AuthFlows {
  private readonly active = new Map<number, Flow>();

  constructor(
    private readonly models: Models,
    private readonly credentials: CredentialStore,
    private readonly emit: (owner: number, event: HostEvent) => void,
    private readonly getDeviceId?: () => string,
  ) {}

  async providers(): Promise<ModelProvider[]> {
    const stored = new Map((await this.credentials.list()).map(value => [value.providerId, value.type]));
    return Promise.all(this.models.getProviders().map(async provider => {
      const methods: ModelProvider["methods"] = [];
      if (provider.auth.apiKey?.login) methods.push({ type: "api_key", name: provider.auth.apiKey.name });
      if (provider.auth.oauth) methods.push({ type: "oauth", name: provider.auth.oauth.name });
      const configured = await this.models.checkAuth(provider.id, { signal: AbortSignal.timeout(2500) })
        .then(Boolean, () => false);
      return { id: provider.id, name: provider.name, methods, credential: stored.get(provider.id), configured,
        dynamic: Boolean(provider.refreshModels) };
    }));
  }

  async login(owner: number, id: string, providerId: string, method: AuthMethod): Promise<void> {
    if (this.active.has(owner)) throw new Error("Finish the current provider setup first.");
    const provider = this.models.getProvider(providerId);
    const auth = method === "oauth" ? provider?.auth.oauth : provider?.auth.apiKey;
    if (!auth?.login) throw new Error("This provider does not support that sign-in method.");
    const flow: Flow = { id, provider: providerId, controller: new AbortController(),
      prompts: new Map(), links: new Map(), codes: new Map() };
    this.active.set(owner, flow);
    const signal = flow.controller.signal;
    try {
      await this.models.login(providerId, method, {
        signal,
        prompt: prompt => this.prompt(owner, flow, prompt),
        notify: event => this.notify(owner, flow, event),
      }, { getDeviceId: this.getDeviceId, agentName: "Pideck" });
      if (provider?.refreshModels && !signal.aborted) {
        this.notify(owner, flow, { type: "progress", message: "Refreshing the provider’s model catalog…" });
        const refreshed = await this.models.refresh({ providers: [providerId],
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        if (refreshed.errors.size && !signal.aborted) this.notify(owner, flow, {
          type: "info", message: "Signed in. Use Refresh catalog to retry loading the models.",
        });
      }
    } catch {
      if (signal.aborted) throw new Error("Provider setup was cancelled.");
      throw new Error("Provider setup failed. Check the sign-in details and that your system credential store is available.");
    } finally {
      flow.controller.abort();
      if (this.active.get(owner) === flow) this.active.delete(owner);
    }
  }

  async logout(provider: string): Promise<void> {
    if (!this.models.getProvider(provider)) throw new Error("Unknown model provider.");
    if ([...this.active.values()].some(flow => flow.provider === provider)) {
      throw new Error("Finish the current provider setup first.");
    }
    try {
      await this.models.logout(provider);
    } catch {
      throw new Error("The saved provider credential could not be removed.");
    }
  }

  async refresh(provider?: string): Promise<void> {
    if (provider && !this.models.getProvider(provider)) throw new Error("Unknown model provider.");
    const result = await this.models.refresh({
      providers: provider ? [provider] : undefined,
      force: true,
      signal: AbortSignal.timeout(30_000),
    });
    if (result.aborted || result.errors.size) {
      throw new Error("Some model catalogs could not be refreshed. Previously downloaded models are still available.");
    }
  }

  answer(owner: number, id: string, promptId: string, value: string): void {
    const answer = this.flow(owner, id).prompts.get(promptId);
    if (!answer) throw new Error("This provider prompt is no longer active.");
    answer(value);
  }

  cancel(owner: number, id: string): void {
    const flow = this.active.get(owner);
    if (flow?.id === id) flow.controller.abort();
  }

  closeOwner(owner: number): void {
    this.active.get(owner)?.controller.abort();
  }

  close(): void {
    for (const flow of this.active.values()) flow.controller.abort();
  }

  link(owner: number, id: string, linkId: string): string {
    const link = this.flow(owner, id).links.get(linkId);
    if (!link) throw new Error("This sign-in link is no longer active.");
    return link;
  }

  code(owner: number, id: string, copyId: string): string {
    const code = this.flow(owner, id).codes.get(copyId);
    if (!code) throw new Error("This device code is no longer active.");
    return code;
  }

  private flow(owner: number, id: string): Flow {
    const flow = this.active.get(owner);
    if (!flow || flow.id !== id || flow.controller.signal.aborted) throw new Error("This provider setup is no longer active.");
    return flow;
  }

  private prompt(owner: number, flow: Flow, incoming: NativePrompt): Promise<string> {
    const signal = incoming.signal
      ? AbortSignal.any([flow.controller.signal, incoming.signal]) : flow.controller.signal;
    signal.throwIfAborted();
    const prompt: AuthPrompt = incoming.type === "select"
      ? { type: incoming.type, message: incoming.message, options: incoming.options }
      : { type: incoming.type, message: incoming.message, placeholder: incoming.placeholder };
    const promptId = randomUUID();
    return new Promise((resolve, reject) => {
      const dispose = () => {
        signal.removeEventListener("abort", abort);
        flow.prompts.delete(promptId);
        this.emit(owner, { type: "auth:prompt-closed", flowId: flow.id, promptId });
      };
      const abort = () => {
        dispose();
        reject(signal.reason);
      };
      flow.prompts.set(promptId, value => {
        if (prompt.type === "select" && !prompt.options.some(option => option.id === value)) {
          throw new Error("Select one of the available provider options.");
        }
        dispose();
        resolve(value);
      });
      signal.addEventListener("abort", abort, { once: true });
      this.emit(owner, { type: "auth:prompt", flowId: flow.id, promptId, prompt });
    });
  }

  private notify(owner: number, flow: Flow, event: AuthEvent) {
    if (flow.controller.signal.aborted) return;
    let notice: AuthNotice;
    switch (event.type) {
      case "info": {
        const links = event.links?.flatMap(item => {
          const link = this.rememberLink(flow, item.url, item.label);
          return link ? [link] : [];
        });
        notice = { type: "info", message: event.message, links };
        break;
      }
      case "progress":
        notice = { type: "progress", message: event.message };
        break;
      case "auth_url": {
        const link = this.rememberLink(flow, event.url);
        if (!link) return;
        notice = { type: "auth_url", link, instructions: event.instructions };
        break;
      }
      case "device_code": {
        const link = event.openBrowserOnConfirm === false ? undefined : this.rememberLink(flow, event.verificationUri);
        const copyId = event.copyCodeOnConfirm === false ? undefined : randomUUID();
        if (copyId) flow.codes.set(copyId, event.userCode);
        notice = { type: "device_code", code: event.userCode, link, copyId, expiresInSeconds: event.expiresInSeconds };
        break;
      }
    }
    this.emit(owner, { type: "auth:notice", flowId: flow.id, notice });
  }

  private rememberLink(flow: Flow, raw: string, label = "Open in browser"): AuthLink | undefined {
    const url = safeAuthUrl(raw);
    if (!url) return;
    const id = randomUUID();
    flow.links.set(id, url.href);
    return { id, label, domain: url.host };
  }
}

export function safeAuthUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}
