import { Runtime } from "./runtime";
import { listChanges, readPatch } from "./review";
import { Terminals } from "./terminal";
import type { FromHost, HostRequest, ToHost } from "../shared/transport";
import type { HostEvent } from "../shared/api";

const port = process.parentPort;
if (!port) throw new Error("The Pideck host requires an Electron utility process.");

let runtime: Runtime | undefined;
let starting = false;
let closing = false;
const closedOwners = new Set<number>();
const watches = new Map<number, Map<string, { dispose?: () => void }>>();

function send(message: FromHost) {
  port!.postMessage(message);
}

function emit(owner: number, event: HostEvent) {
  if (!closedOwners.has(owner) && !closing) send({ type: "event", owner, event });
}

const terminals = new Terminals(emit);

function unwatch(owner: number, subscriptionId: string) {
  const owned = watches.get(owner);
  const watch = owned?.get(subscriptionId);
  owned?.delete(subscriptionId);
  if (owned?.size === 0) watches.delete(owner);
  watch?.dispose?.();
}

function closeOwner(owner: number) {
  closedOwners.add(owner);
  for (const id of watches.get(owner)?.keys() ?? []) unwatch(owner, id);
  terminals.closeOwner(owner);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "The workspace operation failed.";
}

async function handle(request: HostRequest): Promise<unknown> {
  const { owner, command, payload } = request;
  if (!runtime || closing || closedOwners.has(owner)) throw new Error("The workspace host is closed.");
  switch (command) {
    case "owner:close":
      return closeOwner(owner);
    case "project:list":
      return runtime.listProjects();
    case "project:add":
      return runtime.addProject(payload.directory);
    case "project:trust":
      return runtime.trustProject(payload.projectId);
    case "session:list":
      return runtime.listSessions(payload.projectId);
    case "session:create":
      return runtime.createSession(payload.projectId, payload.title);
    case "model:list":
      return runtime.listModels();
    case "model:save-key":
      return runtime.saveKey(payload.provider, payload.key);
    case "chat:send":
      return runtime.send(payload);
    case "chat:cancel":
      return runtime.cancel(payload);
    case "chat:unwatch":
      return unwatch(owner, payload.subscriptionId);
    case "chat:watch": {
      const { projectId, sessionId, subscriptionId } = payload;
      unwatch(owner, subscriptionId);
      const owned = watches.get(owner) ?? new Map();
      const entry: { dispose?: () => void } = {};
      owned.set(subscriptionId, entry);
      watches.set(owner, owned);
      let sequence = 0;
      try {
        const dispose = await runtime.watch(payload, view => {
          if (owned.get(subscriptionId) !== entry) return;
          emit(owner, { type: "chat:update", subscriptionId, projectId, sessionId, sequence: ++sequence, view });
        }, error => {
          if (owned.get(subscriptionId) !== entry) return;
          unwatch(owner, subscriptionId);
          emit(owner, { type: "chat:error", subscriptionId, projectId, sessionId, message: messageOf(error) });
        });
        if (owned.get(subscriptionId) === entry) entry.dispose = dispose;
        else dispose();
      } catch (error) {
        if (owned.get(subscriptionId) === entry) unwatch(owner, subscriptionId);
        throw error;
      }
      return;
    }
    case "review:list":
      return listChanges((await runtime.requireTrustedProject(payload.projectId)).directory);
    case "review:patch":
      return readPatch((await runtime.requireTrustedProject(payload.projectId)).directory, payload.path);
    case "terminal:open": {
      const project = await runtime.requireTrustedProject(payload.projectId);
      if (closedOwners.has(owner) || closing) throw new Error("This window has closed.");
      return terminals.open(owner, project.id, project.directory, payload.cols, payload.rows);
    }
    case "terminal:input":
      return terminals.input(owner, payload.projectId, payload.terminalId, payload.data);
    case "terminal:resize":
      return terminals.resize(owner, payload.projectId, payload.terminalId, payload.cols, payload.rows);
    case "terminal:close":
      return terminals.close(owner, payload.projectId, payload.terminalId);
  }
}

port.on("message", ({ data }: { data: ToHost }) => {
  if (data.type === "start" && !starting) {
    starting = true;
    void Runtime.open(data.dataDir, data.keys).then(opened => {
      runtime = opened;
      send({ type: "ready" });
    }, error => {
      send({ type: "fatal", error: messageOf(error) });
    });
  } else if (data.type === "request") {
    void handle(data).then(
      value => send({ type: "result", id: data.id, value }),
      error => send({ type: "result", id: data.id, error: messageOf(error) }),
    );
  } else if (data.type === "shutdown" && !closing) {
    closing = true;
    for (const owner of watches.keys()) closeOwner(owner);
    terminals.closeAll();
    void Promise.resolve(runtime?.close()).finally(() => process.exit(0));
  }
});
