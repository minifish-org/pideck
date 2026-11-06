import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentState, InboxState, LiveState, RunFailure, TranscriptView } from "@earendil-works/pi-durable";
import type { ChatBlock, ChatGap, ChatMessage, ChatView } from "../shared/api.js";
import { canSteerQueued } from "./queued-input.js";

export const inputEntryKind = "pideck.input";

type ToolBlock = Extract<ChatBlock, { type: "tool" }>;
type ToolPosition = { message: number; block: number };
const inlineImageBudget = 16_000_000;
const inlinePatchLimit = 512_000;

function userBlocks(content: UserMessage["content"]): ChatBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(block => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", mimeType: block.mimeType, data: block.data });
}

function assistantBlocks(message: AssistantMessage): ChatBlock[] {
  return message.content.map(block => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") return { type: "thinking", text: block.thinking };
    const { command, path } = block.arguments ?? {};
    const status = message.stopReason === "toolUse" || message.stopReason === "pending" ? "pending" : "error";
    return {
      type: "tool", id: block.id, name: block.name, status,
      ...(typeof command === "string" ? { arguments: { command } } : {}),
      ...(typeof path === "string" ? { path } : {}),
    };
  });
}

function applyToolResult(tool: ToolBlock, result: ToolResultMessage): void {
  tool.status = result.isError ? "error" : "done";
  tool.output = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  const images = result.content.flatMap(block => block.type === "image"
    ? [{ mimeType: block.mimeType, data: block.data }]
    : []);
  if (images.length) tool.images = images;
  if ((tool.name === "edit" || tool.name === "write") && result.details && typeof result.details === "object"
      && "patch" in result.details && typeof result.details.patch === "string") {
    if (result.details.patch.length <= inlinePatchLimit) tool.patch = result.details.patch;
    else tool.output += "\nPatch is too large to display in chat. Open the file in review.";
  }
}

function failureMessage(failure: RunFailure): string {
  switch (failure.reason) {
    case "aborted": return "Run stopped.";
    case "model_error": return "The model request failed. Check your provider credentials, connectivity, and model access.";
    case "no_model": return "The selected model is unavailable.";
    case "interrupted":
    case "restart_limit": return "The run stopped after repeated interruptions.";
    case "turn_limit": return "The run reached its tool round limit.";
    case "nothing_to_answer": return "There is no input for the model to answer.";
    case "reset": return "The conversation context was reset.";
    default: return "The agent run ended unexpectedly.";
  }
}

function limitInlineImages(messages: ChatMessage[]): void {
  // A fresh watch can attach after many image-heavy turns. Keep its projection
  // bounded while Durable retains the original images in the transcript.
  let remaining = inlineImageBudget;
  const fits = (image: { data: string }) => {
    if (image.data.length > remaining) return false;
    remaining -= image.data.length;
    return true;
  };
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const { blocks } = messages[messageIndex];
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (block.type === "image" && !fits(block)) {
        blocks[index] = { type: "text", text: "[Earlier image omitted from this view.]" };
      }
      if (block.type === "tool" && block.images) {
        const images = block.images.filter(fits);
        if (images.length !== block.images.length) {
          block.output = [block.output, "[Earlier image output omitted from this view.]"].filter(Boolean).join("\n");
          block.images = images;
        }
      }
    }
  }
}

function inputRequestId(data: unknown): string | undefined {
  if (data && typeof data === "object" && "requestId" in data && typeof data.requestId === "string") return data.requestId;
  return undefined;
}

function projectTranscript(items: TranscriptView["items"], forkAt: number | undefined) {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, ToolPosition>();
  const gaps: ChatGap[] = [];
  let firstUnplacedGap = 0;
  function push(message: ChatMessage) {
    for (const gap of gaps.slice(firstUnplacedGap)) gap.beforeMessageId = message.id;
    firstUnplacedGap = gaps.length;
    messages.push(message);
  }

  for (const item of items) {
    if (item.kind === "gap") {
      gaps.push({ after: item.after, upTo: item.upTo });
      continue;
    }
    if (item.kind !== "entry") continue;
    const { entry } = item;
    if (entry.kind !== "pi.user" && entry.kind !== inputEntryKind
        && entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") continue;
    for (const [index, message] of (entry.model ?? []).entries()) {
      const id = `${entry.id}:${index}`;
      if (message.role === "user") {
        const requestId = entry.kind === inputEntryKind ? inputRequestId(entry.data) : undefined;
        push({ id, entryId: entry.id, role: "user", blocks: userBlocks(message.content), ...(requestId ? { requestId } : {}) });
      } else if (message.role === "assistant") {
        const blocks = assistantBlocks(message);
        const error = message.stopReason === "length" ? "The model reached its output limit."
          : message.stopReason === "aborted" ? "This response was interrupted." : undefined;
        if (!blocks.length && !error) continue;
        for (const [block, value] of blocks.entries()) {
          if (value.type === "tool") tools.set(value.id, { message: messages.length, block });
        }
        // Upstream permits fork after any visible entry. If a provider response
        // was interrupted before becoming usable, offer the preceding entries.
        push({
          id, role: "assistant", blocks,
          ...(message.stopReason === "error" || message.stopReason === "aborted" ? {} : { entryId: entry.id }),
          ...(error ? { error } : {}),
        });
      } else if (message.role === "toolResult") {
        const position = tools.get(message.toolCallId);
        const matching = position && messages[position.message]?.blocks[position.block];
        if (matching?.type === "tool") {
          applyToolResult(matching, message);
        } else {
          const tool: ToolBlock = { type: "tool", id: message.toolCallId, name: message.toolName, status: "pending" };
          applyToolResult(tool, message);
          push({ id, role: "assistant", blocks: [tool] });
        }
      }
    }
  }

  if (forkAt !== undefined && !gaps.length) {
    for (const position of tools.values()) {
      const message = messages[position.message];
      const tool = message.blocks[position.block];
      if (message.entryId !== undefined && message.entryId <= forkAt && tool.type === "tool" && tool.status === "pending") {
        tool.status = "error";
        tool.output = "Tool result unavailable in this fork.";
      }
    }
  }
  limitInlineImages(messages);
  return { messages, tools, gaps, hasEarlier: items[0]?.kind === "earlier" };
}

function liveActivity(live: LiveState | undefined): ChatView["activity"] {
  if (live?.compactions?.length) return { kind: "compacting" };
  if (live?.generation?.retry) return { kind: "retrying", retryAt: live.generation.retry.at };
  if (live?.generation?.deferred) return { kind: "waiting", retryAt: live.generation.deferred.pollAt };
  return undefined;
}

function queuedInputs(inbox: InboxState | undefined): ChatView["queued"] {
  if (!inbox?.items.length) return undefined;
  return inbox.items.flatMap(item => {
    if (item.mode === "write") return [];
    const preview = (typeof item.content === "string" ? item.content
      : item.content.flatMap(block => block.type === "text" ? [block.text] : []).join(" ")).trim();
    const requestId = inputRequestId(item.entry?.data);
    return [{
      id: item.id,
      delivery: item.mode === "steer" ? "steer" as const : "follow-up" as const,
      preview: preview.length > 200 ? preview.slice(0, 199) + "…" : preview || "Attached image",
      ...(requestId ? { requestId } : {}),
    }];
  });
}

// This cache belongs to one watch. Durable's transcript helper owns the
// loaded history. Immutable committed rows are reused during live deltas.
export function chatProjection() {
  let items: TranscriptView["items"] | undefined;
  let committed: ReturnType<typeof projectTranscript>;
  return (view: TranscriptView): ChatView => {
    if (items !== view.items) {
      items = view.items;
      committed = projectTranscript(items, view.conversation.parent?.at);
    }
    const { hasEarlier, gaps, tools } = committed;
    const messages = committed.messages.slice();
    const live = view.docs["pi.live"] as LiveState | undefined;
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    const inbox = view.docs["pi.inbox"] as InboxState | undefined;
    const activity = liveActivity(live);
    const queued = queuedInputs(inbox);

    for (const slot of live?.tools ?? []) {
      const position = tools.get(slot.callId);
      const existing = position && messages[position.message].blocks[position.block];
      if (existing?.type === "tool" && (existing.status === "done" || existing.status === "error")) continue;
      const tool: ToolBlock = {
        ...(existing?.type === "tool" ? existing : { type: "tool", id: slot.callId, name: slot.name }),
        status: slot.unoffered || (slot.status === "done" && slot.entry === undefined) ? "error" : slot.status,
      };
      if (slot.output !== undefined) {
        tool.output = slot.droppedBytes || slot.droppedLines
          ? "[Earlier tool output omitted.]\n" + slot.output : slot.output;
      }
      if (position) {
        const row = messages[position.message];
        const blocks = row.blocks.slice();
        blocks[position.block] = tool;
        messages[position.message] = { ...row, blocks };
      } else {
        messages.push({ id: `live-tool:${slot.callId}`, role: "assistant", blocks: [tool] });
      }
    }

    const partial = live?.generation?.message;
    if (partial) {
      const blocks = assistantBlocks(partial);
      if (blocks.length) messages.push({ id: "live-assistant", role: "assistant", blocks });
    }

    return {
      messages,
      status: live?.run || activity?.kind === "compacting" ? "running" : "idle",
      ...(hasEarlier ? { hasEarlier: true } : {}),
      ...(gaps.length ? { gaps } : {}),
      ...(queued?.length ? { queued } : {}),
      ...(queued?.length && canSteerQueued(live) ? { canSteerQueued: true } : {}),
      ...(activity ? { activity } : {}),
      ...(agent?.model ? { model: { provider: agent.model.provider, id: agent.model.modelId } } : {}),
      ...(agent?.thinkingLevel ? { thinking: agent.thinkingLevel } : {}),
      ...(live?.runFailure ? { error: failureMessage(live.runFailure) }
        : live?.compactionFailure ? { error: "The model could not compact the conversation." } : {}),
    };
  };
}
