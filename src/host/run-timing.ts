import type { Context } from "@earendil-works/chord";
import { GenerationTask, type Conversation, type Cursor, type EntryId, type Harness, type LiveRun } from "@earendil-works/pi-durable";
import { continueEntryKind, inputEntryKind, type CompletedRun } from "./chat-view.js";

const maxRunEntries = 10_000;
type NativeTask = NonNullable<Awaited<ReturnType<Harness["getTask"]>>>;

// Generations hand over to a new task after every tool round. Native input
// settlements, rather than task IDs, identify the complete interaction.
export async function completedRun(harness: Harness,
  task: NativeTask, context: Context, answerEntryId?: EntryId,
): Promise<CompletedRun | undefined> {
  if (task.kind !== GenerationTask.definition.name || task.state.status !== "terminal") return;
  const result = task.state.outcome.status === "completed" ? task.state.outcome.result : undefined;
  const answer = result && typeof result === "object" && "entryId" in result && typeof result.entryId === "number"
    ? result.entryId as EntryId : answerEntryId;
  // An afterRun abort may follow an already committed, settled answer. Native
  // submission settlements still prove that answer; the task end bounds its time.
  return answer === undefined ? undefined : answerTiming(harness, task, answer, context);
}

async function answerTiming(harness: Harness, task: NativeTask, answer: EntryId, context: Context): Promise<CompletedRun | undefined> {
  const conversation = await harness.conversation(task.conversationId, context);
  if (!conversation) return;
  let cursor: Cursor | undefined;
  let count = 0;
  let startedAt: number | undefined;
  let completed = false;
  const completion = (includeDuration = true): CompletedRun | undefined => completed ? {
    entryId: answer,
    ...(includeDuration && startedAt !== undefined ? { startedAt } : {}),
    ...(includeDuration && startedAt !== undefined && task.endedAt !== undefined && Number.isFinite(task.endedAt)
      && task.endedAt >= startedAt ? { durationMs: task.endedAt - startedAt } : {}),
  } : undefined;
  do {
    const page = await conversation.entries({ maxEntryId: answer, order: "descending" },
      Math.min(128, maxRunEntries - count), cursor, context);
    count += page.items.length;
    for (const entry of page.items) {
      if (entry.kind === continueEntryKind) {
        const data = entry.data;
        if (!data || typeof data !== "object" || !("requestId" in data) || typeof data.requestId !== "string") return completion(false);
        const submission = await conversation.commit(tx => tx.submissionByRequest(entry.conversationId, data.requestId as string), context);
        if (submission?.type !== "continue" || submission.status !== "done" || submission.answer !== answer) return completion();
        completed = true;
        if (!("startedAt" in data) || typeof data.startedAt !== "number" || !Number.isFinite(data.startedAt)) return completion(false);
        startedAt = data.startedAt;
        return completion();
      }
      if (entry.kind !== inputEntryKind && entry.kind !== "pi.user") continue;
      const users = entry.model?.filter(message => message.role === "user") ?? [];
      if (!users.length) continue;
      const requestId = entry.data && typeof entry.data === "object" && "requestId" in entry.data
        && typeof entry.data.requestId === "string" ? entry.data.requestId : undefined;
      // Legacy input cannot prove where this interaction began. A matching
      // settlement already found still proves its final answer, without timing.
      if (!requestId) return completion(false);
      const input = await conversation.commit(tx => tx.submissionByRequest(entry.conversationId, requestId), context);
      if (input?.type !== "input" || input.status !== "done" || input.answer !== answer) return completion();
      if (input.entry !== entry.id) return completion(false);
      completed = true;
      const timestamp = Math.min(...users.map(message => message.timestamp));
      if (!Number.isFinite(timestamp)) return completion(false);
      startedAt = timestamp;
    }
    cursor = page.next;
    if (!cursor) return completion();
  } while (count < maxRunEntries);
  // A truncated run would under-report its time. Leave it unknown instead.
  return completion(false);
}

// The first native run input stays first across tool handoffs and steering.
// Its entry timestamp records placement, so a follow-up's queued wait is excluded.
export async function activeRunStartedAt(harness: Harness, conversation: Conversation, run: Pick<LiveRun, "inputs" | "taskId" | "afterRun">, context: Context): Promise<number | undefined> {
  const first = run.inputs[0];
  if (first !== undefined) {
    const submission = await harness.submission(first, context);
    const record = await submission?.status(context);
    if (!record || record.conversationId !== conversation.id || record.status === "queued") return;
    if (record.type === "input") {
      if (record.entry === undefined) return;
      const entryId = record.entry;
      const entry = await conversation.commit(tx => tx.entry(entryId), context);
      const timestamps = entry?.model?.flatMap(message => message.role === "user" ? [message.timestamp] : []) ?? [];
      return timestamps.length && timestamps.every(Number.isFinite) ? Math.min(...timestamps) : undefined;
    }
    if (record.type !== "continue" || !record.requestId) return;
    let cursor: Cursor | undefined;
    let count = 0;
    do {
      const page = await conversation.entries({ order: "descending" }, Math.min(128, maxRunEntries - count), cursor, context);
      count += page.items.length;
      for (const entry of page.items) {
        const data = entry.data;
        if (entry.kind === continueEntryKind && data && typeof data === "object" && "requestId" in data
            && data.requestId === record.requestId && "startedAt" in data && typeof data.startedAt === "number" && Number.isFinite(data.startedAt)) {
          return data.startedAt;
        }
      }
      cursor = page.next;
    } while (cursor && count < maxRunEntries);
    return;
  }
  // Native afterRun clears the inputs after settling them. On reconnect, its
  // generation checkpoint names the answer whose native settlements prove start.
  if (!run.afterRun) return;
  const task = await harness.getTask(run.taskId, context);
  if (!task || task.state.status === "terminal" || task.state.status === "completing") return;
  const checkpoint = task.state.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || !("phase" in checkpoint)) return;
  const answer = checkpoint.phase === "drain" && "answer" in checkpoint ? checkpoint.answer
    : checkpoint.phase === "finish" && "run" in checkpoint && checkpoint.run && typeof checkpoint.run === "object" && "answer" in checkpoint.run
      ? checkpoint.run.answer : undefined;
  return typeof answer === "number" ? (await answerTiming(harness, task, answer as EntryId, context))?.startedAt : undefined;
}
