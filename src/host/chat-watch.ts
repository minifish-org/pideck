import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
  ConversationTranscript, GenerationTask,
  type Conversation, type ConversationView, type EntryId, type Harness, type InboxState, type LiveState, type TaskGraph, type TaskId, type TranscriptView,
} from "@earendil-works/pi-durable";
import type { ChatGap, ChatView } from "../shared/api.js";
import { chatProjection, type CompletedRun } from "./chat-view.js";
import { QueueEditDoc, type QueueEditState } from "./queued-input.js";
import { activeRunStartedAt, completedRun } from "./run-timing.js";

const context = BACKGROUND_CONTEXT;

export type ChatWatch = {
  dispose(): void;
  loadEarlier(): Promise<void>;
  fillGap(gap: Pick<ChatGap, "after" | "upTo">): Promise<void>;
};

// One watch owns the native subscriptions, loaded history and projection caches.
// Runtime validates the selection before handing over the upstream conversation.
export async function watchConversation(
  harness: Harness,
  conversation: Conversation,
  emit: (view: ChatView) => void,
  onError?: (message: string) => void,
  readingEntryId?: number,
): Promise<ChatWatch> {
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
