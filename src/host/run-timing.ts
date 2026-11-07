import type { Context } from "@earendil-works/chord";
import { GenerationTask, type Cursor, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { inputEntryKind, type CompletedRunTiming } from "./chat-view.js";

const maxRunEntries = 10_000;

// Generations hand over to a new task after every tool round. Native input
// settlements, rather than task IDs, identify the complete interaction.
export async function completedRunTiming(harness: Harness,
  task: NonNullable<Awaited<ReturnType<Harness["getTask"]>>>, context: Context,
): Promise<CompletedRunTiming | undefined> {
  if (task.kind !== GenerationTask.definition.name || task.state.status !== "terminal"
      || task.state.outcome.status !== "completed" || task.endedAt === undefined || !Number.isFinite(task.endedAt)) return;
  const result = task.state.outcome.result;
  if (!result || typeof result !== "object" || !("entryId" in result) || typeof result.entryId !== "number") return;
  const conversation = await harness.conversation(task.conversationId, context);
  if (!conversation) return;
  const answer = result.entryId as EntryId;
  let cursor: Cursor | undefined;
  let count = 0;
  let startedAt: number | undefined;
  const timing = () => startedAt !== undefined && task.endedAt! >= startedAt
    ? { entryId: answer, durationMs: task.endedAt! - startedAt } : undefined;
  do {
    const page = await conversation.entries({ maxEntryId: answer, order: "descending" },
      Math.min(128, maxRunEntries - count), cursor, context);
    count += page.items.length;
    for (const entry of page.items) {
      if (entry.kind !== inputEntryKind && entry.kind !== "pi.user") continue;
      const users = entry.model?.filter(message => message.role === "user") ?? [];
      if (!users.length) continue;
      const requestId = entry.data && typeof entry.data === "object" && "requestId" in entry.data
        && typeof entry.data.requestId === "string" ? entry.data.requestId : undefined;
      // Legacy input without its native submission key cannot prove a boundary.
      if (!requestId) return;
      const input = await conversation.commit(tx => tx.submissionByRequest(entry.conversationId, requestId), context);
      if (input?.type !== "input" || input.status !== "done" || input.answer !== answer) return timing();
      if (input.entry !== entry.id) return;
      const timestamp = Math.min(...users.map(message => message.timestamp));
      if (!Number.isFinite(timestamp)) return;
      startedAt = timestamp;
    }
    cursor = page.next;
    if (!cursor) return timing();
  } while (count < maxRunEntries);
  // A truncated run would under-report its time. Leave it unknown instead.
  return undefined;
}
