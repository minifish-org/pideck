import type { Command, Commands, Thinking } from "../shared/api";
import { normalizeSessionTitle, sessionTitleLimit } from "../shared/session-title";
import { externalMessageUrl } from "../shared/message-links";

const thinking = new Set<Thinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const provider = /^[a-z0-9][a-z0-9-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && !value.includes("\0");
}

function match(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

function integer(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function empty(value: unknown): boolean {
  return value === undefined;
}

function project(value: Record<string, unknown>): boolean {
  return match(value.projectId, id);
}

function selection(value: Record<string, unknown>): boolean {
  return project(value) && match(value.sessionId, id);
}

function size(value: Record<string, unknown>): boolean {
  return integer(value.cols, 2, 500) && integer(value.rows, 1, 300);
}

function terminal(value: Record<string, unknown>): boolean {
  return project(value) && match(value.terminalId, id);
}

function flow(value: Record<string, unknown>): boolean {
  return match(value.flowId, id);
}

function entry(value: unknown, min = 1): boolean {
  return integer(value, min, Number.MAX_SAFE_INTEGER);
}

function images(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 4) return false;
  let total = 0;
  for (const image of value) {
    if (!object(image) || typeof image.mimeType !== "string" || !imageTypes.has(image.mimeType)
      || typeof image.data !== "string" || !image.data.length || image.data.length % 4 !== 0) return false;
    total += image.data.length;
    if (total > 12_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return false;
  }
  return true;
}

function chatInput(value: Record<string, unknown>): boolean {
  return string(value.text, 200_000) && object(value.model) && match(value.model.provider, provider)
    && string(value.model.id, 240) && value.model.id.length > 0
    && thinking.has(value.thinking as Thinking) && images(value.images)
    && Boolean(value.text.trim() || (Array.isArray(value.images) && value.images.length));
}

const validators = {
  "desktop:ready": empty,
  "desktop:context": (value) => object(value) && typeof value.viewing === "boolean"
    && (value.projectId === undefined ? value.sessionId === undefined
      : project(value) && (value.sessionId === undefined || match(value.sessionId, id))),
  "appearance:get": empty,
  "clipboard:write": (value) => object(value) && string(value.text, 2_000_000),
  "link:open-external": (value) => object(value) && typeof value.url === "string" && Boolean(externalMessageUrl(value.url)),
  "project:list": empty,
  "project:open": empty,
  "project:remove": (value) => object(value) && project(value),
  "session:list": (value) => object(value) && project(value),
  "session:watch-activity": (value) => object(value) && match(value.subscriptionId, id),
  "session:unwatch-activity": (value) => object(value) && match(value.subscriptionId, id),
  "session:read-activity": (value) => object(value) && selection(value) && entry(value.taskId),
  "session:create": (value) => object(value) && project(value)
    && (value.title === undefined || string(value.title, sessionTitleLimit)),
  "session:rename": (value) => object(value) && selection(value)
    && string(value.title, sessionTitleLimit) && Boolean(normalizeSessionTitle(value.title)),
  "session:remove": (value) => object(value) && selection(value),
  "model:list": (value) => value === undefined || (object(value) && value.useSaved === true),
  "model:providers": empty,
  "model:login": (value) => object(value) && flow(value) && match(value.provider, provider)
    && (value.method === "api_key" || value.method === "oauth"),
  "model:logout": (value) => object(value) && match(value.provider, provider),
  "model:refresh": (value) => object(value) && (value.provider === undefined || match(value.provider, provider)),
  "model:auth-answer": (value) => object(value) && flow(value)
    && match(value.promptId, id) && string(value.value, 16_384),
  "model:auth-cancel": (value) => object(value) && flow(value),
  "model:auth-open": (value) => object(value) && flow(value) && match(value.linkId, id),
  "model:auth-copy": (value) => object(value) && flow(value) && match(value.copyId, id),
  "chat:watch": (value) => object(value) && selection(value) && match(value.subscriptionId, id)
    && (value.readingEntryId === undefined || entry(value.readingEntryId)),
  "chat:unwatch": (value) => object(value) && match(value.subscriptionId, id),
  "chat:earlier": (value) => object(value) && selection(value) && match(value.subscriptionId, id)
    && (value.gap === undefined || (object(value.gap) && entry(value.gap.after, 0) && entry(value.gap.upTo)
      && Number(value.gap.after) < Number(value.gap.upTo))),
  "chat:start": (value) => object(value) && project(value) && chatInput(value)
    && match(value.requestId, id) && value.sessionId === undefined && value.delivery === undefined,
  "chat:send": (value) => object(value) && selection(value) && chatInput(value)
    && (value.requestId === undefined || match(value.requestId, id))
    && (value.delivery === undefined || value.delivery === "send" || value.delivery === "follow-up" || value.delivery === "steer"),
  "chat:queue-read": (value) => object(value) && selection(value) && entry(value.id),
  "chat:queue-edit-start": (value) => object(value) && selection(value) && entry(value.id) && match(value.token, id),
  "chat:queue-edit-finish": (value) => object(value) && selection(value) && entry(value.id) && match(value.token, id)
    && (value.text === undefined || string(value.text, 200_000)),
  "chat:queue-update": (value) => object(value) && selection(value) && entry(value.id)
    && (value.action === "steer" || value.action === "remove"
      || (value.action === "edit" && string(value.text, 200_000))
      || (value.action === "move" && entry(value.targetId) && value.targetId !== value.id
        && (value.position === "before" || value.position === "after"))),
  "chat:cancel": (value) => object(value) && selection(value),
  "chat:fork": (value) => object(value) && selection(value) && entry(value.entryId)
    && (value.title === undefined || string(value.title, sessionTitleLimit)),
  "review:list": (value) => object(value) && project(value),
  "review:patch": (value) => object(value) && project(value) && string(value.path, 4096) && value.path.length > 0,
  "review:resolve-link": (value) => object(value) && project(value) && string(value.href, 16_384)
    && value.href.length > 0 && !/[\u0000-\u001f\u007f]/.test(value.href),
  "review:file": (value) => object(value) && project(value) && match(value.requestId, id)
    && string(value.path, 4096) && value.path.length > 0 && !/[\u0000-\u001f\u007f]/.test(value.path),
  "review:file-cancel": (value) => object(value) && project(value) && match(value.requestId, id),
  "review:watch": (value) => object(value) && project(value) && match(value.subscriptionId, id),
  "review:unwatch": (value) => object(value) && project(value) && match(value.subscriptionId, id),
  "terminal:open": (value) => object(value) && project(value) && size(value),
  "terminal:input": (value) => object(value) && terminal(value)
    && typeof value.data === "string" && value.data.length <= 65536,
  "terminal:resize": (value) => object(value) && terminal(value) && size(value),
  "terminal:close": (value) => object(value) && terminal(value),
  "terminal:sync": (value) => object(value) && terminal(value) && entry(value.through, 0)
    && (value.replay === undefined || value.replay === true),
} satisfies Record<Command, (value: unknown) => boolean>;

export function isCommand(command: unknown): command is Command {
  return typeof command === "string" && Object.hasOwn(validators, command);
}

export function validPayload<C extends Command>(command: C, value: unknown): value is Commands[C][0] {
  return validators[command](value);
}
