import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { shellEnvironment } from "../src/host/shell-env";
import { isCommand, validPayload } from "../src/main/validation";

const projectId = randomUUID();
const sessionId = randomUUID();
const terminalId = randomUUID();

test("IPC rejects unknown commands and malformed payloads", () => {
  assert.equal(isCommand("terminal:open"), true);
  for (const command of ["__proto__", "constructor", "project:inspect", "project:add", "owner:close", null]) {
    assert.equal(isCommand(command), false);
  }
  assert.equal(validPayload("project:open", { directory: "/tmp" }), false);
  assert.equal(isCommand("removal:execute"), false);
  assert.equal(validPayload("project:remove", { projectId: "invalid" }), false);
  assert.equal(validPayload("session:remove", { projectId }), false);
  assert.equal(validPayload("session:remove", { projectId, sessionId }), true);
  assert.equal(validPayload("session:rename", { projectId, sessionId, title: "Review search" }), true);
  assert.equal(validPayload("session:rename", { projectId, sessionId, title: "  \u202e " }), false);
  assert.equal(validPayload("session:rename", { projectId, sessionId, title: "x".repeat(121) }), false);
  assert.equal(validPayload("session:list", null), false);
  assert.equal(validPayload("chat:watch", { projectId, sessionId, subscriptionId: "fake" }), false);
  const watch = { projectId, sessionId, subscriptionId: randomUUID() };
  assert.equal(validPayload("chat:watch", { ...watch, readingEntryId: 42 }), true);
  assert.equal(validPayload("chat:watch", { ...watch, readingEntryId: -1 }), false);
  assert.equal(validPayload("chat:watch", { ...watch, readingEntryId: "42" }), false);
  assert.equal(validPayload("review:patch", { projectId, path: "abc\0def" }), false);
  assert.equal(validPayload("review:watch", { projectId, subscriptionId: watch.subscriptionId }), true);
  assert.equal(validPayload("review:watch", { projectId: "../project", subscriptionId: watch.subscriptionId }), false);
  assert.equal(validPayload("review:unwatch", { projectId }), false);
  assert.equal(validPayload("terminal:open", { projectId, cols: -1, rows: 20 }), false);
  assert.equal(validPayload("terminal:open", { projectId, cols: 80, rows: 20 }), true);
  assert.equal(validPayload("terminal:input", { projectId, terminalId, data: "\x03" }), true);
});

test("IPC accepts supported thinking and bounded image input", () => {
  const input = { projectId, sessionId, text: "Review the image", model: { provider: "openai", id: "model" }, thinking: "max" };
  assert.equal(validPayload("chat:send", input), true);
  assert.equal(validPayload("chat:send", { ...input, thinking: "extreme" }), false);
  assert.equal(validPayload("chat:send", { ...input, text: "", images: [] }), false);
  assert.equal(validPayload("chat:send", { ...input, images: [{ mimeType: "text/html", data: "AAAA" }] }), false);
  assert.equal(validPayload("chat:send", { ...input, images: [{ mimeType: "image/png", data: "AA?A" }] }), false);
  assert.equal(validPayload("chat:send", { ...input, text: "", images: [{ mimeType: "image/png", data: "AAAA" }] }), true);
  const { sessionId: _session, ...firstInput } = input;
  const first = { ...firstInput, requestId: randomUUID() };
  assert.equal(validPayload("chat:start", first), true);
  assert.equal(validPayload("chat:start", { ...first, requestId: undefined }), false);
  assert.equal(validPayload("chat:start", { ...first, sessionId }), false);
  assert.equal(validPayload("chat:start", { ...first, delivery: "steer" }), false);
  assert.equal(validPayload("chat:start", { ...first, text: " " }), false);
});

test("IPC validates queue item identity, edits, and relative moves", () => {
  const queued = { projectId, sessionId, id: 10 };
  assert.equal(validPayload("chat:queue-read", queued), true);
  assert.equal(validPayload("chat:queue-read", { ...queued, id: 0 }), false);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "steer" }), true);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "remove", sessionId: "invalid" }), false);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "edit", text: "" }), true);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "edit", text: "x".repeat(200_001) }), false);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "move", targetId: 9, position: "before" }), true);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "move", targetId: 10, position: "before" }), false);
  assert.equal(validPayload("chat:queue-update", { ...queued, action: "move", targetId: 9, position: "first" }), false);
});

test("tool and terminal environment drops credentials and shell injection variables", () => {
  const env = shellEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    NODE_OPTIONS: "--require /tmp/malicious",
    BASH_ENV: "/tmp/malicious",
  });
  assert.equal(env.HOME, "/tmp/home");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "BASH_ENV"]) {
    assert.equal(env[key], undefined);
  }
});
