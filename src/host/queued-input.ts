import {
  InboxDoc, LiveDoc, type ConversationId, type InboxItem, type LiveState, type SubmissionId, type Tx,
} from "@earendil-works/pi-durable";
import type { QueueUpdate } from "../shared/api.js";

export function canSteerQueued(live: Pick<LiveState, "run"> | undefined): boolean {
  return live?.run !== undefined && live.run.afterRun === undefined;
}

async function queuedInput(tx: Tx, conversationId: ConversationId, id: number) {
  const { items } = await tx.doc(InboxDoc, conversationId);
  const index = items.findIndex(item => item.id === id && item.mode !== "write");
  const item = items[index];
  if (!item || item.mode === "write") throw new Error("This message is no longer in the queue.");
  return { items, index, item };
}

export async function readQueuedInput(tx: Tx, conversationId: ConversationId, id: number) {
  const { item } = await queuedInput(tx, conversationId, id);
  if (typeof item.content === "string") return { text: item.content, hasImages: false };
  return {
    text: item.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"),
    hasImages: item.content.some(block => block.type === "image"),
  };
}

// The boundary selects from the native inbox by position. Reorder the indicated
// inputs in those slots so queued writes and other input classes keep their slots.
function orderInputs(items: InboxItem[], order: SubmissionId[]) {
  const selected = new Set(order);
  let offset = 0;
  const rank = new Map(items.map(({ id }, index) => [selected.has(id) ? order[offset++]! : id, index]));
  items.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}

export async function updateQueuedInput(tx: Tx, conversationId: ConversationId, id: number, update: QueueUpdate): Promise<void> {
  const { items, index, item } = await queuedInput(tx, conversationId, id);
  switch (update.action) {
    case "remove":
      // Match Durable's native withdrawal, scoped to an input in this inbox.
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
      items.splice(index, 1);
      return;
    case "edit": {
      const images = typeof item.content === "string" ? [] : item.content.filter(block => block.type === "image");
      if (!update.text.trim() && !images.length) throw new Error("Enter a message or keep an attached image.");
      item.content = images.length
        ? [...(update.text ? [{ type: "text" as const, text: update.text }] : []), ...images]
        : update.text;
      return;
    }
    case "move": {
      if (update.targetId === item.id) return;
      const peers = items.filter(peer => peer.mode === item.mode && peer.id !== item.id).map(peer => peer.id);
      const target = peers.findIndex(peer => peer === update.targetId);
      if (target < 0) throw new Error("The other message is no longer in this part of the queue.");
      peers.splice(target + (update.position === "after" ? 1 : 0), 0, item.id);
      orderInputs(items, peers);
      return;
    }
    case "steer": {
      if (item.mode === "steer") return;
      const live = await tx.doc(LiveDoc, conversationId);
      if (!canSteerQueued(live)) throw new Error("There is no current task to steer.");
      const steers = items.filter(peer => peer.mode === "steer").map(peer => peer.id);
      const followUps = items.filter(peer => peer.mode === "followUp" && peer.id !== item.id).map(peer => peer.id);
      item.mode = "steer";
      orderInputs(items, [...steers, item.id, ...followUps]);
      return;
    }
  }
}
