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
  for (const command of ["__proto__", "constructor", "project:add", "owner:close", null]) {
    assert.equal(isCommand(command), false);
  }
  assert.equal(validPayload("project:open", { directory: "/tmp" }), false);
  assert.equal(validPayload("session:list", null), false);
  assert.equal(validPayload("chat:watch", { projectId, sessionId, subscriptionId: "fake" }), false);
  assert.equal(validPayload("review:patch", { projectId, path: "abc\0def" }), false);
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
