import {
  ConversationBusy, ConversationIdle, defineDoc, InboxDoc, LiveDoc, type Conversation, type ConversationId,
  type InboxItem, type InputSubmissionDraft, type LiveState, type SubmissionId, type Tx,
} from "@earendil-works/pi-durable";
import { copyJson } from "@earendil-works/chord";
import type { QueueUpdate } from "../shared/api.js";

type EditIdentity = { id: number; token: string; owner: number; lifetimeId: string };
export type QueueEditState = {
  items: InboxItem[];
  order: number[];
  edit?: EditIdentity & { mode: "steer" | "followUp"; detached?: boolean };
  finished?: EditIdentity;
  resume?: boolean;
};

export const QueueEditDoc = defineDoc<QueueEditState>({
  kind: "pideck.queue-edit", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ items: [], order: [] }),
  checkpointWhen: value => value.items.length === 0,
});

export function queueItems(items: readonly InboxItem[], held?: QueueEditState): InboxItem[] {
  if (!held?.items.length) return [...items];
  const rank = new Map(held.order.map((id, index) => [id, index]));
  return [...items, ...held.items].sort((left, right) =>
    (rank.get(left.id) ?? held.order.length + left.id) - (rank.get(right.id) ?? held.order.length + right.id));
}

function matches(left: EditIdentity | undefined, right: EditIdentity) {
  return left?.id === right.id && left.token === right.token && left.owner === right.owner && left.lifetimeId === right.lifetimeId;
}

function content(item: Exclude<InboxItem, { mode: "write" }>) {
  if (typeof item.content === "string") return { text: item.content, hasImages: false };
  return { text: item.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"),
    hasImages: item.content.some(block => block.type === "image") };
}

function editText(item: Exclude<InboxItem, { mode: "write" }>, text: string) {
  const images = typeof item.content === "string" ? [] : item.content.filter(block => block.type === "image");
  if (!text.trim() && !images.length) throw new Error("Enter a message or keep an attached image.");
  item.content = images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
}

export async function startQueueEdit(tx: Tx, conversationId: ConversationId, identity: EditIdentity) {
  const held = await tx.doc(QueueEditDoc, conversationId);
  if (held.edit) {
    const sameOwner = held.edit.owner === identity.owner && held.edit.lifetimeId === identity.lifetimeId;
    if (held.edit.id !== identity.id || (!held.edit.detached && !sameOwner)) {
      throw new Error("A queued message is already being edited in this session.");
    }
    const item = held.items.find(item => item.id === identity.id);
    if (!item || item.mode === "write") throw new Error("This message is no longer in the queue.");
    if (held.edit.detached) {
      held.edit.owner = identity.owner;
      held.edit.lifetimeId = identity.lifetimeId;
      delete held.edit.detached;
    }
    return { token: held.edit.token, ...content(item) };
  }
  if (matches(held.finished, identity)) throw new Error("This queue edit has already ended.");
  const inbox = await tx.doc(InboxDoc, conversationId);
  const index = inbox.items.findIndex(item => item.id === identity.id && item.mode !== "write");
  const item = inbox.items[index];
  if (!item || item.mode === "write") throw new Error("This message is no longer in the queue.");
  held.edit = { ...identity, mode: item.mode };
  held.order = inbox.items.map(item => item.id);
  held.items = inbox.items.filter((candidate, offset) => (candidate.mode === item.mode && offset >= index)
    || (item.mode === "steer" && candidate.mode === "followUp"));
  const parked = new Set(held.items.map(item => item.id));
  inbox.items = inbox.items.filter(item => !parked.has(item.id));
  delete held.resume;
  return { token: identity.token, ...content(item) };
}

// Release is a document mutation: the original native submissions stay queued,
// with their IDs, request IDs and positions unchanged throughout editing.
async function restoreQueue(tx: Tx, conversationId: ConversationId, held: QueueEditState) {
  const inbox = await tx.doc(InboxDoc, conversationId);
  inbox.items = queueItems(inbox.items, held);
  if (held.edit) held.finished = { ...held.edit };
  delete held.edit;
  held.items = [];
  held.order = [];
  const live = await tx.doc(LiveDoc, conversationId);
  if (!live.run && inbox.items.some(item => item.mode !== "write")) held.resume = true;
  return held.resume === true;
}

export async function advanceReleasedQueue(tx: Tx, conversation: Conversation) {
  const held = await tx.doc(QueueEditDoc, conversation.id);
  if (!held.resume || held.edit) return;
  const live = await tx.doc(LiveDoc, conversation.id);
  const inbox = await tx.doc(InboxDoc, conversation.id);
  delete held.resume;
  if (!live.run && inbox.items.some(item => item.mode !== "write")) await conversation.submit(tx, { type: "continue" });
}

export async function finishQueueEdit(tx: Tx, conversation: Conversation, identity: EditIdentity, text?: string) {
  const held = await tx.doc(QueueEditDoc, conversation.id);
  if (matches(held.finished, identity)) return;
  if (!matches(held.edit, identity) || held.edit?.detached) throw new Error("This queue edit is no longer active in this window.");
  const item = held.items.find(item => item.id === identity.id);
  if (!item || item.mode === "write") throw new Error("This message is no longer in the queue.");
  if (text !== undefined) editText(item, text);
  await restoreQueue(tx, conversation.id, held);
  await advanceReleasedQueue(tx, conversation);
}

// Closing a window ends its exclusive lease, never the edit itself. Keep the
// native submissions parked until the recovered editor explicitly saves/cancels.
export async function detachQueueEdit(tx: Tx, conversationId: ConversationId, owner: number | undefined, lifetimeId: string,
  foreignLifetime = false) {
  const held = await tx.doc(QueueEditDoc, conversationId);
  if (!held.edit || (owner !== undefined && held.edit.owner !== owner)
    || (foreignLifetime ? held.edit.lifetimeId === lifetimeId : held.edit.lifetimeId !== lifetimeId)) return false;
  held.edit.detached = true;
  return true;
}

export async function discardQueueEdit(tx: Tx, conversationId: ConversationId) {
  const held = await tx.doc(QueueEditDoc, conversationId);
  for (const item of held.items) if (item.mode !== "write") {
    tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
  }
  delete held.edit;
  delete held.finished;
  delete held.resume;
  held.items = [];
  held.order = [];
}

export async function submitQueuedInput(tx: Tx, conversation: Conversation, draft: InputSubmissionDraft) {
  const held = await tx.doc(QueueEditDoc, conversation.id);
  if (!held.edit) return conversation.submit(tx, draft);
  const live = await tx.doc(LiveDoc, conversation.id);
  if (draft.whenBusy === "reject" && live.run) throw new ConversationBusy(conversation.id);
  if (draft.whenIdle === "reject" && !live.run) throw new ConversationIdle(conversation.id);
  if (draft.requestId) {
    const previous = await tx.submissionByRequest(conversation.id, draft.requestId);
    if (previous) return previous.id;
  }
  held.order = queueItems((await tx.doc(InboxDoc, conversation.id)).items, held).map(item => item.id);
  const mode = draft.whenBusy === "steer" ? "steer" : "followUp";
  if (mode === "steer" && held.edit.mode === "followUp") {
    const id = await conversation.submit(tx, draft);
    held.order.push(id);
    return id;
  }
  const record = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued",
    ...(draft.requestId ? { requestId: draft.requestId } : {}) });
  held.items.push({ id: record.id, mode,
    content: copyJson(draft.content, { omitUndefinedProperties: true }) as Exclude<InboxItem, { mode: "write" }>["content"],
    ...(draft.entry ? { entry: copyJson(draft.entry, { omitUndefinedProperties: true }) as Exclude<InboxItem, { mode: "write" }>["entry"] } : {}) });
  held.order.push(record.id);
  return record.id;
}

export function canSteerQueued(live: Pick<LiveState, "run"> | undefined): boolean {
  return live?.run !== undefined && live.run.afterRun === undefined;
}

async function queuedInput(tx: Tx, conversationId: ConversationId, id: number) {
  const inbox = await tx.doc(InboxDoc, conversationId);
  const held = await tx.doc(QueueEditDoc, conversationId);
  const items = held.edit ? queueItems(inbox.items, held) : inbox.items;
  const index = items.findIndex(item => item.id === id && item.mode !== "write");
  const item = items[index];
  if (!item || item.mode === "write") throw new Error("This message is no longer in the queue.");
  return { items, index, item };
}

export async function readQueuedInput(tx: Tx, conversationId: ConversationId, id: number) {
  const { item } = await queuedInput(tx, conversationId, id);
  return content(item);
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
  if ((await tx.doc(QueueEditDoc, conversationId)).edit) throw new Error("Finish editing the queued message first.");
  const { items, index, item } = await queuedInput(tx, conversationId, id);
  switch (update.action) {
    case "remove":
      // Match Durable's native withdrawal, scoped to an input in this inbox.
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
      items.splice(index, 1);
      return;
    case "edit": {
      editText(item, update.text);
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
