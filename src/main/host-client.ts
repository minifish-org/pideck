import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import { CredentialVault } from "./credentials";
import { hostEnvironment } from "./host-env";
import type { HostEvent } from "../shared/api";
import type { FromHost, HostCommand, HostInput, HostRequest, HostResult, ToHost } from "../shared/transport";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class HostClient {
  private process?: UtilityProcess;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private stopping = false;
  private restartAttempts = 0;

  constructor(
    private dataDir: string,
    private vault: CredentialVault,
    private onEvent: (owner: number, event: HostEvent) => void,
    private onRestart: () => void,
    private onDisconnect: (message: string) => void,
  ) {}

  start(): void {
    if (this.stopping || this.process) return;
    const child = utilityProcess.fork(fileURLToPath(new URL("../host/worker.js", import.meta.url)), [], {
      env: hostEnvironment(),
      stdio: "ignore",
      serviceName: "Pideck workspace",
    });
    this.process = child;
    const boot = Promise.withResolvers<void>();
    this.ready = boot.promise;
    void this.ready.catch(() => { /* requests report startup errors */ });

    const timeout = setTimeout(() => child.kill(), 20_000);
    const startedAt = Date.now();
    const reconnecting = this.restartAttempts > 0;
    let initialized = false;
    let fatal = false;
    child.on("message", (message: FromHost) => {
      if (this.process !== child) return;
      if (message.type === "credential:read" || message.type === "credential:write") {
        const { id } = message;
        const reply = (value: ToHost) => { if (this.process === child) this.post(child, value); };
        const action = message.type === "credential:read"
          ? this.stopping ? Promise.reject(new Error("Pideck is closing."))
            : this.vault.snapshot().then(credentials => ({ type: "credential:snapshot", id, credentials } as const))
          : this.vault.write(message.provider, message.credential).then(() => ({ type: "credential:result", id } as const));
        void action.then(
          reply,
          error => {
            const reason = error instanceof Error ? error.message : "The provider credential store is unavailable.";
            reply(message.type === "credential:read" ? { type: "credential:snapshot", id, error: reason }
              : { type: "credential:result", id, error: reason });
          },
        );
        return;
      }
      if (this.stopping) return;
      switch (message.type) {
        case "ready":
          clearTimeout(timeout);
          initialized = true;
          boot.resolve();
          if (reconnecting) this.onRestart();
          break;
        case "fatal":
          clearTimeout(timeout);
          fatal = true;
          boot.reject(new Error(message.error));
          this.onDisconnect(message.error);
          child.kill();
          break;
        case "event":
          this.onEvent(message.owner, message.event);
          break;
        case "result": {
          const entry = this.pending.get(message.id);
          if (!entry) break;
          this.pending.delete(message.id);
          if (message.error !== undefined) entry.reject(new Error(message.error));
          else entry.resolve(message.value);
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (this.process !== child) return;
      this.process = undefined;
      const error = new Error(initialized
        ? "The workspace host disconnected."
        : `The workspace host could not start (exit ${code}).`);
      boot.reject(error);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();

      if (!fatal && !this.stopping) this.onDisconnect(error.message);
      if (initialized && Date.now() - startedAt >= 30_000) this.restartAttempts = 0;
      if (!fatal && !this.stopping && this.restartAttempts < 5) {
        const delay = Math.min(4_000, 250 * 2 ** this.restartAttempts++);
        const restart = new Promise<void>(resolve => setTimeout(resolve, delay)).then(() => {
          this.start();
          return this.process ? this.ready : undefined;
        });
        this.ready = restart;
        void restart.catch(() => { /* requests report startup errors */ });
      }
    });
    void this.vault.hasSavedCredentials().then(hasSavedCredentials => {
      if (this.process === child && !this.stopping) {
        this.post(child, { type: "start", dataDir: this.dataDir, hasSavedCredentials });
      }
    });
  }

  async request<C extends HostCommand>(owner: number, command: C, payload: HostInput[C]): Promise<HostResult[C]> {
    await this.ready;
    const child = this.process;
    if (!child || this.stopping) throw new Error("The workspace host is unavailable.");
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.post(child, { type: "request", id, owner, command, payload } as HostRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return response as Promise<HostResult[C]>;
  }

  async close() {
    this.stopping = true;
    const child = this.process;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      this.post(child, { type: "shutdown" });
    });
  }

  private post(child: UtilityProcess, message: ToHost) {
    child.postMessage(message);
  }
}
