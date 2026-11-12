import { diffRevisions, type JsonValue } from "@earendil-works/chord/delta";
import type { Credential } from "@earendil-works/pi-ai";
import { AuthFlows } from "./auth-flows";
import { PersistentCredentials } from "./credential-store";
import { join } from "node:path";
import { Runtime, type ChatWatch } from "./runtime";
import { listChanges, readPatch, watchChanges } from "./review";
import { readMessageFile, resolveMessageFile } from "./message-links";
import { Terminals } from "./terminal";
import type { FromHost, HostRequest, RemovalTarget, ToHost } from "../shared/transport";
import type { ChatView, HostEvent, RemovalResult, Selection } from "../shared/api";

const port = process.parentPort;
if (!port) throw new Error("The Pideck host requires an Electron utility process.");

let runtime: Runtime | undefined;
let auth: AuthFlows | undefined;
let starting = false;
let closing = false;
let opening: Promise<Runtime> | undefined;
let shutdownReceipt: { error?: string } | undefined;
let removing: RemovalTarget | undefined;
const closedOwners = new Set<number>();
const watches = new Map<number, Map<string, Selection & { watch?: ChatWatch }>>();
const activityWatches = new Map<number, { id: string; dispose: () => void }>();
const credentialWrites = new Map<number, PromiseWithResolvers<void>>();
let credentialRead: { id: number; result: PromiseWithResolvers<Record<string, Credential>> } | undefined;
const reviews = new Map<string, Set<{ owner: number; requestId?: string; controller: AbortController; pending: Promise<unknown> }>>();
const reviewWatches = new Map<number, { projectId: string; subscriptionId: string; controller: AbortController }>();
let nextCredentialRequest = 0;

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

function closeReviewWatch(owner: number) {
  const watch = reviewWatches.get(owner);
  reviewWatches.delete(owner);
  watch?.controller.abort();
}

function closeOwner(owner: number, windowId = owner, preserveQueueEdits = false) {
  closedOwners.add(owner);
  for (const id of watches.get(owner)?.keys() ?? []) unwatch(owner, id);
  activityWatches.get(owner)?.dispose();
  activityWatches.delete(owner);
  closeReviewWatch(owner);
  for (const jobs of reviews.values()) for (const job of jobs) {
    if (job.owner === owner) job.controller.abort(new Error("Review stopped because the window closed."));
  }
  terminals.closeOwner(owner);
  auth?.closeOwner(owner);
  return preserveQueueEdits ? undefined : runtime?.detachQueueEdits(windowId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "The workspace operation failed.";
}

function requireOpenWorkspace(projectId: string) {
  if (removing?.projectId === projectId && !removing.sessionId) throw new Error("This workspace is being removed.");
}

async function runReview<T>(runtime: Runtime, owner: number, projectId: string,
  read: (cwd: string, signal: AbortSignal) => Promise<T>, requestId?: string) {
  requireOpenWorkspace(projectId);
  const project = runtime.requireProject(projectId);
  const jobs = reviews.get(projectId) ?? new Set();
  if (requestId && [...jobs].some(job => job.owner === owner && job.requestId === requestId)) {
    throw new Error("This file preview is already opening.");
  }
  const controller = new AbortController();
  const pending = Promise.resolve().then(() => read(project.directory, controller.signal));
  const job = { owner, requestId, controller, pending };
  jobs.add(job);
  reviews.set(projectId, jobs);
  try { return await pending; }
  finally {
    jobs.delete(job);
    if (!jobs.size) reviews.delete(projectId);
  }
}

async function executeRemoval(runtime: Runtime, target: RemovalTarget, scope: string): Promise<RemovalResult> {
  if (removing) throw new Error("Another removal is already in progress.");
  removing = target;
  const detached: { owner: number; projectId: string; sessionId: string }[] = [];
  let result: RemovalResult | undefined;
  try {
    result = await runtime.remove(target, scope, async reopenHarness => {
      if (!target.sessionId) {
        const jobs = [...reviews.get(target.projectId) ?? []];
        for (const job of jobs) job.controller.abort(new Error("Review stopped for workspace removal."));
        await Promise.all([
          terminals.closeProject(target.projectId),
          Promise.allSettled(jobs.map(job => job.pending)),
        ]);
      }
      if (!reopenHarness) return;
      for (const [owner, owned] of watches) {
        for (const [subscriptionId, { projectId, sessionId }] of owned) {
          detached.push({ owner, projectId, sessionId });
          unwatch(owner, subscriptionId);
        }
      }
    });
    return result;
  } finally {
    removing = undefined;
    if (result && !target.sessionId) {
      for (const [owner, watch] of reviewWatches) {
        if (watch.projectId === target.projectId) closeReviewWatch(owner);
      }
    }
    const deleted = new Set(result?.sessionIds);
    for (const { owner, ...selection } of detached) {
      if (!deleted.has(selection.sessionId)) emit(owner, { type: "chat:reset", ...selection });
    }
  }
}

async function handle(request: HostRequest): Promise<unknown> {
  const { owner, windowId = owner, command, payload } = request;
  if (!runtime || !auth || closing || (closedOwners.has(owner) && command !== "owner:close")) throw new Error("The workspace host is closed.");
  if (removing && (command === "chat:watch" || command === "chat:earlier" || command === "chat:image")) {
    throw new Error("The conversation store is finishing a removal.");
  }
  switch (command) {
    case "host:status": {
      const terminalBusy = payload?.checkTerminalWork ? await terminals.hasWorkToInterrupt() : undefined;
      return { active: runtime.hasActiveWork(), activities: runtime.sessionActivities(), terminalBusy };
    }
    case "owner:close":
      return closeOwner(owner, windowId, payload?.preserveQueueEdits);
    case "project:list":
      return runtime.listProjects();
    case "project:add":
      return runtime.addProject(payload.directory);
    case "removal:plan": {
      if (removing) throw new Error("Another removal is already in progress.");
      const { scope, name, directory, sessionCount, blockingBranches } = runtime.removalPlan(payload);
      return { scope, name, directory, sessionCount, blockingBranches };
    }
    case "removal:execute":
      return executeRemoval(runtime, payload, payload.scope);
    case "draft:images-read":
      return runtime.readDraftImages(payload);
    case "draft:images-write":
      requireOpenWorkspace(payload.projectId);
      return runtime.writeDraftImages(payload);
    case "session:list":
      return runtime.listSessions(payload.projectId);
    case "session:watch-activity": {
      activityWatches.get(owner)?.dispose();
      const { subscriptionId } = payload;
      const dispose = runtime.watchSessionActivity(items => emit(owner, { type: "session:activity", subscriptionId, items }));
      activityWatches.set(owner, { id: subscriptionId, dispose });
      return;
    }
    case "session:unwatch-activity": {
      const watch = activityWatches.get(owner);
      if (watch?.id === payload.subscriptionId) {
        watch.dispose();
        activityWatches.delete(owner);
      }
      return;
    }
    case "session:read-activity":
      return runtime.readSessionActivity(payload, payload.taskId);
    case "session:create":
      return runtime.createSession(payload.projectId, payload.title);
    case "session:rename":
      return runtime.renameSession(payload, payload.title);
    case "model:list":
      return runtime.modelCatalog(payload?.useSaved);
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
    case "chat:start":
      return runtime.start(payload);
    case "chat:send":
      return runtime.send(payload);
    case "chat:image":
      return runtime.readChatImage(payload);
    case "chat:queue-read":
      return runtime.readQueuedInput(payload);
    case "chat:queue-edit-start":
      return runtime.startQueueEdit(payload, windowId);
    case "chat:queue-edit-finish":
      return runtime.finishQueueEdit(payload, windowId);
    case "chat:queue-update":
      return runtime.updateQueuedInput(payload);
    case "chat:cancel":
      return runtime.cancel(payload);
    case "chat:continue":
      return runtime.continue(payload);
    case "chat:task-cancel":
      return runtime.cancelTask(payload);
    case "chat:fork":
      return runtime.fork(payload, payload.entryId, payload.title);
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
        }, payload.readingEntryId);
        if (owned.get(subscriptionId) === entry) entry.watch = watch;
        else watch.dispose();
      } catch (error) {
        if (owned.get(subscriptionId) === entry) unwatch(owner, subscriptionId);
        throw error;
      }
      return;
    }
    case "review:list":
      return runReview(runtime, owner, payload.projectId, listChanges);
    case "review:patch":
      return runReview(runtime, owner, payload.projectId, (cwd, signal) => readPatch(cwd, payload.path, signal));
    case "review:resolve-link":
      return runReview(runtime, owner, payload.projectId, (cwd, signal) => resolveMessageFile(cwd, payload.href, signal));
    case "review:file":
      return runReview(runtime, owner, payload.projectId, (cwd, signal) => readMessageFile(cwd, payload.path, signal), payload.requestId);
    case "review:file-cancel": {
      runtime.requireProject(payload.projectId);
      for (const job of reviews.get(payload.projectId) ?? []) {
        if (job.owner === owner && job.requestId === payload.requestId) job.controller.abort(new Error("File preview stopped."));
      }
      return;
    }
    case "review:watch": {
      const { projectId, subscriptionId } = payload;
      requireOpenWorkspace(projectId);
      const project = runtime.requireProject(projectId);
      closeReviewWatch(owner);
      const controller = new AbortController();
      const watch = { projectId, subscriptionId, controller };
      reviewWatches.set(owner, watch);
      try {
        await watchChanges(project.directory, controller.signal,
          () => emit(owner, { type: "review:changed", projectId, subscriptionId }),
          () => {
            if (reviewWatches.get(owner) !== watch) return;
            closeReviewWatch(owner);
            emit(owner, { type: "review:watch-error", projectId, subscriptionId });
          });
      } catch {
        if (reviewWatches.get(owner) === watch) {
          closeReviewWatch(owner);
          throw new Error("Automatic updates are unavailable.");
        }
      }
      return;
    }
    case "review:unwatch": {
      const watch = reviewWatches.get(owner);
      if (watch?.projectId === payload.projectId && watch.subscriptionId === payload.subscriptionId) closeReviewWatch(owner);
      return;
    }
    case "terminal:open": {
      requireOpenWorkspace(payload.projectId);
      const project = runtime.requireProject(payload.projectId);
      return terminals.open(owner, project.id, project.directory, payload.cols, payload.rows);
    }
    case "terminal:input":
      requireOpenWorkspace(payload.projectId);
      return terminals.input(owner, payload.projectId, payload.terminalId, payload.data);
    case "terminal:resize":
      return terminals.resize(owner, payload.projectId, payload.terminalId, payload.cols, payload.rows);
    case "terminal:visibility":
      return terminals.visibility(owner, payload.projectId, payload.terminalId, payload.visible);
    case "terminal:close":
      return terminals.close(owner, payload.projectId, payload.terminalId);
    case "terminal:sync":
      return terminals.sync(owner, payload.projectId, payload.terminalId, payload.through, payload.replay);
  }
}

port.on("message", ({ data }: { data: ToHost }) => {
  if (data.type === "start" && !starting) {
    starting = true;
    const credentials = new PersistentCredentials({}, (provider, credential) => {
      const id = ++nextCredentialRequest;
      const write = Promise.withResolvers<void>();
      credentialWrites.set(id, write);
      send({ type: "credential:write", id, provider, credential });
      return write.promise;
    }, data.hasSavedCredentials ? () => {
      const id = ++nextCredentialRequest;
      const result = Promise.withResolvers<Record<string, Credential>>();
      credentialRead = { id, result };
      send({ type: "credential:read", id });
      return result.promise;
    } : undefined);
    opening = Runtime.open(data.dataDir, {}, undefined, credentials, () => process.exit(1), data.lifetimeId, data.closedWindows,
      data.automationDirectory ? { resourcesDirectory: data.automationDirectory, stateDirectory: join(data.dataDir, "automation") } : undefined);
    void opening.then(opened => {
      runtime = opened;
      if (closing) return;
      auth = new AuthFlows(opened.models, credentials, emit, () => opened.deviceId());
      // Native completion reminders outlive renderer subscriptions and windows.
      let baseline = true;
      opened.watchSessionActivity(items => {
        if (!closing) send({ type: "activity", items: opened.notificationActivities(items), baseline });
        baseline = false;
      });
      send({ type: "ready" });
    }, error => {
      if (!closing) send({ type: "fatal", error: messageOf(error) });
    });
  } else if (data.type === "credential:snapshot") {
    if (credentialRead?.id !== data.id) return;
    const { result } = credentialRead;
    credentialRead = undefined;
    if ("error" in data) result.reject(new Error(data.error));
    else result.resolve(data.credentials);
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
    for (const jobs of reviews.values()) for (const job of jobs) job.controller.abort();
    const owners = new Set([...watches.keys(), ...activityWatches.keys(), ...reviewWatches.keys()]);
    void (async () => {
      const errors: unknown[] = [];
      const settle = async (operations: (() => unknown)[]) => {
        const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      };
      await settle([() => opening]);
      await settle([...owners].map(owner => () => closeOwner(owner, owner, true)));
      await settle([() => terminals.closeAll(), () => auth?.close()]);
      // A failed detach must not prevent the store from flushing/closing. Keep
      // each failure visible to main so an updater never treats it as success.
      await settle([() => runtime?.detachQueueEdits()]);
      await settle([() => runtime?.close()]);
      shutdownReceipt = errors.length ? { error: errors.map(messageOf).join("\n") } : {};
      try { send({ type: "shutdown:complete", ...shutdownReceipt }); }
      catch { process.exit(1); }
    })();
  } else if (data.type === "shutdown:exit" && shutdownReceipt) {
    process.exit(shutdownReceipt.error ? 1 : 0);
  }
});
