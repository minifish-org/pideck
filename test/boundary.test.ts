import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { shellEnvironment } from "../src/host/shell-env";
import { isCommand, validPayload } from "../src/main/validation";

const projectId = randomUUID();
const sessionId = randomUUID();
const terminalId = randomUUID();

test("desktop readiness and context accept only scoped selection identifiers", () => {
  assert.equal(validPayload("desktop:ready", undefined), true);
  assert.equal(validPayload("desktop:ready", { directory: "/tmp" }), false);
  assert.equal(validPayload("desktop:context", { viewing: false }), true);
  assert.equal(validPayload("desktop:context", { projectId, sessionId, viewing: true }), true);
  for (const input of [undefined, {}, { projectId, viewing: "yes" }, { sessionId, viewing: true },
    { projectId: "../project", sessionId, viewing: true }]) {
    assert.equal(validPayload("desktop:context", input), false);
  }
  assert.equal(isCommand("host:status"), false);
});

test("appearance snapshots accept only empty renderer requests", () => {
  assert.equal(isCommand("appearance:get"), true);
  assert.equal(validPayload("appearance:get", undefined), true);
  assert.equal(validPayload("appearance:get", {}), false);
  assert.equal(validPayload("appearance:get", { preference: "light" }), false);
  assert.equal(isCommand("appearance:set"), false);
});

test("clipboard writes accept bounded plain text and reject malformed native input", () => {
  assert.equal(isCommand("clipboard:write"), true);
  assert.equal(validPayload("clipboard:write", { text: "A message\nwith code and 中文." }), true);
  for (const input of [undefined, null, "text", {}, { text: 4 }, { text: "bad\0text" }, { text: "x".repeat(2_000_001) }]) {
    assert.equal(validPayload("clipboard:write", input), false);
  }
});

test("IPC rejects unknown commands and malformed payloads", () => {
  assert.equal(isCommand("terminal:open"), true);
  for (const command of ["__proto__", "constructor", "project:trust", "project:inspect", "project:add", "owner:close", null]) {
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

test("run controls require a scoped session, idempotent continue key, and bounded task identity", () => {
  const selection = { projectId, sessionId };
  const requestId = randomUUID();
  assert.equal(isCommand("chat:continue"), true);
  assert.equal(isCommand("chat:task-cancel"), true);
  assert.equal(isCommand("chat:pause"), false);
  assert.equal(validPayload("chat:continue", { ...selection, requestId }), true);
  const model = { provider: "openai", id: "replacement-model" };
  assert.equal(validPayload("chat:continue", { ...selection, requestId, model, thinking: "high" }), true);
  assert.equal(validPayload("chat:continue", { ...selection, requestId, model }), false);
  assert.equal(validPayload("chat:continue", { ...selection, requestId, thinking: "high" }), false);
  assert.equal(validPayload("chat:continue", { ...selection, requestId, model, thinking: "extreme" }), false);
  assert.equal(validPayload("chat:task-cancel", { ...selection, taskId: 42 }), true);
  for (const scoped of [{}, { projectId }, { ...selection, projectId: "../project" }, { ...selection, sessionId: 42 }]) {
    assert.equal(validPayload("chat:continue", { ...scoped, requestId }), false);
    assert.equal(validPayload("chat:task-cancel", { ...scoped, taskId: 42 }), false);
  }
  for (const key of [undefined, "", 42, "request\0id", "../request"]) {
    assert.equal(validPayload("chat:continue", { ...selection, requestId: key }), false);
  }
  for (const taskId of [undefined, "42", 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validPayload("chat:task-cancel", { ...selection, taskId }), false);
  }
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
