import { diffRevisions, type JsonValue } from "@earendil-works/chord/delta";
import { AuthFlows } from "./auth-flows";
import { PersistentCredentials } from "./credential-store";
import { Runtime, type ChatWatch } from "./runtime";
import { listChanges, readPatch } from "./review";
import { Terminals } from "./terminal";
import type { FromHost, HostRequest, ToHost } from "../shared/transport";
import type { ChatView, HostEvent, Selection } from "../shared/api";

const port = process.parentPort;
if (!port) throw new Error("The Pideck host requires an Electron utility process.");

let runtime: Runtime | undefined;
let auth: AuthFlows | undefined;
let starting = false;
let closing = false;
const closedOwners = new Set<number>();
const watches = new Map<number, Map<string, Selection & { watch?: ChatWatch }>>();
const credentialWrites = new Map<number, PromiseWithResolvers<void>>();
let nextWrite = 0;

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
  watch?.watch?.dispose();
}

function closeOwner(owner: number) {
  closedOwners.add(owner);
  for (const id of watches.get(owner)?.keys() ?? []) unwatch(owner, id);
  terminals.closeOwner(owner);
  auth?.closeOwner(owner);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "The workspace operation failed.";
}

async function handle(request: HostRequest): Promise<unknown> {
  const { owner, command, payload } = request;
  if (!runtime || !auth || closing || closedOwners.has(owner)) throw new Error("The workspace host is closed.");
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
    case "model:providers":
      return auth.providers();
    case "model:login":
      return auth.login(owner, payload.flowId, payload.provider, payload.method);
    case "model:logout":
      return auth.logout(payload.provider);
    case "model:refresh":
      return auth.refresh(payload.provider);
    case "model:auth-answer":
      return auth.answer(owner, payload.flowId, payload.promptId, payload.value);
    case "model:auth-cancel":
      return auth.cancel(owner, payload.flowId);
    case "model:auth-open":
      return auth.link(owner, payload.flowId, payload.linkId);
    case "model:auth-copy":
      return auth.code(owner, payload.flowId, payload.copyId);
    case "chat:send":
      return runtime.send(payload);
    case "chat:cancel":
      return runtime.cancel(payload);
    case "chat:fork":
      return runtime.fork(payload, payload.entryId, payload.title);
    case "chat:compact":
      return runtime.compact(payload, payload.instructions);
    case "chat:unwatch":
      return unwatch(owner, payload.subscriptionId);
    case "chat:earlier": {
      const entry = watches.get(owner)?.get(payload.subscriptionId);
      if (!entry?.watch || entry.projectId !== payload.projectId || entry.sessionId !== payload.sessionId) {
        throw new Error("This conversation watch is no longer active.");
      }
      return payload.gap ? entry.watch.fillGap(payload.gap) : entry.watch.loadEarlier();
    }
    case "chat:watch": {
      const { projectId, sessionId, subscriptionId } = payload;
      unwatch(owner, subscriptionId);
      const owned = watches.get(owner) ?? new Map();
      if (owned.size >= 8) throw new Error("Close an existing conversation watch first.");
      const entry: Selection & { watch?: ChatWatch } = { projectId, sessionId };
      owned.set(subscriptionId, entry);
      watches.set(owner, owned);
      let sequence = 0;
      let previous: ChatView | undefined;
      try {
        const watch = await runtime.watch(payload, view => {
          if (owned.get(subscriptionId) !== entry) return;
          const update = { type: "chat:update" as const, subscriptionId, projectId, sessionId };
          if (!previous) emit(owner, { ...update, sequence: ++sequence, view });
          else {
            const ops = diffRevisions(previous as JsonValue, view as JsonValue);
            if (ops.length) emit(owner, { ...update, sequence: ++sequence, ops });
          }
          previous = view;
        }, error => {
          if (owned.get(subscriptionId) !== entry) return;
          unwatch(owner, subscriptionId);
          emit(owner, { type: "chat:error", subscriptionId, projectId, sessionId, message: messageOf(error) });
        });
        if (owned.get(subscriptionId) === entry) entry.watch = watch;
        else watch.dispose();
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
    case "terminal:sync":
      return terminals.sync(owner, payload.projectId, payload.terminalId, payload.through, payload.replay);
  }
}

port.on("message", ({ data }: { data: ToHost }) => {
  if (data.type === "start" && !starting) {
    starting = true;
    const credentials = new PersistentCredentials(data.credentials, (provider, credential) => {
      const id = ++nextWrite;
      const write = Promise.withResolvers<void>();
      credentialWrites.set(id, write);
      send({ type: "credential:write", id, provider, credential });
      return write.promise;
    }, data.credentialStoreLocked);
    void Runtime.open(data.dataDir, {}, undefined, credentials, () => process.exit(1)).then(opened => {
      runtime = opened;
      auth = new AuthFlows(opened.models, credentials, emit, () => opened.deviceId());
      send({ type: "ready" });
    }, error => {
      send({ type: "fatal", error: messageOf(error) });
    });
  } else if (data.type === "credential:result") {
    const write = credentialWrites.get(data.id);
    credentialWrites.delete(data.id);
    if (data.error) write?.reject(new Error(data.error));
    else write?.resolve();
  } else if (data.type === "request") {
    void handle(data).then(
      value => send({ type: "result", id: data.id, value }),
      error => send({ type: "result", id: data.id, error: messageOf(error) }),
    );
  } else if (data.type === "shutdown" && !closing) {
    closing = true;
    for (const owner of watches.keys()) closeOwner(owner);
    terminals.closeAll();
    auth?.close();
    void Promise.resolve(runtime?.close()).finally(() => process.exit(0));
  }
});
