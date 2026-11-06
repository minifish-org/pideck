import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView, LiveState, RunFailure } from "@earendil-works/pi-durable";
import type { ChatBlock, ChatMessage, ChatView } from "../shared/api.js";

type ToolBlock = Extract<ChatBlock, { type: "tool" }>;
const inlineImageBudget = 16_000_000;

function userBlocks(content: UserMessage["content"]): ChatBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(block => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", mimeType: block.mimeType, data: block.data });
}

function assistantBlocks(message: AssistantMessage, tools?: Map<string, ToolBlock>): ChatBlock[] {
  return message.content.map(block => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") return { type: "thinking", text: block.thinking };
    const status = message.stopReason === "aborted" || message.stopReason === "error" ? "error" : "pending";
    const tool: ToolBlock = { type: "tool", id: block.id, name: block.name, arguments: block.arguments, status };
    if (typeof block.arguments?.path === "string") tool.path = block.arguments.path;
    tools?.set(block.id, tool);
    return tool;
  });
}

function applyToolResult(tool: ToolBlock, result: ToolResultMessage): void {
  tool.status = result.isError ? "error" : "done";
  tool.output = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  const images = result.content.flatMap(block => block.type === "image"
    ? [{ mimeType: block.mimeType, data: block.data }]
    : []);
  if (images.length) tool.images = images;
  if (tool.name === "edit" && result.details && typeof result.details === "object"
      && "patch" in result.details && typeof result.details.patch === "string") {
    tool.patch = result.details.patch;
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
  // Watch updates carry complete views across IPC. Prioritize recent images and
  // keep the aggregate payload bounded without altering Durable's transcript.
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

// The projection is rebuilt from a Durable watch value, including live tool slots
// and partial text. It never owns transcript or task state.
export function projectChatView(view: ConversationView): ChatView {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, ToolBlock>();
  const live = view.docs["pi.live"] as LiveState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;

  for (const entry of view.entries) {
    if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") continue;
    for (const [index, message] of (entry.model ?? []).entries()) {
      const id = `${entry.id}:${index}`;
      if (message.role === "user") {
        messages.push({ id, role: "user", blocks: userBlocks(message.content) });
      } else if (message.role === "assistant") {
        const blocks = assistantBlocks(message, tools);
        if (blocks.length) messages.push({ id, role: "assistant", blocks });
      } else if (message.role === "toolResult") {
        let tool = tools.get(message.toolCallId);
        if (!tool) {
          // The corresponding call may have fallen outside the transcript window.
          tool = { type: "tool", id: message.toolCallId, name: message.toolName, status: "pending" };
          tools.set(message.toolCallId, tool);
          messages.push({ id, role: "assistant", blocks: [tool] });
        }
        applyToolResult(tool, message);
      }
    }
  }

  for (const slot of live?.tools ?? []) {
    let tool = tools.get(slot.callId);
    if (!tool) {
      tool = { type: "tool", id: slot.callId, name: slot.name, status: "pending" };
      messages.push({ id: `live-tool:${slot.callId}`, role: "assistant", blocks: [tool] });
    }
    if (tool.status === "done" || tool.status === "error") continue;
    tool.status = slot.status;
    if (slot.output !== undefined) tool.output = slot.output;
  }

  const partial = live?.generation?.message;
  if (partial) {
    const blocks = assistantBlocks(partial);
    if (blocks.length) messages.push({ id: "live-assistant", role: "assistant", blocks });
  }

  limitInlineImages(messages);
  return {
    messages,
    status: live?.run ? "running" : "idle",
    ...(agent?.model ? { model: { provider: agent.model.provider, id: agent.model.modelId } } : {}),
    ...(agent?.thinkingLevel ? { thinking: agent.thinkingLevel } : {}),
    ...(live?.runFailure ? { error: failureMessage(live.runFailure) } : {}),
  };
}
